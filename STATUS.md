# knidl — Kirby: Nightmare in Dream Land (USA)

**The build matches: byte-identical to the staged ROM, verified two ways and
reproduced from zero objects.** The browser target runs that ROM on an
emscripten build of mGBA, from a ROM the user picks themselves.

**Read section 2 before quoting the match as a measure of the decompilation.**
The code is genuinely decompiled; 87% of the ROM image is not, and the green
build does not distinguish them.

---

## 1. The matching build

Upstream documents its own expected hash in `knidl.sha1`. I checked that against
the staged ROM **before building anything**. They agree exactly — there is no
mismatch to report.

| | sha1 | size |
|---|---|---|
| staged `roms/knidl.gba` | `37a476567d133c146fee6b5e2eb0b07a215da6b0` | 8388608 |
| upstream `knidl.sha1` | `37a476567d133c146fee6b5e2eb0b07a215da6b0` | — |
| **built `knidl.gba`** | **`37a476567d133c146fee6b5e2eb0b07a215da6b0`** | 8388608 |

Also, for the record: md5 `35ae64b0f27e60107c14ab956f6cdf70`, sha256
`caa4e11b6102257939297710dc4b49f6cec307de67838b2e7b7627e81b155db8`.

Verified two ways, not one: the build's own `sha1sum -c knidl.sha1` (the
`compare` target, which fails the build on a mismatch), and an independent
`cmp` of the built file against the staged ROM afterwards. Both clean.

**Reproduced from zero objects.** See the trap in section 6 — `make clean`
silently does nothing here — so the second build was done after deleting
`build/` from inside the container. 17 s, byte-identical to the first.

Cartridge header, read back out of the built image: `AGB KIRBY DX`, game code
`A7KE` (USA), maker `01`, version byte `0`. The ROM carries the save-type
string **`SRAM_V112` at 0x72E9F8**, i.e. 32 KiB of battery-backed SRAM — not
flash. That number matters; see section 4.

### Pinned revision

```
overjt/knidl   ae560313d36d80dbe96cff5d7ce6f93dd770e653   (2026-10-04)
               "Merge pull request #181 from overjt/overjt/readme-progress-180"
```
Checked out detached at that commit, not a moving branch.

### Toolchain — this is NOT a pret repo, and it does not want the shared agbcc

Upstream builds **inside Docker** with its own pinned compiler, and the
Makefile wraps every target in `docker run`. `INSIDE_DOCKER=1` runs the real
rules directly, so a host build looks possible — but see below, it is not.

| component | version | where from |
|---|---|---|
| agbcc | **jiangzhengwenjz/agbcc @ `59b966ed1b8f371856dcf99f1546c2fe89c678ca`**, branch `new_newlib_pret` | built inside the image by upstream's Dockerfile |
| base image | Debian 12.15 (`debian:12-slim`) | — |
| arm-none-eabi binutils | 2.40 (Debian `2.40-2+18+b1`) | the image's apt |
| host gcc in the image | 12.2.0 | the image's apt |
| python3 in the image | 3.11.2 | the image's apt |
| docker | 29.1.3, daemon reachable **without sudo** | box |
| emscripten | 4.0.10 (`b7dc6e57`) | shared emsdk |
| mGBA | `68cf79fe55257b61efaeea87c83de69aab01f963` | shared with pokeruby |
| Chrome (tests) | 151.0.7922.108, headless | box |

The image is 751 MB and builds in one `docker build` with no patches.

```sh
cp ~/decompfleet/roms/knidl.gba baserom.gba     # a real copy, not a symlink
make compare                                     # builds the image if needed
```

### Three things worth knowing before anyone repeats this

1. **`baserom.gba` must be a real file, not a symlink.** The Makefile bind-mounts
   the repo into the container; a symlink to `~/decompfleet/roms/knidl.gba`
   dangles inside it and the build dies in the assembler with
   `asm/rom_header.s:18: Error: file not found: baserom.gba`.

