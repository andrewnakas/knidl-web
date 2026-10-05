/* Core-level test for knidl, outside the browser.
 *
 * Isolates "does the mGBA shim work" from "does the page work", and -- the part
 * that matters -- gates "played" on the GAME'S OWN STATE rather than on a
 * picture.
 *
 * Measured, not assumed: left alone for 24,000 frames (~6.7 minutes) the game
 * cycles title screen <-> intro story and NEVER leaves gGameState == 3 (TITLE).
 * The player task's sprite animates on 115 of those frames, so a "something is
 * moving, it must be playing" heuristic would be fooled. gGameState == 8
 * (STAGE) is reachable only by actually entering a level.
 *
 * Every address comes from the symbol table of the matching build in
 * ../../upstream/knidl (arm-none-eabi-nm build/knidl.elf). None of it is from a
 * wiki.
 *
 * Audio is never drained and no audio device exists in node, so this is silent
 * by construction.
 *
 *   node core-smoke.mjs <rom path> [frames]
 *   VJ_DUMP=dir node core-smoke.mjs ...   also write PPM frames to look at
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const corePath = resolve(here, 'core-node.js');

const romPath = process.argv[2];
const frames = Number(process.argv[3] || 2400);
if (!romPath) {
	console.error('usage: node core-smoke.mjs <rom> [frames]');
	process.exit(2);
}

/* ---- symbols from the matching build ------------------------------------ */
const SYM = {
	gGameState: 0x030023d8,        // u16   AgbMain's dispatch case
	gPrevGameState: 0x03002150,    // u16
	gStageRequest: 0x03002438,     // s8
	gFrameCount: 0x03001ea4,       // u16
	gCameraFocusPlayer: 0x02007d38, // u8   the player's slot in gTasks
	gTasks: 0x03002790,            // struct Task[63], stride 144
	gPlayerHealth: 0x02005588,     // s16[]
	gPlayerLives: 0x02007d48,      // s16[]
	gContinueLevel: 0x02005578     // u8
};
const TASK_STRIDE = 144, OFF_PIXELX = 0x48, OFF_PIXELY = 0x4a;
const GAME_STATE_TITLE = 3, GAME_STATE_HUB = 5, GAME_STATE_STAGE = 8;
const STATE_NAME = {
	0: 'RESET', 1: 'BOOT_LOGO', 3: 'TITLE', 4: 'MAIN_MENU', 5: 'HUB',
	6: 'STAGE_START', 7: 'CUTSCENE', 8: 'STAGE', 9: 'BIG_SWITCH_VIEW',
	10: 'GOAL_GAME', 11: 'ENDING', 12: 'CREDITS', 13: 'EXTRA_MODE_TITLE', 22: 'GAME_OVER'
};
const KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };

let failures = 0;
function fail(msg) { console.log('FAIL ' + msg); failures++; }
function pass(msg) { console.log('PASS ' + msg); }

const rom = readFileSync(romPath);

