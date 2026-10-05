/* Kirby: Nightmare in Dream Land browser target — mGBA mCore shim.
 *
 * Adapted from the pokeruby agent's shim (same mCore API, same traps).
 *
 * Exposes a tiny C surface to JS. Deliberately has no SDL, no filesystem and no
 * audio device: the page owns the canvas and (only if the user asks) the
 * AudioContext. The ROM arrives as bytes from a <input type=file> and is never
 * written anywhere but linear memory.
 *
 * The vj_read* probes exist so the harness can gate "played" on the GAME'S OWN
 * STATE rather than on a screenshot: left idle, KNiDL loops its title screen
 * and its animated intro story indefinitely, bright and moving the whole time,
 * so neither brightness nor "the picture changed" distinguishes it from play.
 * The addresses the page uses come from the symbol table of the matching build
 * in ../upstream/knidl, never from a wiki.
 */

#include <mgba/core/core.h>
#include <mgba/core/config.h>
#include <mgba/core/log.h>
#include <mgba/gba/core.h>
#include <mgba-util/vfs.h>
#include <mgba-util/audio-buffer.h>
#include <mgba-util/image.h>

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define VID_W 240
#define VID_H 160
/* KNiDL's cartridge is battery-backed SRAM: the ROM carries the save-type
 * string "SRAM_V112" at 0x72E9F8, which is 32 KiB of SRAM -- NOT flash, and not
 * the 128 KiB Ruby/Sapphire use. Oversizing makes mGBA pick the wrong save
 * media, so this is exact, not "big enough". */
#define SAVE_BYTES (32 * 1024)

static struct mCore* core = NULL;
static mColor* vbuf = NULL;

/* The core keeps referencing the ROM VFile for the whole session, so this copy
 * has to outlive vj_load_rom(). Same for the save buffer. */
static uint8_t* rom = NULL;
static size_t romLen = 0;
static struct VFile* romVf = NULL;

static uint8_t* save = NULL;
static struct VFile* saveVf = NULL;

static int16_t* abuf = NULL;   /* interleaved stereo, drained by JS */
static size_t abufFrames = 0;
static unsigned sampleRate = 0;

static uint8_t* state = NULL;
static size_t stateLen = 0;

static int loaded = 0;

/* ---------------------------------------------------------------- lifecycle */

/* mGBA's default logger prints every BIOS SWI and DMA to stdout, which in a
 * browser means thousands of console lines per second and a visible framerate
 * cost. Swallow everything; vj_* return values are the diagnostic surface. */
static void _quietLog(struct mLogger* logger, int category, enum mLogLevel level,
                      const char* format, va_list args) {
	UNUSED(logger);
	UNUSED(category);
	UNUSED(level);
	UNUSED(format);
	UNUSED(args);
}

static struct mLogger quietLogger = { .log = _quietLog, .filter = NULL };

EMSCRIPTEN_KEEPALIVE
int vj_init(void) {
	if (core) {
		return 1;
	}
	mLogSetDefaultLogger(&quietLogger);
	core = GBACoreCreate();
	if (!core) {
		return 0;
	}
	if (!core->init(core)) {
		core->deinit(core);
		core = NULL;
		return 0;
	}
	/* core->config holds hash tables that mCore reads during reset()
	 * (_GBACoreReset -> mCoreConfigGetBoolValue). GBACoreCreate does not
	 * initialise them, so without this reset() walks a garbage table and traps
	 * on an out-of-bounds read. Nothing is loaded from or written to disk --
	 * mCoreConfigLoad is deliberately not called. */
	mCoreConfigInit(&core->config, "knidl-web");
	core->loadConfig(core, &core->config);

	vbuf = calloc(VID_W * VID_H, sizeof(mColor));
	core->setVideoBuffer(core, vbuf, VID_W);
	core->setAudioBufferSize(core, 1024);
	sampleRate = core->audioSampleRate(core);
	abufFrames = 4096;
	abuf = calloc(abufFrames * 2, sizeof(int16_t));
	return 1;
}

