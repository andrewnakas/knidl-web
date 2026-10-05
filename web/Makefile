# Browser target for knidl (Kirby: Nightmare in Dream Land).
#
# Builds mGBA's mCore to wasm plus a small shim, and emits a static page that
# takes the user's own ROM from a file picker. No ROM, and no bytes extracted
# from one, are produced or consumed by this Makefile.
#
#   make            build dist/ (the shippable page)
#   make test       also build the node-side core test harness
#   make selftest   run the muted core test against ~/decompfleet/roms
#   make browsercheck   the real page in headless Chrome, muted
#   make check      both
#   make clean
#
# libmgba.a is SHARED with the pokeruby agent (it is GBA-generic, same core).
# Do not rebuild it; the emcmake line that produced it is in
# ~/decompfleet/shared/agbcc-notes.md.

MGBA      ?= $(HOME)/decompfleet/games/pokeruby/ref/mgba
MGBA_BUILD = $(MGBA)/build-wasm
LIBMGBA    = $(MGBA_BUILD)/libmgba.a
ROMS      ?= $(HOME)/decompfleet/roms
ROM       ?= $(ROMS)/knidl.gba
SHOTS     ?=
FRAMES    ?= 2400

# The shim reads struct mCore through mGBA's headers, so it MUST be compiled
# with the same -D set as libmgba.a or the fields land at different offsets and
# every vtable entry reads back as NULL -- no link error, just a "null function
# or function signature mismatch" trap at the first call. Deriving this from the
# build instead of copying it by hand is deliberate: hand-copying it is exactly
# how that bug got in.
MGBA_DEFS = $(shell sed -n 's/^C_DEFINES = //p' $(MGBA_BUILD)/CMakeFiles/mgba.dir/flags.make)

CPPFLAGS = -I $(MGBA)/include -I $(MGBA)/src -I $(MGBA_BUILD)/include \
           -D_GNU_SOURCE -DPATH_MAX=4096 -DDISABLE_THREADING $(MGBA_DEFS)

# No audio device, no filesystem, no GL: the page owns the canvas and only
# creates an AudioContext if the user explicitly unmutes.
EMFLAGS = -s MODULARIZE=1 -s EXPORT_NAME=createGBA \
          -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=64MB \
          -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","HEAPU8","HEAPU32","HEAP16"]' \
          -s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
          -s FILESYSTEM=0

.PHONY: all test selftest browsercheck attract-scan check clean checklib

all: dist/knidl.js dist/index.html dist/app.js dist/app.css

checklib:
	@test -f $(LIBMGBA) || { \
	  echo "missing $(LIBMGBA)"; \
	  echo "it is shared with pokeruby -- see ~/decompfleet/shared/agbcc-notes.md"; exit 1; }
	@test -n "$(MGBA_DEFS)" || { \
	  echo "could not read C_DEFINES from the mgba build; refusing to build with"; \
	  echo "mismatched struct layouts (every mCore function pointer would be NULL)"; exit 1; }

dist/knidl.js: src/shim.c $(LIBMGBA) Makefile | checklib
	@mkdir -p dist
	emcc -O3 $< $(LIBMGBA) $(CPPFLAGS) -o $@ $(EMFLAGS) -s ENVIRONMENT=web

dist/index.html: src/index.html
	@mkdir -p dist
	cp $< $@

# The page's CSP has no 'unsafe-inline', so the script and the stylesheet are
# real files rather than inline blocks. Shipping them is not optional.
dist/app.js: src/app.js
	@mkdir -p dist
	cp $< $@

dist/app.css: src/app.css
	@mkdir -p dist
	cp $< $@

test: test/core-node.js

test/core-node.js: src/shim.c $(LIBMGBA) Makefile | checklib
	@mkdir -p test
	emcc -O2 $< $(LIBMGBA) $(CPPFLAGS) -o $@ $(EMFLAGS) -s ENVIRONMENT=node

# Core-level, outside a browser. Fast; isolates core bugs from page bugs.
selftest: test/core-node.js
	node test/core-smoke.mjs $(ROM) $(FRAMES)

# The real page in headless Chrome, ROM fed through the actual file picker.
# Serves dist/ on an ephemeral port, launches Chrome on an ephemeral debug port
# with a private profile, and tears both down afterwards.
browsercheck: all
	python3 test/browser_check.py $(ROM) $(if $(SHOTS),--shots $(SHOTS))

# What the boot sequence and the attract-loop control were derived from.
attract-scan: test/core-node.js
	node test/attract-scan.mjs $(ROM) 24000 idle

check: selftest browsercheck

clean:
	rm -rf dist test/core-node.js test/core-node.wasm