async function open(restoreSave) {
	const createGBA = require(corePath);
	const M = await createGBA();
	const num = n => M.cwrap(n, 'number', ['number']);
	const api = {
		init: M.cwrap('vj_init', 'number', []),
		loadRom: M.cwrap('vj_load_rom', 'number', ['number', 'number']),
		runFrame: M.cwrap('vj_run_frame', null, []),
		frameCounter: M.cwrap('vj_frame_counter', 'number', []),
		setKeys: M.cwrap('vj_set_keys', null, ['number']),
		opaque: M.cwrap('vj_opaque', null, []),
		meanLuma: M.cwrap('vj_mean_luma', 'number', []),
		frameHash: M.cwrap('vj_frame_hash', 'number', []),
		width: M.cwrap('vj_width', 'number', []),
		height: M.cwrap('vj_height', 'number', []),
		framebuffer: M.cwrap('vj_framebuffer', 'number', []),
		title: M.cwrap('vj_game_title', 'string', []),
		revision: M.cwrap('vj_rom_revision', 'number', []),
		sampleRate: M.cwrap('vj_sample_rate', 'number', []),
		saveBuffer: M.cwrap('vj_save_buffer', 'number', []),
		saveSize: M.cwrap('vj_save_size', 'number', []),
		saveHash: M.cwrap('vj_save_hash', 'number', []),
		saveRestore: M.cwrap('vj_save_restore', 'number', ['number', 'number']),
		stateSize: M.cwrap('vj_state_size', 'number', []),
		stateSave: M.cwrap('vj_state_save', 'number', []),
		stateLoad: M.cwrap('vj_state_load', 'number', ['number', 'number']),
		r8: num('vj_read8'), r16: num('vj_read16'), r16s: num('vj_read16s')
	};
	if (!api.init()) { throw new Error('vj_init failed'); }
	if (restoreSave) {
		const rp = M._malloc(restoreSave.length);
		M.HEAPU8.set(restoreSave, rp);
		api.saveRestore(rp, restoreSave.length);
		M._free(rp);
	}
	const p = M._malloc(rom.length);
	M.HEAPU8.set(rom, p);
	const ok = api.loadRom(p, rom.length);
	M._free(p);
	if (!ok) { throw new Error('vj_load_rom rejected the file'); }

	const playerTask = () => SYM.gTasks + api.r8(SYM.gCameraFocusPlayer) * TASK_STRIDE;
	return {
		M, api,
		gs: () => api.r16(SYM.gGameState),
		px: () => api.r16s(playerTask() + OFF_PIXELX),
		py: () => api.r16s(playerTask() + OFF_PIXELY),
		hp: () => api.r16s(SYM.gPlayerHealth),
		lives: () => api.r16s(SYM.gPlayerLives),
		saveImage: () => {
			const b = api.saveBuffer(), s = api.saveSize();
			return Uint8Array.from(M.HEAPU8.subarray(b, b + s));
		},
		saveNonZero: () => {
			const b = api.saveBuffer(), s = api.saveSize();
			const u = M.HEAPU8.subarray(b, b + s);
			let n = 0;
			for (let i = 0; i < s; i++) { if (u[i]) { n++; } }
			return n;
		},
		run: (n, keys) => { for (let i = 0; i < n; i++) { api.setKeys(keys | 0); api.runFrame(); } }
	};
}

/* PPM dumps: no PNG encoder needed, and every viewer reads it. Mean luma proves
 * "not black"; these prove the frame is the game and not noise. */