2. **The shared agbcc is the wrong compiler, and the host build fails anyway.**
   Upstream pins the *jiangzhengwenjz* fork (`new_newlib_pret`), not `pret/agbcc`.
   There is a `~/decompfleet/shared/agbcc-jzw-install` on this box with no `.ok`
   and no provenance in any notes, so I did not rely on it. More importantly the
   host route fails for a reason that has nothing to do with which agbcc you use:

   The repo's headers reach the **host's** `<stddef.h>` through `cpp -P`, and
   **gcc 15 defaults to C23**, so the preprocessed output contains
   `typedef __typeof__(nullptr) nullptr_t;` — which agbcc (a gcc 2.9 back end)
   cannot parse. Every `src/data/*.c` dies with ``nullptr' undeclared here``.
   Debian 12's gcc 12 defaults to gnu17 and emits nothing of the kind. Measured:

   ```
   cpp -P -I include src/data/actor_handlers.c | grep -c nullptr_t   -> 1
   cpp -P -std=gnu17 ... | grep -c nullptr_t                         -> 0
   ```

   So the pinned container is not belt-and-braces here: **this build is sensitive
   to the host preprocessor's default language standard.** I did not pursue a
   host workaround, because Docker works on this box and is the documented path.

3. **Docker runs as root, so everything it writes is root-owned** — including
   `build/` and `knidl.gba`. See section 6; it makes `make clean` a no-op.

---

## 2. What the match does and does not prove — keep these apart

This is the part the census figures are about, and the two claims are
different.

### First: the census's "data at 0%" is not a measurement

I was briefed that decomp.dev reports knidl at 99.51% matched with **data at 0%**,
and told to expect that essentially all game data comes from the user's ROM.
The second half of that is true, but **the 0% is an artifact, not a result** —
the same one `warioland4` traced in its own project.

decomp.dev reads `tools/gen_report.py`, and that script hardcodes the data
fields to zero, in both the per-unit and the aggregate measures:

```python
# tools/gen_report.py, lines 196-205 (per unit) and 280-289 (totals)
"total_data": 0,
"matched_data": 0,
"matched_data_percent": 0.0,
...
"complete_data": 0,
"complete_data_percent": 0.0,
```

There is no comment explaining it, and no code path that ever computes them.
decomp.dev then renders 0/0 as 0%. **Data is unmeasured there, not untouched.**
Upstream says as much in its own README — *"It measures code only"* — so this is
a known limitation of the report rather than a claim about coverage.

The distinction matters because knidl **does** measure its data elsewhere:
`tools/calcrom.pl` (`make progress`) and `tools/datastats.py` both produce real
data figures, quoted below. So "data at 0%" should be read as *"the decomp.dev
report has no data denominator"*, and the real coverage question has to be
answered from the project's own tooling and from the differential in the next
section.

### The real figures (`make progress`, run by me on my own build)

```
851196 total bytes of code
    847028 bytes of code in src (99.5103%)
    4168 bytes of code in asm (0.4897%)
        0 bytes of code remaining to be decompiled
        0 bytes in 0 functions in asm/nonmatching
        4168 bytes excluded from decompilation tracking

34017 total symbols
    14208 symbols documented (41.7674%)
    19809 symbols undocumented (58.2326%)

7537432 total bytes of data
    95640 bytes of data in src (1.2689%)
    7441560 bytes of data in data (98.7281%)
    232 bytes of data from asm (0.0031%)

7316608 bytes of data in 24725 baserom incbins (97.0703%)
```