/* Takes ownership of nothing: copies, so JS may free its own view. */
EMSCRIPTEN_KEEPALIVE
int vj_load_rom(const uint8_t* data, int size) {
	if (!core || size <= 0) {
		return 0;
	}
	if (loaded) {
		core->unloadROM(core);
		loaded = 0;
	}
	free(rom);
	rom = malloc((size_t) size);
	if (!rom) {
		return 0;
	}
	memcpy(rom, data, (size_t) size);
	romLen = (size_t) size;

	romVf = VFileFromMemory(rom, romLen);
	if (!romVf || !core->loadROM(core, romVf)) {
		return 0;
	}

	if (!save) {
		save = calloc(SAVE_BYTES, 1);
	}
	saveVf = VFileFromMemory(save, SAVE_BYTES);
	core->loadSave(core, saveVf);

	core->reset(core);
	loaded = 1;
	return 1;
}

EMSCRIPTEN_KEEPALIVE
int vj_loaded(void) {
	return loaded;
}

EMSCRIPTEN_KEEPALIVE
void vj_reset(void) {
	if (core && loaded) {
		core->reset(core);
	}
}

/* ------------------------------------------------------------------- frames */

EMSCRIPTEN_KEEPALIVE
void vj_run_frame(void) {
	if (core && loaded) {
		core->runFrame(core);
	}
}

EMSCRIPTEN_KEEPALIVE
mColor* vj_framebuffer(void) {
	return vbuf;
}

EMSCRIPTEN_KEEPALIVE
int vj_width(void) { return VID_W; }

EMSCRIPTEN_KEEPALIVE
int vj_height(void) { return VID_H; }

EMSCRIPTEN_KEEPALIVE
int vj_frame_counter(void) {
	return (core && loaded) ? (int) core->frameCounter(core) : -1;
}

/* mGBA leaves alpha at 0 in some paths; ImageData needs it opaque. Done here
 * rather than in JS so the page can hand the buffer straight to putImageData. */
EMSCRIPTEN_KEEPALIVE
void vj_opaque(void) {
	uint32_t* p = (uint32_t*) vbuf;
	for (int i = 0; i < VID_W * VID_H; ++i) {
		p[i] |= 0xFF000000u;
	}
}

/* -------------------------------------------------------------------- input */

EMSCRIPTEN_KEEPALIVE
void vj_set_keys(int keys) {
	if (core && loaded) {
		core->setKeys(core, (uint32_t) keys);
	}
}

/* -------------------------------------------------------------------- audio */

EMSCRIPTEN_KEEPALIVE
int vj_sample_rate(void) { return (int) sampleRate; }

EMSCRIPTEN_KEEPALIVE
int16_t* vj_audio_buffer(void) { return abuf; }

/* Returns frames (sample pairs) written into vj_audio_buffer(). JS only calls
 * this when the user has unmuted; otherwise the buffer is simply never drained
 * and mGBA's ring overwrites itself, which costs nothing. */
EMSCRIPTEN_KEEPALIVE
int vj_drain_audio(int maxFrames) {
	if (!core || !loaded) {
		return 0;
	}
	if (maxFrames > (int) abufFrames) {
		maxFrames = (int) abufFrames;
	}
	struct mAudioBuffer* ab = core->getAudioBuffer(core);
	if (!ab) {
		return 0;
	}
	size_t got = mAudioBufferRead(ab, abuf, (size_t) maxFrames);
	return (int) got;
}

/* --------------------------------------------------------- in-game save RAM */

EMSCRIPTEN_KEEPALIVE
uint8_t* vj_save_buffer(void) { return save; }

EMSCRIPTEN_KEEPALIVE
int vj_save_size(void) { return SAVE_BYTES; }

/* Cheap change detector so the page can persist only when the cartridge save
 * actually moved, instead of writing 128 KiB to IndexedDB on a timer. */
EMSCRIPTEN_KEEPALIVE
unsigned vj_save_hash(void) {
	if (!save) {
		return 0;
	}
	unsigned h = 2166136261u;
	for (int i = 0; i < SAVE_BYTES; ++i) {
		h = (h ^ save[i]) * 16777619u;
	}
	return h;
}

/* Must be called before vj_load_rom(): mGBA reads the buffer when the save
 * media is attached. */
EMSCRIPTEN_KEEPALIVE
int vj_save_restore(const uint8_t* data, int size) {
	if (!save) {
		save = calloc(SAVE_BYTES, 1);
	}
	if (!data || size <= 0) {
		return 0;
	}
	if (size > SAVE_BYTES) {
		size = SAVE_BYTES;
	}
	memcpy(save, data, (size_t) size);
	return size;
}

