/* Kirby: Nightmare in Dream Land -- browser front end.
 *
 * Adapted from the pokeruby agent's page (same mGBA shim surface). Lives in its
 * own file rather than inline in index.html because the page's CSP has no
 * 'unsafe-inline': the policy is meant to be a real boundary, so the document
 * must not need an exemption to run its own code.
 *
 * Nothing here ever sends the ROM anywhere. connect-src 'self' in the CSP makes
 * that structural rather than a promise.
 */
(function () {
'use strict';

var Q = new URLSearchParams(location.search);
var $ = function (id) { return document.getElementById(id); };
var canvas = $('canvas'), ctx = canvas.getContext('2d', { alpha: false });
ctx.imageSmoothingEnabled = false;
/* index.html used to carry oncontextmenu="..." on the canvas; the CSP has no
 * 'unsafe-inline', so inline handlers are dead. Register it here. */
canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

var M = null, api = null;
var W = 240, H = 160, fbPtr = 0, imageData = null;
var running = false, romName = '', romSize = 0;

/* ---------------------------------------------------------------- storage */
/* IndexedDB, not localStorage: the ROM is 8 MB and the cartridge save is
 * 32 KB, both well past localStorage's limit, and both binary. Everything here
 * is local to this browser profile; after its own files load the page makes no
 * network request at all, and could not reach another origin if it tried. */
var DB = 'knidl-web', STORE = 'blobs';

function idb() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open(DB, 1);
    r.onupgradeneeded = function (e) { e.target.result.createObjectStore(STORE); };
    r.onsuccess = function (e) { res(e.target.result); };
    r.onerror = function (e) { rej(e.target.error); };
  });
}
function idbGet(k) {
  return idb().then(function (db) {
    return new Promise(function (res) {
      var r = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
      r.onsuccess = function () { res(r.result || null); };
      r.onerror = function () { res(null); };
    });
  }).catch(function () { return null; });
}
function idbPut(k, v) {
  return idb().then(function (db) {
    return new Promise(function (res, rej) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(v, k);
      tx.oncomplete = function () { res(); };
      tx.onerror = function (e) { rej(e.target.error); };
    });
  });
}
function idbDel(k) {
  return idb().then(function (db) {
    return new Promise(function (res) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(k);
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { res(); };
    });
  }).catch(function () {});
}

/* Save data is keyed per game code (KNiDL USA is A7KE) so a different cart
 * cannot land on this one's battery save. The code is read from the ROM header
 * in JS rather than from the core, because the save must be restored *before*
 * loadROM and the core knows nothing until after. */
var saveKey = 'save';
var stateKey = 'state';

function gameCodeOf(bytes) {
  if (bytes.length < 0xB0) { return 'UNKNOWN'; }
  var s = '';
  for (var i = 0xAC; i < 0xB0; i++) { s += String.fromCharCode(bytes[i]); }
  return /^[A-Z0-9]{4}$/.test(s) ? s : 'UNKNOWN';
}

/* ------------------------------------------------------------------ status */

function setStat(t) { $('stat').textContent = t; }
function setErr(t) { $('err').textContent = t || ''; }

/* ------------------------------------------------------------------- input */

var KEY = { A:1, B:2, SELECT:4, START:8, RIGHT:16, LEFT:32, UP:64, DOWN:128, R:256, L:512 };
var MAP = {
  KeyX:KEY.A, KeyZ:KEY.B, Enter:KEY.START, ShiftRight:KEY.SELECT, ShiftLeft:KEY.SELECT,
  ArrowUp:KEY.UP, ArrowDown:KEY.DOWN, ArrowLeft:KEY.LEFT, ArrowRight:KEY.RIGHT,
  KeyA:KEY.L, KeyS:KEY.R, Backspace:KEY.SELECT
};
var held = 0;
/* Keys injected by the self-test harness, OR-ed with real input so a human and
 * the harness can't fight over one variable. */
var scripted = 0;

addEventListener('keydown', function (e) {
  var b = MAP[e.code];
  if (b) { held |= b; e.preventDefault(); }
});
addEventListener('keyup', function (e) {
  var b = MAP[e.code];
  if (b) { held &= ~b; e.preventDefault(); }
});
addEventListener('blur', function () { held = 0; });

/* Standard-gamepad mapping, polled once per rendered frame. Nothing is
 * registered until a pad reports itself, so this costs nothing otherwise. */