These reproduce upstream's README exactly. The census's **99.51% is the code
figure** and it is correct. Its **0% for data is not** — see above; data is simply
absent from the report decomp.dev reads. The conclusion the brief expected from
that 0% (that essentially all game data comes from the user's ROM) turns out to
be true anyway, but it had to be established by measurement rather than read off
the badge.

### How much of the shipped ROM came from the user's dump: measured, not counted

Counting `.incbin` directives is **not** a safe way to answer this — `warioland4`
tried it and overcounted badly, because several of its blob files were dead
leftovers still assembled but no longer linked. So I measured it instead, with a
poisoned-baserom differential:

1. build against a pseudorandom 8 MiB baserom `A`;
2. build again against `A` with **every byte inverted** (`A XOR 0xFF`);
3. the bytes that differ between the two outputs are exactly the bytes the build
   copied out of the baserom.

Inverting rather than using a second independent random file is deliberate: two
independent randoms agree on ~1/256 of their bytes, which would silently
*undercount* the copied region by roughly 28,000 bytes. Inversion guarantees
every copied byte differs. I ran two such pairs with different seeds as a
cross-check, and `make` cannot see the swap (the staged ROM's mtime is 1996), so
`build/` was deleted from inside the container between every run.

```
ROM size                                   8388608 bytes
bytes that moved with the baserom, pair A    7316608  (87.2208%)
bytes that moved with the baserom, pair C    7316608  (87.2208%)
the two pairs agree exactly:               True

=== FROM THE USER'S DUMP :   7316608 bytes  (87.2208%)
=== FROM COMMITTED SOURCE:   1072000 bytes  (12.7792%)

control: every non-baserom byte is identical in all four builds: True
control: the real build matches the real ROM on every baserom byte:  True

the baserom-sourced bytes form 5078 contiguous runs
```

**7,316,608 bytes — 87.22% of the image — come verbatim from the user's dump**,
in 5,078 contiguous runs. The remaining 1,072,000 bytes (12.78%) are built from
committed source.

For knidl the `.incbin` arithmetic happens to give **exactly** the same number
(24,724 slices in `data/*.s` totalling 7,316,452 bytes, plus the 156-byte
Nintendo logo in `asm/rom_header.s` = 7,316,608), difference `+0`. So unlike
`warioland4`, this project has **no dead blob files** — every slice it assembles
is actually linked. That is consistent with `make check-data`, `make audit` and
the zero-diff `make split` regeneration all passing. `make datastats`
independently reports the same `24724 .incbin slices` and **0 of 25,881** ROM
data symbols still defined by absolute address.

Putting the headline in proportion: the "99.51%" covers 847,028 of 851,196 code
bytes, and all code together is **851,196 bytes — 10.15% of the 8 MB ROM**.

### Claim A — the code decompilation is real, and it is essentially complete

847,028 of 851,196 code bytes are compiled from C in `src/` (319 `.c` files,
~198,000 lines). The remaining 4,168 bytes are ten hand-kept `.s` files that
upstream justifies individually: the ROM header, crt0, the master interrupt
handler, the ARM task switcher, the m4a engine's hand-scheduled core, the BIOS
thunks, libgcc's division routines and the interworking veneer — the same set
pret projects keep as asm. Nothing sits in `asm/nonmatching`.

### Claim B — the match does **not** show the data was decompiled

**7,316,608 bytes — 87.22% of the 8,388,608-byte ROM image — are copied
byte-for-byte out of the user's own `baserom.gba` at build time**, as measured by
the differential above, not merely as counted from the source. Only 1.27% of the
data (95,640 bytes) is typed C in `src/data/`.

So a byte-identical output proves that the *extract-and-relink pipeline* is
correct — right offsets, right ordering, right linker script, right section
addresses — and that the compiled code matches. It does **not** prove the
game's data is understood, because most of the output image was never derived
from source at all; it was copied from the input. **If the pipeline is the thing
being judged, the green build is strong evidence. If the decompilation of the
data is the thing being judged, the green build is nearly silent.**

A fair qualification in upstream's favour, which I measured rather than assumed:
the data's *structure* is accounted for even though its *bytes* are not
reproduced from source. `make shifttest` relinks with padding inserted at every
section boundary and censuses every pointer-like word that did not move:

```
pointer census of the 16961 unrelocated words (insertion at 0x08000310):
classes: proven pointer 0, proven coincidence 16898 (format-only 317),
         unreachable 63, unknown 0
lowest proven-safe insertion point: 0x08000000 (.rom_header)
```

Zero unexplained pointer-like words. So the data is modelled well enough to be
relocatable — which is a real result, and still not the same as decompiled.

### Upstream's own integrity checks, all run here

| check | result |
|---|---|
| `make compare` | `knidl.gba: OK` |
| `make check-data` | passed — `data/` holds structure only, no assets committed |
| `make check-headers` | passed (agbcc + old_agbcc + the game headers) |
| `make audit` | passed |
| `make symbols` | `symdb-check: PASS (5348 functions, 19502 call-graph edges)`, 30/30 spot checks |
| `make split` | regenerated |
| `make modmap` | `268 modules / 0 blocks` |
| `git status --porcelain` after all three regenerations | **empty** |
| `make shifttest` | 0 proven pointers, 0 unknown, of 16,961 unrelocated words |
| `make datastats` | 0 of 25,881 ROM data symbols by absolute address |

The regeneration check is the strongest one: the committed symbol database,
the split `asm/`/`data/` tree and the module map all regenerate from the ROM
with **zero diff**. This repo is internally consistent, not a hand-maintained
set of claims.

**Not run: `make boottest`.** It needs a second Docker image and runs 43,513
frames across four scripted inputs on the reference ROM and one shifted ROM per
insertion point. That is upstream's own test, not a deliverable here, and it is
expensive. Also not run: `make assets`, `make assets-check`, `make assets-mod`,
`make boottest-coverage`, `make MATCHING=0`.

---

## 3. The browser target

A direct emscripten build of mGBA's `mCore` API plus a ~390-line C shim and one
static page. Not EmulatorJS and not a libretro frontend, so none of
`emulatorjs-notes.md`'s traps apply. `libmgba.a` is **shared with the pokeruby
agent** (the core is GBA-generic); it was not rebuilt.

```
dist/knidl.wasm   663,244 B
dist/knidl.js      19,024 B
dist/app.js        20,116 B
dist/app.css        2,914 B
dist/index.html     2,927 B
                  --------
                  708,225 B
```

- **The user supplies the ROM.** A real `<input type=file>` plus drag-and-drop,
  read with the File API straight into wasm linear memory. The page is static
  files with no server component.
- The ROM is cached in IndexedDB so a reload does not re-prompt, with a
  **"forget ROM"** button. It never leaves the device.
- **Muted by default and genuinely silent**: no `AudioContext` is constructed at
  all until the user clicks unmute. Muting is the absence of an audio graph, not
  a gain node at zero.
- The page refuses a ROM whose header is not `AGB KIRBY DX` / `A7KE`.

### The CSP is the real boundary, and it is tested by being attacked

The page ships a strict policy with **no `'unsafe-inline'` and no
`'unsafe-eval'`** — which is why the script and the stylesheet are separate
files rather than inline blocks:

```
default-src 'none';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self';
img-src 'self' data:;
connect-src 'self';
worker-src 'self';
base-uri 'none';
form-action 'none'
```

`connect-src 'self'` is the line that matters: the page physically cannot open a
connection to another origin, whatever its script tries. The test does not read
the meta tag — it tries to breach the policy and checks what the browser
reports. `frame-ancestors` is deliberately absent so the catalog can iframe the
page; nothing that could carry a ROM off the device depends on it.

**A finding worth keeping:** two of the breach attempts *look* successful from
inside the page. `navigator.sendBeacon()` returned `true` and
`new WebSocket('wss://example.com/')` constructed without throwing — yet the
browser reported `connect-src <- https://example.com/b` and
`connect-src <- wss://example.com/` violations and nothing left the machine.
**An API return value is not evidence that a request was sent.** Judge by
`securitypolicyviolation` events and by the CDP network log, which is what the
test now does.

**And the blocking is proved to be the policy, not the sandbox.** This box has
no outbound network, so "the fetch failed" would pass against a page with no CSP
at all. Two positive controls separate them:

- a **same-origin** fetch from the same page still succeeds (`OK:200`), so the
  network path is alive and the refusals are not a dead sandbox;
- the test writes a **CSP-stripped copy of this very page**, runs the identical
  probes against it, and requires the opposite outcome: zero
  `securitypolicyviolation` events, and the injected inline `<script>`
  **does** run. Observed exactly that (`violations=[] inlineRan=True`). The copy
  is deleted afterwards and is gitignored.

Without those controls the whole section would be unfalsifiable.

---

## 4. What I actually tested

Everything below ran **muted**, by fleet rule.

### "Played" is gated on the game's own state, from my build's symbols

Addresses come from `arm-none-eabi-nm build/knidl.elf` on the matching build —
never from a wiki:

```
gGameState          0x030023D8  u16    AgbMain's dispatch case
gPrevGameState      0x03002150  u16
gStageRequest       0x03002438  s8
gCameraFocusPlayer  0x02007D38  u8     the player's slot in gTasks
gTasks              0x03002790  struct Task[63], stride 144
gPlayerHealth       0x02005588  s16[]
gPlayerLives        0x02007D48  s16[]
```

`struct Task.pixelX` is at `+0x48`. The stride and that offset were **asserted
with the real compiler against the real headers** (a `sizeof(struct Task) == 144`
compile-time assert built with agbcc inside the image), not inferred from the gap
between symbols. `GAME_STATE_STAGE` is 8; `GAME_STATE_TITLE` is 3.

**The control that makes this mean something.** Left completely idle for 24,000
frames (~6.7 minutes of emulated time), the game cycles title screen and intro
story and **never leaves `gGameState == 3`**. The player task's sprite animates
on 115 of those frames, so a "something is moving, so it must be playing"
heuristic would be fooled; mean luma during the loop is ~194, so a brightness
test would be fooled too. `gGameState == 8` is not reachable without real input.
(`make attract-scan` reproduces this.)

### Core, in node (`web/test/core-smoke.mjs`) — verified

- Header reads back `AGB KIRBY DX` + `A7KE`, revision 0, save media 32 KiB.
- Boot → hub → **stage**, state path
  `RESET → BOOT_LOGO → TITLE → MAIN_MENU → HUB → CUTSCENE → HUB → STAGE_START → STAGE`.
- Kirby verified **at rest** with no input first (so a later move proves
  something), then **moved +228 px right under held RIGHT and −165 px back
  under held LEFT**, staying in `GAME_STATE_STAGE` throughout.
- Health dropped 48 → 40 during the run: he was hit by a live enemy.
- Savestate round trip rewinds the picture, with an inconclusive-guard that fails
  the test if the frame never changed during the divergence window.
- **I looked at the frames.** Dumped PPMs show Green Greens (stage 1-1) with the
  mountain parallax, the HUD reading `x02` lives and the health bar, Kirby at the
  left edge; then Kirby mid-level with two enemies and the health bar down to
  four segments, matching the measured hp drop.

### The real page, headless Chrome (`web/test/browser_check.py`) — 31/31

The ROM is fed to the genuine file input over CDP (`DOM.setFileInputFiles`), so
the picker, File API path, IndexedDB cache and boot sequence under test are the
ones a user gets.

- core initialises; **the tab echoes our URL nonce** (see section 6)
- cross-origin fetch refused; cross-origin `<img>` refused; injected inline
  `<script>` does not execute; connect-src violations reported for the beacon
  and WebSocket attempts
- **positive controls for all of that**: a same-origin fetch still succeeds, and
  a CSP-stripped copy of the same page reports no violations and *does* run the
  injected inline script
- the page made 5 requests, every one to its own origin, and nothing it did on
  its own reached for another origin
- ROM accepted; header and revision asserted
- reached `GAME_STATE_STAGE`; **+221 px right, −247 px back**, still in-stage
- **brightness measured from the driver's screenshot, cropped to the canvas
  rect** — mean luma 169.8, lit fraction 0.853. The page is never asked to
  measure itself.
- **no `AudioContext` object exists at all**
- the game's own SRAM writes land in IndexedDB; the stored 32 KiB record is
  byte-identical across a real page reload; the ROM resumes from cache
- **negative control**: the same assertion is re-run with the record deleted and
  the detector correctly reports nothing stored, so the pass above is not vacuous
- no uncaught page errors

Run **4 times in a row, 31/31 each time**, after fixing the pause-menu flake in
trap 5 — an earlier version passed 1 run in 4 and the three failures were the
harness pausing the game, not the game failing.

### Persistence, proven at the mechanism rather than by a soak

A reload soak is a race and a weak detector — it passed 8/8 on a page that was
broken elsewhere on this fleet. So the SRAM test traces the **game's own write
behaviour** under three starting conditions, with a corruption control:

| arm | SRAM non-zero byte count over 700 boot frames | final hash |
|---|---|---|
| **A** blank SRAM (first ever boot) | `f0: 0 → f4: 672 → f304: 482` | 77774908 |
| **B** A's image restored | `f0: 482` (no re-initialisation at all) | 77774908 |
| **C** A's image XOR 0xA5 (corrupt) | `f0: 32768 → f4: 32744 → f304: 32544` | 1319236102 |

- **A** shows the game drives its own save driver: it initialises the save area
  at frame 4 and writes a file at frame 304. These are real battery-backed SRAM
  writes, not a buffer I poked.
- **B** shows the game **read** the restored image: it found a valid save and
  left it completely alone.
- **C** is the control. A corrupted image is rejected and re-initialised at the
  *same frames* as the blank cartridge, ending with a different hash. So the game
  validates the contents, not merely the presence — and the detector in B is
  therefore discriminating, not vacuous.

### What I did NOT test — be clear about this

- **No long-form play.** The run reaches stage 1-1 (Green Greens) and moves
  Kirby around in it. Nothing beyond that is play-tested: the stage is not
  cleared, no boss, no mid-boss, no goal game, no sub-game, no ability copy, no
  second level, no ending. This was deliberate — chasing a level clear cost
  another session on this fleet for no added evidence.
- **I never reached an in-game SAVE from the menu.** The SRAM writes verified
  above are the ones the game makes at boot and at file creation. Playing to a
  save point, saving, and resuming a continuable game from it is **unverified**.
- **`make boottest` was not run** — upstream's own frame-exact emulator test.
- **Only headless Chrome 151.** No Firefox, no Safari, no real mobile browser.
- **No touch controls.** Keyboard and gamepad only, and the gamepad path is
  inherited from pokeruby and **unverified** — no controller was attached.
- **Audio is unverified.** The drain-to-ScriptProcessor path exists and is wired
  to the unmute button, but every test ran muted by rule, so it has never been
  heard.
- Non-USA ROMs: upstream states A7KE rev 0 is the only retail revision; either
  way nothing else was tried.
- The modder path (`make MATCHING=0`) and asset extraction (`make assets`) were
  not exercised.
- Nothing is published: `source` and `embedUrl` in the fragment below are
  placeholders.

---

## 5. Proposed catalog fragment

Do not merge mechanically — `verification.date`, `source`, `image` and
`embedUrl` are placeholders until this is actually published.

```json
{
  "id": "kirby-nightmare-in-dream-land",
  "title": "Kirby: Nightmare in Dream Land",
  "aliases": ["knidl", "kirby nightmare in dream land", "kirby nidl", "kirby gba", "AGB KIRBY DX", "A7KE"],
  "year": 2002,
  "genre": "Platformer",
  "kind": "Decompilation",
  "mode": "files",
  "engine": "the overjt/knidl decompilation, built to a matching ROM and run on an emscripten build of mGBA",
  "description": "Inhale enemies, steal their powers and float through Dream Land.",
  "overview": "Kirby: Nightmare in Dream Land built from the overjt/knidl decompilation, pinned at ae560313. The build is byte-identical to a retail USA cartridge dump, sha1 37a476567d133c146fee6b5e2eb0b07a215da6b0. All of the game's code is compiled from C in the repository; the game's data is read out of your own ROM at build time rather than committed, so the project distributes no assets — measured by a poisoned-baserom differential, 87.22% of the built image comes verbatim from your dump and 12.78% from committed source. The page runs the result on a direct WebAssembly build of mGBA's core, 663 KB, with no emulator frontend in between. You supply your own ROM: it is read in your browser with the File API straight into the emulator's memory, and the page's Content-Security-Policy blocks connections to every origin but its own.",
  "source": "https://github.com/andrewnakas/knidl-web",
  "engineLicense": "overjt/knidl is all-rights-reserved (the pret-style convention); mGBA core MPL-2.0",
  "assetLicense": "None distributed — the player supplies their own ROM",
  "assetRequirements": "Your own Kirby: Nightmare in Dream Land ROM, USA (game code A7KE), 8,388,608 bytes, sha1 37a476567d133c146fee6b5e2eb0b07a215da6b0. It is read in your browser and never uploaded.",
  "controls": [
    "Arrow keys — D-pad (Up enters a door on the world map)",
    "X — A (jump, inhale)",
    "Z — B",
    "A / S — L / R",
    "Enter — Start",
    "Shift — Select",
    "Gamepad — any standard controller (untested)"
  ],
  "saveInstructions": "The cartridge's battery-backed SRAM (32 KB) is mirrored into this browser's storage and restored automatically on reload, so in-game saves persist. There are also save-state buttons. Clearing site data removes everything, including the cached ROM.",
  "limitations": [
    "You must supply your own ROM; none is distributed.",
    "USA release (A7KE) only.",
    "Verified only as far as moving Kirby around stage 1-1. The stage is not cleared, and bosses, sub-games, ability copying and the ending have not been play-tested.",
    "The decompilation covers the game's code, not its data: 87% of the built ROM is copied verbatim from your own dump at build time, so a matching build proves the build pipeline more than it proves the data is understood.",
    "Saving from the in-game menu was never reached. Save persistence is verified at the cartridge-SRAM layer: the game writes its own battery save, a restored image is recognised and kept, a corrupted one is rejected, and the stored record survives a page reload.",
    "Sound is implemented but has never been listened to — all testing was muted.",
    "Keyboard and gamepad only; no on-screen touch controls, and the gamepad path is untested.",
    "Tested in headless Chrome only.",
    "Link-cable features are not available in the browser."
  ],
  "inputs": ["Keyboard", "Gamepad"],
  "downloadMB": 1,
  "complete": false,
  "color": "#f090b0",
  "shelf": "decomp",
  "platform": "Game Boy Advance",
  "launch": "embed",
  "touch": false,
  "embedUrl": "https://andrewnakas.github.io/knidl-web/",
  "verification": {
    "status": "smoke-tested",
    "date": null,
    "browsers": ["Chrome (headless)"],
    "scope": "Muted headless run: boot, title, world map, and entering stage 1-1, with Kirby's movement verified against the game's own gGameState and player-task position cells rather than against a screenshot. Cartridge-SRAM persistence across a real page reload, with a corruption control. No play-testing beyond the first level's opening.",
    "playthrough": false
  },
  "image": "/images/kirby-nightmare-in-dream-land.png"
}
```

---

## 6. Layout, and four traps

```
games/knidl/
  STATUS.md                  this file
  .gitignore                 no ROMs, no extracted assets, no build output
  upstream/knidl/            overjt/knidl @ ae560313 (detached), not vendored
  tools/
    cdp.py                   CDP client, ephemeral-port fixed (see trap 3)
    pngstat.py               PNG brightness, stdlib only
    save_mechanism.py        kept from pokefirered for reference (EmulatorJS-specific)
    serve.py                 static server for web/dist on an ephemeral port
  web/
    Makefile                 all / test / selftest / browsercheck / attract-scan / check
    src/shim.c               mCore -> JS surface, plus read-only RAM probes
    src/index.html           the page (CSP, no inline script or style)
    src/app.js               the application script
    src/app.css              the stylesheet
    test/core-smoke.mjs      core test in node (VJ_DUMP=dir for PPM frames)
    test/attract-scan.mjs    where the boot sequence and the idle control came from
    test/browser_check.py    the real page in headless Chrome
    dist/                    build output (gitignored)
```

### Trap 1 — `make clean` silently does nothing, and a "clean rebuild" lies

Docker runs as **root**, so `build/` and everything under it is root-owned. The
host-side `make clean` is a plain `rm -rf build knidl.gba` run as your user:
`knidl.gba` *is* removed (the repo root is yours, and deletion permission comes
from the directory), but `build/` survives because its contents sit in
root-owned subdirectories. The subsequent build then relinks **360 stale
objects**, re-runs `objcopy` and `gbafix`, and reports `OK` — so it looks like a
clean rebuild and is not. Upstream's Makefile carries a long comment about
exactly this failure mode (issue #85, stale objects masking a regression); this
is the same bug arriving by a different route on Linux.

To actually clean:

```sh
docker run --rm -v "$PWD":/src -w /src knidl-builder rm -rf build knidl.gba
```

### Trap 2 — `*.md` in the fleet's ROM ignore list eats your Markdown

The standard ignore list includes `*.md` for Mega Drive images, which also
matches `STATUS.md`. The obvious fix, `!*.md`, is wrong: it lets a real `.md`
ROM back in. This tree un-ignores the documents **by name** instead. After
editing `.gitignore`, `git check-ignore -v STATUS.md` must print nothing, and
`git check-ignore -q sonic.md` must still report it ignored. Both were checked.

### Trap 3 — a fixed debug port attaches you to another agent's browser

`tools/cdp.py` arrived with `port: int = 9585` hardcoded. On this box that
attaches to whatever Chrome is already on that port and hands you *their* page.
The copy here defaults to **`port=0`** and reads the real port back from
`DevToolsActivePort` inside its own private `--user-data-dir`, which also proves
the browser is the one we launched. On top of that the page echoes a **URL
nonce** that the harness asserts, and every pre-existing page target is closed
before the run — a leftover tab holding IndexedDB open makes `deleteDatabase()`
in a new tab block forever, which looks exactly like a broken core.

### Trap 4 — one long synchronous JS block is not the same as a held key

The page has two frame sources: its own `requestAnimationFrame` loop and
`__vj.pump()`, which the harness drives synchronously (headless Chrome is not
guaranteed any rAF ticks). They must agree on the input, or a `pump(1, UP)` with
rAF frames carrying `0` in between reads as a flicker rather than a held button
and the hub door never opens. `pump()` therefore sets `__vj.setScripted(bits)`
for the whole hold.

Even then, the door needed **UP held for ~90 frames in the page** where 20 was
enough in the node core test, and driving the whole boot-and-enter sequence
inside *one* blocking `Runtime.evaluate` call failed outright while the identical
calls issued separately succeeded. The harness issues them separately and holds
for 90. If a scripted input "does nothing", suspect the hold length and the
blocking block before suspecting the core.

### Trap 5 — a blind A/START tap loop opens the pause menu and freezes the run

This one produced a **confidently wrong, intermittently green** result, so it is
worth stating plainly. The obvious way to get through the boot sequence is a
blind `A` at phase 0, `START` at phase 16 pattern. That works only if it starts
on frame 0. The page's rAF loop advances the game a variable number of frames
first (0, 8, 9 and 10 all observed in consecutive runs), which shifts the
pattern — and a shifted `START` lands once Kirby is already in the hub, which
opens the **pause screen**.

`gGameState` stays `5` (HUB) while paused. So the run reports "still in the hub",
every later input goes to the menu instead of the game, and Kirby's position
never changes — which reads as "movement test failed" rather than "the harness
paused the game". Three of four runs failed this way while one passed, and the
20-attempt adaptive sweep I added first did not help, because every attempt was
being delivered to a menu.

The fix is to make the input **state-gated**: press only in the states that need
pressing (boot logo, title, main menu, and `A` to skip the cutscene) and press
**nothing at all** in the hub. Both harnesses are written that way now, plus a
`B` tap at the top of each sweep attempt so a stuck run can back out of a menu
rather than burning every remaining attempt. 4/4 runs green afterwards, entering
the stage on the first attempt each time.

General lesson for this fleet: *when a scripted run looks stuck in a state, check
whether your own input put it in a menu before concluding anything about the
game.*
