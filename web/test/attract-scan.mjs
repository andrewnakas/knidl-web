/* Watch gGameState while the game runs, and report every transition.
 *
 * This is the tool the boot -> hub -> stage sequence in core-smoke.mjs was
 * derived from (rather than guessed from a wiki), and it is also what backs the
 * claim that KNiDL's idle attract loop never leaves GAME_STATE_TITLE:
 *
 *     node attract-scan.mjs <rom> 24000 idle
 *
 * ran 24,000 frames (~6.7 min) with no input at all and reported gGameState 3
 * throughout, cycling title screen <-> intro story. The player task's sprite
 * animates during it, so "something moved" is not evidence of play.
 *
 *   node attract-scan.mjs <rom> [frames] [tap|hub|idle]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const createGBA = createRequire(import.meta.url)(resolve(here, 'core-node.js'));

const romPath = process.argv[2];
const frames = Number(process.argv[3] || 5000);
const strategy = process.argv[4] || 'tap';

// From the matching build's symbol table (arm-none-eabi-nm build/knidl.elf).
const SYM = {
	gGameState: 0x030023d8,       // u16
	gPrevGameState: 0x03002150,   // u16
	gStageRequest: 0x03002438,    // s8
	gFrameCount: 0x03001ea4,      // vu16
	gCameraFocusPlayer: 0x02007d38, // u8
	gTasks: 0x03002790,           // struct Task[63], stride 144
	gPlayerHealth: 0x02005588,    // s16[]
	gPlayerLives: 0x02007d48,     // s16[]
	gContinueLevel: 0x02005578    // u8
};
const TASK_STRIDE = 144, OFF_PIXELX = 0x48, OFF_PIXELY = 0x4a, OFF_POSX = 0x4c;

const NAME = {
	0: 'RESET', 1: 'BOOT_LOGO', 3: 'TITLE', 4: 'MAIN_MENU', 5: 'HUB',
	6: 'STAGE_START', 7: 'CUTSCENE', 8: 'STAGE', 9: 'BIG_SWITCH_VIEW',
	10: 'GOAL_GAME', 11: 'ENDING', 12: 'CREDITS', 13: 'EXTRA_MODE_TITLE',
	22: 'GAME_OVER'
};

const rom = readFileSync(romPath);
const M = await createGBA();
const api = {
	init: M.cwrap('vj_init', 'number', []),
	loadRom: M.cwrap('vj_load_rom', 'number', ['number', 'number']),
	runFrame: M.cwrap('vj_run_frame', null, []),
	setKeys: M.cwrap('vj_set_keys', null, ['number']),
	opaque: M.cwrap('vj_opaque', null, []),
	meanLuma: M.cwrap('vj_mean_luma', 'number', []),
	r8: M.cwrap('vj_read8', 'number', ['number']),
	r16: M.cwrap('vj_read16', 'number', ['number']),
	r16s: M.cwrap('vj_read16s', 'number', ['number']),
	r32: M.cwrap('vj_read32', 'number', ['number']),
	title: M.cwrap('vj_game_title', 'string', [])
};
const KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };

api.init();
const p = M._malloc(rom.length);
M.HEAPU8.set(rom, p);
api.loadRom(p, rom.length);
M._free(p);
console.log('title="' + api.title() + '" strategy=' + strategy);

const playerTask = () => SYM.gTasks + api.r8(SYM.gCameraFocusPlayer) * TASK_STRIDE;

let prev = -1;
for (let i = 0; i < frames; i++) {
	let keys = 0;
	const gs = api.r16(SYM.gGameState);
	if (strategy === 'idle') {
		keys = 0;
	} else if (strategy === 'tap') {
		// Alternate A and START with gaps: menus need edges, not holds.
		const ph = i % 32;
		if (ph === 0) keys = KEY.A; else if (ph === 16) keys = KEY.START;
	} else if (strategy === 'hub') {
		const ph = i % 32;
		if (gs === 5) keys = (ph < 24 ? KEY.RIGHT : 0) | (ph === 0 ? KEY.A : 0);
		else if (ph === 0) keys = KEY.A; else if (ph === 16) keys = KEY.START;
	}
	api.setKeys(keys);
	api.runFrame();
	const now = api.r16(SYM.gGameState);
	if (now !== prev) {
		const pt = playerTask();
		api.opaque();
		console.log(`f=${String(i).padStart(5)} gGameState=${now} (${NAME[now] || '?'})` +
			` prev=${api.r16(SYM.gPrevGameState)} req=${api.r8(SYM.gStageRequest)}` +
			` focus=${api.r8(SYM.gCameraFocusPlayer)} pixelX=${api.r16s(pt + OFF_PIXELX)}` +
			` pixelY=${api.r16s(pt + OFF_PIXELY)} hp=${api.r16s(SYM.gPlayerHealth)}` +
			` lives=${api.r16s(SYM.gPlayerLives)} lvl=${api.r8(SYM.gContinueLevel)}` +
			` luma=${api.meanLuma().toFixed(1)}`);
		prev = now;
	}
}
api.setKeys(0);
console.log('final gGameState=' + api.r16(SYM.gGameState) + ' frameCount=' + api.r16(SYM.gFrameCount));