var PAD = { 0:KEY.A, 1:KEY.B, 2:KEY.B, 3:KEY.A, 4:KEY.L, 5:KEY.R, 8:KEY.SELECT, 9:KEY.START,
            12:KEY.UP, 13:KEY.DOWN, 14:KEY.LEFT, 15:KEY.RIGHT };
function padBits() {
  if (!navigator.getGamepads) { return 0; }
  var pads = navigator.getGamepads(), bits = 0;
  for (var i = 0; i < pads.length; i++) {
    var g = pads[i];
    if (!g || !g.connected) { continue; }
    for (var b in PAD) {
      if (g.buttons[b] && g.buttons[b].pressed) { bits |= PAD[b]; }
    }
    var ax = g.axes[0] || 0, ay = g.axes[1] || 0;
    if (ax < -0.5) { bits |= KEY.LEFT; } else if (ax > 0.5) { bits |= KEY.RIGHT; }
    if (ay < -0.5) { bits |= KEY.UP; } else if (ay > 0.5) { bits |= KEY.DOWN; }
  }
  return bits;
}

/* ------------------------------------------------------------------- audio */
/* No AudioContext exists until the user asks for one. "Muted" here means no
 * audio graph at all, not a gain node set to zero. */
var ac = null, audioOn = false, audioBufPtr = 0;

function toggleAudio() {
  if (audioOn) {
    audioOn = false;
    if (ac) { ac.close(); ac = null; }
    $('mutebtn').className = 'muted';
    $('mutebtn').textContent = '🔇 muted — click for sound';
    return;
  }
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: api.sampleRate() });
    var node = ac.createScriptProcessor(1024, 0, 2);
    node.onaudioprocess = function (ev) {
      var l = ev.outputBuffer.getChannelData(0), r = ev.outputBuffer.getChannelData(1);
      var want = l.length;
      var got = api.drainAudio(want);
      var buf = new Int16Array(M.HEAP16.buffer, audioBufPtr, got * 2);
      for (var i = 0; i < want; i++) {
        if (i < got) { l[i] = buf[i * 2] / 32768; r[i] = buf[i * 2 + 1] / 32768; }
        else { l[i] = 0; r[i] = 0; }
      }
    };
    node.connect(ac.destination);
    ac.resume();
    audioOn = true;
    $('mutebtn').className = '';
    $('mutebtn').textContent = '🔊 sound on — click to mute';
  } catch (e) {
    setErr('could not start audio: ' + e.message);
  }
}

/* ------------------------------------------------------------------- video */

function blit() {
  /* ALLOW_MEMORY_GROWTH can detach the old heap view, so take a fresh
   * subarray each frame rather than caching one. */
  api.opaque();
  var src = new Uint8ClampedArray(M.HEAPU8.buffer, fbPtr, W * H * 4);
  imageData.data.set(src);
  ctx.putImageData(imageData, 0, 0);
}

/* ------------------------------------------------------------------ run loop */

var FPS = 59.7275, acc = 0, last = 0, framesRun = 0;

function loop(t) {
  if (!running) { return; }
  requestAnimationFrame(loop);
  if (!last) { last = t; }
  var dt = (t - last) / 1000;
  last = t;
  if (dt > 0.25) { dt = 0.25; }           /* after a tab switch, don't fast-forward */
  acc += dt * FPS;
  var n = Math.floor(acc);
  if (n > 4) { n = 4; }                   /* cap catch-up so a slow frame can't spiral */
  acc -= Math.floor(acc);
  var bits = held | scripted | padBits();
  for (var i = 0; i < n; i++) {
    api.setKeys(bits);
    api.runFrame();
    framesRun++;
  }
  if (n > 0) { blit(); }
  maybePersistSave();
}

/* ------------------------------------------- cartridge save -> IndexedDB */

var lastSaveHash = 0, savePending = false, saveTimer = 0;

function maybePersistSave() {
  if (savePending || !api) { return; }
  /* Hashing 32 KB every frame would be wasteful; check once a second. */
  var now = performance.now();
  if (now - saveTimer < 1000) { return; }
  saveTimer = now;
  var h = api.saveHash();
  if (h === lastSaveHash) { return; }
  lastSaveHash = h;
  savePending = true;
  var ptr = api.saveBuffer(), len = api.saveSize();
  var bytes = M.HEAPU8.slice(ptr, ptr + len);
  idbPut(saveKey, bytes.buffer).then(function () {
    savePending = false;
    var d = $('savedot');
    d.className = 'on';
    setTimeout(function () { d.className = ''; }, 900);
  }).catch(function (e) {
    savePending = false;
    setErr('could not write save data: ' + e.message);
  });
}