const dumpDir = process.env.VJ_DUMP;
if (dumpDir) { mkdirSync(dumpDir, { recursive: true }); }
function dumpFrame(g, tag) {
	if (!dumpDir) { return; }
	g.api.opaque();
	const W = g.api.width(), H = g.api.height(), fb = g.api.framebuffer();
	const rgba = g.M.HEAPU8.subarray(fb, fb + W * H * 4);
	const px = Buffer.allocUnsafe(W * H * 3);
	for (let i = 0; i < W * H; i++) {
		px[i * 3] = rgba[i * 4]; px[i * 3 + 1] = rgba[i * 4 + 1]; px[i * 3 + 2] = rgba[i * 4 + 2];
	}
	writeFileSync(`${dumpDir}/${tag}.ppm`,
		Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`, 'ascii'), px]));
}

/* ======================================================================== */
console.log('=== 1. core + ROM identity ===');
const g = await open(null);
console.log('sampleRate=' + g.api.sampleRate());
const title = g.api.title();
console.log(`title="${title}" headerRevision=${g.api.revision()} saveMedia=${g.api.saveSize()} bytes`);
if (title.startsWith('AGB KIRBY DX') && title.includes('A7KE')) {
	pass('cartridge header reads back as AGB KIRBY DX / A7KE (USA)');
} else {
	fail(`unexpected cartridge header "${title}"`);
}
if (g.api.revision() === 0) { pass('header revision 0, as README says (no other retail revision exists)'); }
else { fail('header revision ' + g.api.revision() + ', expected 0'); }
if (g.api.saveSize() === 32768) { pass('save media sized 32 KiB, matching the ROM\'s SRAM_V112 string'); }
else { fail('save media is ' + g.api.saveSize() + ' bytes, expected 32768'); }

/* ---- 2. boot -> hub -> stage, watching the game's own state ------------- */
console.log('\n=== 2. boot to a stage, gated on gGameState ===');
const path = [];
let prev = -1;
const noteState = i => {
	const s = g.gs();
	if (s !== prev) { path.push(`f${i}:${s}(${STATE_NAME[s] || '?'})`); prev = s; }
};
/* State-gated, not a blind tap loop. A blind A/START pattern only works if it
 * starts on frame 0: shift it and a START press lands once Kirby is already in
 * the hub, which opens the PAUSE screen. gGameState stays 5 while paused, so
 * the run looks like "still in the hub" while every later input goes to a menu
 * and Kirby never moves. That bit the browser harness; this loop is written the
 * same way so the two agree and neither carries the trap. */
let stable = 0;
for (let i = 0; i < 2400; i++) {
	const s = g.gs();
	const ph = i % 32;
	let bits = 0;
	if (s === 1 || s === 3 || s === 4) {           // boot logo, title, main menu
		bits = ph === 0 ? KEY.A : ph === 16 ? KEY.START : 0;
	} else if (s === 7) {                           // intro cutscene
		bits = ph === 0 ? KEY.A : 0;
	} else if (s === GAME_STATE_HUB) {              // hub: hands off
		if (++stable > 240) { noteState(i); break; }
	}
	g.api.setKeys(bits);
	g.api.runFrame();
	noteState(i);
}
dumpFrame(g, 'a-hub');
if (g.gs() !== GAME_STATE_HUB) { fail('did not reach GAME_STATE_HUB; state path ' + path.join(' -> ')); }
// In the hub Kirby stands on the first stage's door; UP enters it.
for (let i = 0; i < 1800 && g.gs() !== GAME_STATE_STAGE; i++) {
	const ph = i % 60;
	g.api.setKeys(ph < 20 ? KEY.UP : 0);
	g.api.runFrame();
	noteState(1000 + i);
}
console.log('state path: ' + path.join(' -> '));
if (g.gs() === GAME_STATE_STAGE) { pass('reached GAME_STATE_STAGE (8) — inside a level'); }
else { fail('never reached GAME_STATE_STAGE; ended in ' + g.gs()); }

/* Let the room finish loading and the fade complete, then require Kirby to be
 * standing still: a position that is already drifting would make the movement
 * test below meaningless. */
g.run(480, 0);
dumpFrame(g, 'b-stage-idle');
const idleX = g.px(), idleY = g.py();
g.run(60, 0);
if (g.px() === idleX) { pass(`Kirby is at rest before the input test (x=${idleX}, y=${idleY})`); }
else { fail(`Kirby drifted with no input (${idleX} -> ${g.px()}), so a later move proves nothing`); }

/* ---- 3. movement under our input --------------------------------------- */
console.log('\n=== 3. verified movement in the first level ===');
const rightTrack = [g.px()];
for (let k = 0; k < 8; k++) { g.run(30, KEY.RIGHT); rightTrack.push(g.px()); }
dumpFrame(g, 'c-stage-right');
const leftTrack = [g.px()];
for (let k = 0; k < 5; k++) { g.run(30, KEY.LEFT); leftTrack.push(g.px()); }
dumpFrame(g, 'd-stage-left');
console.log('pixelX holding RIGHT: ' + rightTrack.join(' -> '));
console.log('pixelX holding LEFT:  ' + leftTrack.join(' -> '));
const movedRight = rightTrack[rightTrack.length - 1] - rightTrack[0];
const movedLeft = leftTrack[leftTrack.length - 1] - leftTrack[0];
if (movedRight > 40) { pass(`moved ${movedRight}px right under held RIGHT`); }
else { fail(`only moved ${movedRight}px right`); }
if (movedLeft < -40) { pass(`moved ${movedLeft}px back under held LEFT`); }
else { fail(`only moved ${movedLeft}px left`); }
if (g.gs() === GAME_STATE_STAGE) { pass('still in GAME_STATE_STAGE throughout the movement test'); }
else { fail('left the stage during the movement test (state ' + g.gs() + ')'); }

g.api.opaque();
const luma = g.api.meanLuma();
console.log(`mean luma in the level: ${luma.toFixed(2)} · hp=${g.hp()} lives=${g.lives()}`);
if (luma > 1.0) { pass('the level renders a non-black frame'); }
else { fail('frame is essentially black in the level (mean luma ' + luma.toFixed(3) + ')'); }

/* ---- 4. the control that makes claim 3 mean something ------------------ */
console.log('\n=== 4. control: the idle attract loop is NOT a stage ===');
const ctrl = await open(null);
const seen = {};
for (let i = 0; i < 6000; i++) { ctrl.api.setKeys(0); ctrl.api.runFrame(); seen[ctrl.gs()] = (seen[ctrl.gs()] || 0) + 1; }
dumpFrame(ctrl, 'e-title-demo');
console.log('frames per gGameState over 6000 passive frames: ' + JSON.stringify(seen));
ctrl.api.opaque();
console.log('attract-loop mean luma: ' + ctrl.api.meanLuma().toFixed(2) +
	' (bright and animated — brightness alone cannot tell this from play)');
if (!seen[GAME_STATE_STAGE]) {
	pass('with no input the game never leaves the title/boot states, so gGameState==8 cannot be reached without playing');
} else {
	fail('the passive run reached GAME_STATE_STAGE, so the gate does not discriminate');
}
if (seen[GAME_STATE_TITLE] > 1000) { pass('the attract loop does run (TITLE held for ' + seen[GAME_STATE_TITLE] + ' frames)'); }
else { fail('the control never reached the title screen, so it is not testing the attract loop'); }

/* ---- 5. savestate round trip ------------------------------------------- */
console.log('\n=== 5. savestate round trip ===');
g.api.opaque();
const hashSnap = g.api.frameHash();
const sSize = g.api.stateSize();
const sPtr = g.api.stateSave();
if (!sPtr || sSize <= 0) {
	fail('savestate capture (size=' + sSize + ')');
} else {
	const snap = Uint8Array.from(g.M.HEAPU8.subarray(sPtr, sPtr + sSize));
	g.run(240, KEY.RIGHT);
	g.api.opaque();
	const hashAfter = g.api.frameHash();
	const rp = g.M._malloc(sSize);
	g.M.HEAPU8.set(snap, rp);
	const restored = g.api.stateLoad(rp, sSize);
	g.M._free(rp);
	g.run(1, 0);           // a savestate restores state; the next frame redraws
	g.api.opaque();
	const hashBack = g.api.frameHash();
	console.log(`size=${sSize} restored=${restored} hash@snap=${hashSnap} hash@+240=${hashAfter} hash@restored=${hashBack}`);
	if (!restored) { fail('savestate load returned false'); }
	else if (hashAfter === hashSnap) { fail('inconclusive: the picture did not change over the divergence window'); }
	else if (hashBack === hashAfter) { fail('savestate load did not rewind the picture'); }
	else { pass('savestate round trip rewound the picture'); }
}

/* ---- 6. the cartridge battery save, mechanism-level -------------------- */
/* The weak version of this test is a reload soak: save, reload, see if it came
 * back. That is a race and it passed 8/8 on a page that was actually broken
 * elsewhere on this fleet. So test the MECHANISM instead, with a control that
 * proves the arms really differ: trace the game's own SRAM writes under three
 * starting conditions. */
console.log('\n=== 6. battery-backed SRAM, with a corruption control ===');
async function traceSram(label, restore) {
	const s = await open(restore);
	const trace = [];
	let last = null;
	for (let i = 0; i < 700; i++) {
		const ph = i % 32;
		s.api.setKeys(ph === 0 ? KEY.A : ph === 16 ? KEY.START : 0);
		s.api.runFrame();
		const v = s.saveNonZero();
		if (v !== last) { trace.push(`f${i}:nz=${v}`); last = v; }
	}
	console.log(`  ${label}\n      writes: ${trace.join(' -> ')}   finalHash=${s.api.saveHash()}`);
	return { trace: trace.join(','), img: s.saveImage(), hash: s.api.saveHash() };
}
const A = await traceSram('A) blank SRAM (first ever boot)', null);
const B = await traceSram('B) A\'s SRAM restored (a valid save is present)', A.img);
const corrupt = Uint8Array.from(A.img);
for (let i = 0; i < corrupt.length; i++) { corrupt[i] ^= 0xa5; }
const C = await traceSram('C) corrupted SRAM restored (control)', corrupt);

if (A.trace.includes('nz=0') && !A.trace.endsWith('nz=0')) {
	pass('the game writes its own battery SRAM through its save driver (blank -> initialised -> file written)');
} else {
	fail('no SRAM write observed on a blank cartridge: ' + A.trace);
}
if (B.trace !== A.trace && B.hash === A.hash) {
	pass('with a valid save restored the game does NOT re-initialise it — so it read the restored image');
} else {
	fail(`restored-save arm did not differ as expected (A=${A.trace} B=${B.trace} hashes ${A.hash}/${B.hash})`);
}
if (C.trace !== B.trace && C.hash !== B.hash) {
	pass('a corrupted image is rejected and rewritten — the game validates contents, not just presence');
} else {
	fail('the corruption control did not differ from the valid-save arm, so this proves nothing');
}

/* ---- done -------------------------------------------------------------- */
console.log('\nframes advanced by the core: ' + g.api.frameCounter());
if (failures) {
	console.log(`\n${failures} FAILURE(S)`);
	process.exitCode = 1;
} else {
	console.log('\nall core checks passed');
}