/* ------------------------------------------------------------- savestates */

EMSCRIPTEN_KEEPALIVE
int vj_state_size(void) {
	return (core && loaded) ? (int) core->stateSize(core) : 0;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* vj_state_save(void) {
	if (!core || !loaded) {
		return NULL;
	}
	size_t n = core->stateSize(core);
	if (n != stateLen) {
		free(state);
		state = malloc(n);
		stateLen = n;
	}
	if (!core->saveState(core, state)) {
		return NULL;
	}
	return state;
}

EMSCRIPTEN_KEEPALIVE
int vj_state_load(const uint8_t* data, int size) {
	if (!core || !loaded || !data) {
		return 0;
	}
	if ((size_t) size != core->stateSize(core)) {
		return 0;
	}
	return core->loadState(core, data) ? 1 : 0;
}

/* ------------------------------------------------------------------ probes */

/* Mean luma over the frame. The page's self-test uses this to tell "the core is
 * running" from "the core is running and something is actually on screen" —
 * a black frame compiles and ticks just fine. */
EMSCRIPTEN_KEEPALIVE
double vj_mean_luma(void) {
	if (!vbuf) {
		return -1.0;
	}
	const uint8_t* p = (const uint8_t*) vbuf;
	double acc = 0.0;
	for (int i = 0; i < VID_W * VID_H; ++i) {
		acc += 0.2126 * p[i * 4 + 0] + 0.7152 * p[i * 4 + 1] + 0.0722 * p[i * 4 + 2];
	}
	return acc / (VID_W * VID_H);
}

/* FNV-1a of the visible frame, for comparing two frames exactly (savestate
 * round-trip checks). */
EMSCRIPTEN_KEEPALIVE
unsigned vj_frame_hash(void) {
	if (!vbuf) {
		return 0;
	}
	const uint8_t* p = (const uint8_t*) vbuf;
	unsigned h = 2166136261u;
	for (int i = 0; i < VID_W * VID_H * 4; ++i) {
		h = (h ^ p[i]) * 16777619u;
	}
	return h;
}

/* Game title from the cartridge header, so the page can say which ROM it got
 * (and refuse a non-KNiDL one) without JS parsing the header itself.
 * KNiDL (USA) reads back as "AGB KIRBY DX" + "A7KE". */
EMSCRIPTEN_KEEPALIVE
const char* vj_game_title(void) {
	static char title[17];
	memset(title, 0, sizeof(title));
	if (rom && romLen >= 0xB0) {
		memcpy(title, rom + 0xA0, 12);
		memcpy(title + 12, rom + 0xAC, 4);
	}
	return title;
}

EMSCRIPTEN_KEEPALIVE
int vj_rom_revision(void) {
	/* Header byte 0xBC is the version/revision number. KNiDL is rev 0, and
	 * README.md says no other retail revision exists. */
	return (rom && romLen > 0xBC) ? rom[0xBC] : -1;
}

/* ------------------------------------------------- game-state RAM probes */

/* Read the emulated bus. Used ONLY to read the game's own state cells at the
 * addresses the matching build's symbol table gives, which is what lets the
 * test tell real play from the title screen's attract demo. Read-only: there is
 * deliberately no vj_write, so a test can never nudge the game into a state it
 * did not reach by playing. */
EMSCRIPTEN_KEEPALIVE
int vj_read8(unsigned addr) {
	return (core && loaded) ? (int) core->busRead8(core, addr) : -1;
}

EMSCRIPTEN_KEEPALIVE
int vj_read16(unsigned addr) {
	return (core && loaded) ? (int) core->busRead16(core, addr) : -1;
}

EMSCRIPTEN_KEEPALIVE
int vj_read32(unsigned addr) {
	return (core && loaded) ? (int) core->busRead32(core, addr) : -1;
}

/* Sign-extended 16-bit read: struct Task.pixelX/pixelY are s16 and go negative
 * left of / above the room origin. */
EMSCRIPTEN_KEEPALIVE
int vj_read16s(unsigned addr) {
	if (!core || !loaded) {
		return 0;
	}
	return (int) (int16_t) (uint16_t) core->busRead16(core, addr);
}