function flushSaveNow() {
  if (!api || !running) { return; }
  var ptr = api.saveBuffer(), len = api.saveSize();
  return idbPut(saveKey, M.HEAPU8.slice(ptr, ptr + len).buffer).catch(function () {});
}
/* pagehide fires on reload and on mobile tab eviction; visibilitychange covers
 * backgrounding. Both matter -- an in-game save a second before reload would
 * otherwise be lost. */
addEventListener('pagehide', flushSaveNow);
addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') { flushSaveNow(); }
});

/* --------------------------------------------------------------- savestates */

function saveState() {
  var ptr = api.stateSave(), n = api.stateSize();
  if (!ptr || !n) { setErr('savestate failed'); return; }
  return idbPut(stateKey, M.HEAPU8.slice(ptr, ptr + n).buffer).then(function () {
    setStat('state saved');
  });
}
function loadState() {
  return idbGet(stateKey).then(function (buf) {
    if (!buf) { setStat('no saved state'); return false; }
    var bytes = new Uint8Array(buf);
    var p = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, p);
    var ok = api.stateLoad(p, bytes.length);
    M._free(p);
    setStat(ok ? 'state loaded' : 'state did not match this ROM');
    return !!ok;
  });
}

/* ------------------------------------------------------------------ booting */

function startWithRom(bytes, name) {
  setErr('');
  romName = name || 'ROM';
  romSize = bytes.length;
  saveKey = 'save:' + gameCodeOf(bytes);
  stateKey = 'state:' + gameCodeOf(bytes);

  return idbGet(saveKey).then(function (saveBuf) {
    /* Restore cartridge save BEFORE loadROM: mGBA reads the buffer when it
     * attaches the save media, so restoring afterwards would be ignored. */
    if (saveBuf) {
      var s = new Uint8Array(saveBuf);
      var sp = M._malloc(s.length);
      M.HEAPU8.set(s, sp);
      api.saveRestore(sp, s.length);
      M._free(sp);
    }
    var p = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, p);
    var ok = api.loadRom(p, bytes.length);
    M._free(p);
    if (!ok) { throw new Error('mGBA rejected this file as a GBA ROM'); }

    var title = api.title();
    /* 'AGB KIRBY DX' + 'A7KE' is what vj_game_title() concatenates out of the
     * cartridge header (0xA0 title, 0xAC game code) for the USA release the
     * decompilation matches. */
    if (!/^AGB KIRBY DX/.test(title)) {
      throw new Error('that ROM reports itself as "' + title + '" — this page expects Kirby: Nightmare in Dream Land');
    }
    if (title.indexOf('A7KE') < 0) {
      throw new Error('that ROM is game code "' + title.slice(12) + '" — this page expects the USA release, A7KE');
    }

    fbPtr = api.framebuffer();
    W = api.width(); H = api.height();
    canvas.width = W; canvas.height = H;
    imageData = ctx.createImageData(W, H);
    lastSaveHash = api.saveHash();

    $('overlay').className = 'hidden';
    setStat(title.slice(0, 12).trim() + ' · ' + title.slice(12) + ' · rev ' + api.revision());
    running = true;
    last = 0; acc = 0;
    requestAnimationFrame(loop);
    canvas.focus();
    return true;
  });
}

function handleFile(file) {
  if (!file) { return; }
  setErr('');
  setStat('reading ' + file.name + '…');
  file.arrayBuffer().then(function (ab) {
    var bytes = new Uint8Array(ab);
    /* Cache the ROM locally so a reload doesn't need the picker again. Still
     * never leaves the device. */
    return idbPut('rom', ab).catch(function () { /* quota: run anyway */ })
      .then(function () { return idbPut('romName', file.name); })
      .catch(function () {})
      .then(function () { return startWithRom(bytes, file.name); });
  }).catch(function (e) {
    setErr(e.message);
    setStat('');
  });
}

$('rom-file').addEventListener('change', function (e) { handleFile(e.target.files[0]); });
$('pick').addEventListener('click', function () { $('rom-file').click(); });
['dragenter', 'dragover'].forEach(function (t) {
  document.addEventListener(t, function (e) { e.preventDefault(); $('pick').classList.add('drag'); });
});
['dragleave', 'drop'].forEach(function (t) {
  document.addEventListener(t, function (e) { e.preventDefault(); $('pick').classList.remove('drag'); });
});
document.addEventListener('drop', function (e) {
  if (e.dataTransfer.files.length) { handleFile(e.dataTransfer.files[0]); }
});

$('mutebtn').addEventListener('click', function () { if (api) { toggleAudio(); } });
$('savebtn').addEventListener('click', function () { if (running) { saveState(); } });
$('loadbtn').addEventListener('click', function () { if (running) { loadState(); } });
$('forget').addEventListener('click', function () {
  Promise.all([idbDel('rom'), idbDel('romName')]).then(function () {
    setStat('ROM forgotten — reload to pick another');
  });
});

/* ------------------------------------------------------- self-test hooks */
/* Used by test/browser-check.mjs over the DevTools protocol. Nothing here
 * changes behaviour unless the harness calls it. */
window.__vj = {
  ready: false,
  get running() { return running; },
  get frames() { return framesRun; },
  meanLuma: function () { return api ? api.meanLuma() : -1; },
  frameHash: function () { return api ? api.frameHash() : 0; },
  title: function () { return api ? api.title() : ''; },
  revision: function () { return api ? api.revision() : -1; },
  saveHash: function () { return api ? api.saveHash() : 0; },
  audioOn: function () { return audioOn; },
  audioContextExists: function () { return !!ac; },
  setScripted: function (bits) { scripted = bits | 0; },
  /* Run n frames synchronously, bypassing rAF so a headless run is not at the
   * mercy of the compositor's frame pacing. */
  pump: function (n, bits) {
    if (!api || !running) { return 0; }
    for (var i = 0; i < n; i++) {
      api.setKeys((bits | 0) | held);
      api.runFrame();
      framesRun++;
    }
    blit();
    return framesRun;
  },
  canvasDataUrl: function () { return canvas.toDataURL('image/png'); },
  saveState: saveState,
  loadState: loadState,
  flushSave: flushSaveNow,
  /* Write a recognisable pattern into the cartridge save buffer and persist it,
   * so the harness can prove the IndexedDB round trip without having to play far
   * enough into the game to reach an in-game save. */
  pokeSave: function (seed) {
    var ptr = api.saveBuffer(), len = api.saveSize();
    for (var i = 0; i < 256; i++) { M.HEAPU8[ptr + i] = (seed + i) & 0xFF; }
    lastSaveHash = api.saveHash();
    return flushSaveNow().then(function () { return api.saveHash(); });
  },
  readSaveBytes: function (n) {
    var ptr = api.saveBuffer();
    return Array.from(M.HEAPU8.subarray(ptr, ptr + (n || 16)));
  },

  /* ---- the game's own state, read out of emulated RAM ------------------
   *
   * Every address below comes from the symbol table of the MATCHING build in
   * ../upstream/knidl (arm-none-eabi-nm build/knidl.elf), not from a wiki or a
   * memory-map site. They are the only honest way to tell play from the title
   * screen: left idle, KNiDL loops its title screen and animated intro story
   * for as long as you like, bright and moving throughout, so no screenshot
   * heuristic separates it from play. gGameState is 3 (TITLE) for that whole
   * loop and only ever 8 (STAGE) when a player actually entered a level.
   *
   *   gGameState         0x030023D8  u16   AgbMain's dispatch case
   *   gPrevGameState     0x03002150  u16
   *   gStageRequest      0x03002438  s8    what the stage loop does next
   *   gFrameCount        0x03001EA4  u16
   *   gCameraFocusPlayer 0x02007D38  u8    the player's slot in gTasks
   *   gTasks             0x03002790  struct Task[63], stride 144 (asserted
   *                                  against the real headers with agbcc)
   *   gPlayerHealth      0x02005588  s16[]
   *   gPlayerLives       0x02007D48  s16[]
   *   gContinueLevel     0x02005578  u8
   *
   * struct Task: pixelX @0x48 (s16), pixelY @0x4A, posX @0x4C (s32).
   */
  sym: {
    gGameState: 0x030023d8, gPrevGameState: 0x03002150, gStageRequest: 0x03002438,
    gFrameCount: 0x03001ea4, gCameraFocusPlayer: 0x02007d38, gTasks: 0x03002790,
    gPlayerHealth: 0x02005588, gPlayerLives: 0x02007d48, gContinueLevel: 0x02005578,
    TASK_STRIDE: 144, OFF_PIXELX: 0x48, OFF_PIXELY: 0x4a, OFF_POSX: 0x4c,
    GAME_STATE_TITLE: 3, GAME_STATE_HUB: 5, GAME_STATE_STAGE: 8
  },
  read8: function (a) { return api ? api.read8(a) : -1; },
  read16: function (a) { return api ? api.read16(a) : -1; },
  read16s: function (a) { return api ? api.read16s(a) : 0; },
  gameState: function () { return api ? api.read16(0x030023d8) : -1; },
  stageRequest: function () { return api ? api.read8(0x03002438) : -1; },
  playerSlot: function () { return api ? api.read8(0x02007d38) : -1; },
  playerTaskAddr: function () { return 0x03002790 + this.playerSlot() * 144; },
  playerX: function () { return api ? api.read16s(this.playerTaskAddr() + 0x48) : 0; },
  playerY: function () { return api ? api.read16s(this.playerTaskAddr() + 0x4a) : 0; },
  health: function () { return api ? api.read16s(0x02005588) : 0; },
  lives: function () { return api ? api.read16s(0x02007d48) : 0; },
  /* The harness passes ?nonce=... and asserts this echoes it back, so a run can
   * prove the tab it attached to is the one it opened. Ten agents share this
   * box and a stale DevTools target on a fixed port hands you someone else's
   * page -- that has already caused one agent to grade the wrong game. */
  nonce: Q.get('nonce') || ''
};

/* ------------------------------------------------------------------- init */

createGBA().then(function (mod) {
  M = mod;
  api = {
    init: M.cwrap('vj_init', 'number', []),
    loadRom: M.cwrap('vj_load_rom', 'number', ['number', 'number']),
    runFrame: M.cwrap('vj_run_frame', null, []),
    framebuffer: M.cwrap('vj_framebuffer', 'number', []),
    width: M.cwrap('vj_width', 'number', []),
    height: M.cwrap('vj_height', 'number', []),
    opaque: M.cwrap('vj_opaque', null, []),
    setKeys: M.cwrap('vj_set_keys', null, ['number']),
    meanLuma: M.cwrap('vj_mean_luma', 'number', []),
    frameHash: M.cwrap('vj_frame_hash', 'number', []),
    title: M.cwrap('vj_game_title', 'string', []),
    revision: M.cwrap('vj_rom_revision', 'number', []),
    sampleRate: M.cwrap('vj_sample_rate', 'number', []),
    drainAudio: M.cwrap('vj_drain_audio', 'number', ['number']),
    audioBuffer: M.cwrap('vj_audio_buffer', 'number', []),
    saveBuffer: M.cwrap('vj_save_buffer', 'number', []),
    saveSize: M.cwrap('vj_save_size', 'number', []),
    saveHash: M.cwrap('vj_save_hash', 'number', []),
    saveRestore: M.cwrap('vj_save_restore', 'number', ['number', 'number']),
    stateSize: M.cwrap('vj_state_size', 'number', []),
    stateSave: M.cwrap('vj_state_save', 'number', []),
    stateLoad: M.cwrap('vj_state_load', 'number', ['number', 'number']),
    read8: M.cwrap('vj_read8', 'number', ['number']),
    read16: M.cwrap('vj_read16', 'number', ['number']),
    read16s: M.cwrap('vj_read16s', 'number', ['number']),
    read32: M.cwrap('vj_read32', 'number', ['number'])
  };
  if (!api.init()) { setErr('could not start the emulator core'); return; }
  audioBufPtr = api.audioBuffer();
  window.__vj.ready = true;
  setStat('ready — choose a ROM');

  /* Auto-resume from the locally cached ROM. */
  return Promise.all([idbGet('rom'), idbGet('romName')]).then(function (r) {
    if (r[0]) {
      return startWithRom(new Uint8Array(r[0]), r[1] || 'cached ROM');
    }
  });
}).catch(function (e) {
  setErr('startup failed: ' + e.message);
});

})();
