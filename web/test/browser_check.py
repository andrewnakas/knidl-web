#!/usr/bin/env python3
"""The real knidl page in headless Chrome, muted.

Drives web/dist exactly as a user would: the ROM goes in through the genuine
<input type=file> over DevTools, so the picker, the File API path, the
IndexedDB cache and the boot sequence under test are the ones a user gets.

What this is careful about, and why:

  * Ephemeral debug port + private profile + a URL nonce the page echoes back.
    A fixed port on this box attaches to another agent's Chrome and hands you
    THEIR page; that has already made one agent grade the wrong game.
  * Every existing page target is closed first. A leftover tab holding the
    IndexedDB open makes deleteDatabase() in a new tab block forever, so the
    page stalls on its first save write and never boots -- which looks exactly
    like a broken core.
  * Brightness is measured from the DRIVER's screenshot, not from the page.
    A page that measures its own canvas can report perfect black while the game
    is plainly running.
  * "Played" is gated on the game's own state cells, read from the matching
    build's symbol table. Left idle this game loops a bright, animated title
    and intro story forever, so no picture-based heuristic separates it from
    play.
  * The CSP is tested by trying to breach it, not by reading the meta tag.
  * Save persistence has a NEGATIVE control: the same assertion is re-run with
    the stored record deleted, and the run fails if it still "passes".

    python3 web/test/browser_check.py <rom> [--shots DIR]
"""
import argparse
import hashlib
import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import cdp          # noqa: E402
import pngstat      # noqa: E402

# GBA key bits, from mGBA's enum GBAKey.
KEY = {"A": 1, "B": 2, "SELECT": 4, "START": 8, "RIGHT": 16, "LEFT": 32,
       "UP": 64, "DOWN": 128, "R": 256, "L": 512}

GAME_STATE_HUB, GAME_STATE_STAGE = 5, 8

results: list[tuple[bool, str]] = []


def check(ok: bool, msg: str) -> bool:
    results.append((bool(ok), msg))
    print(("  PASS  " if ok else "  FAIL  ") + msg, flush=True)
    return bool(ok)


def pump(tab, frames, bits=0, chunk=120):
    """Advance real frames with `bits` held, and never sleep and hope.

    Two frame sources exist at once: the page's own requestAnimationFrame loop,
    and __vj.pump() which we drive synchronously (a headless tab is not
    guaranteed any rAF ticks, so pumping is what makes a run deterministic).
    They must agree on the input or they fight: a one-frame pump(1, UP) with
    rAF frames carrying 0 in between reads as a flicker, not a held button, and
    the game never opens the door. setScripted() is the page's own hook for
    holding a key across the rAF path, so set it for the whole hold.
    """
    tab.js(f"window.__vj.setScripted({bits})")
    try:
        done = 0
        while done < frames:
            n = min(chunk, frames - done)
            tab.js(f"window.__vj.pump({n}, {bits})")
            done += n
        return done
    finally:
        tab.js("window.__vj.setScripted(0)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("rom", type=pathlib.Path)
    ap.add_argument("--shots", type=pathlib.Path, default=None)
    a = ap.parse_args()
    rom = a.rom.resolve()
    if not rom.is_file():
        print(f"no such ROM: {rom}")
        return 2
    if a.shots:
        a.shots.mkdir(parents=True, exist_ok=True)

    # --- static server on an ephemeral port --------------------------------
    srv = subprocess.Popen([sys.executable, str(ROOT / "tools" / "serve.py"), "0"],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    line = srv.stdout.readline().strip()
    if not line.startswith("PORT "):
        print("server did not start: " + line)
        srv.kill()
        return 1
    port = int(line.split()[1])
    base = f"http://127.0.0.1:{port}/index.html"
    print(f"serving web/dist on {port}")

    nonce = "knidl%d" % int(time.time() * 1000 % 1_000_000_007)
    chrome = None
    try:
        chrome = cdp.Chrome(headless=True)       # port=0 -> ephemeral
        print(f"chrome debug port {chrome.port} (ephemeral), profile {chrome.profile}")
        chrome.close_other_pages()
        tab = chrome.tab("about:blank")
        chrome.close_other_pages(keep=tab)
        tab.call("Network.enable")

        # ---------------------------------------------------------------- 1
        print("\n1. page boot, identity of the tab")
        if not tab.goto(f"{base}?nonce={nonce}"):
            check(False, "page navigated")
            raise SystemExit
        for _ in range(240):
            if tab.js("!!(window.__vj && window.__vj.ready)"):
                break
            time.sleep(0.25)
        check(tab.js("!!(window.__vj && window.__vj.ready)"), "mGBA core initialised in the page")
        check(tab.js("window.__vj.nonce") == nonce,
              f"the tab echoes our nonce ({nonce}) -- it is our page, not another agent's")

        # ---------------------------------------------------------------- 2
        print("\n2. the CSP as the real boundary (tested by trying to breach it)")
        # An API's return value is NOT evidence here: navigator.sendBeacon()
        # returns true for "queued" even when the CSP then drops it, and
        # `new WebSocket(...)` does not throw synchronously when connect-src
        # refuses it. So judge by what the browser REPORTS and what actually
        # leaves: securitypolicyviolation events, plus the network log in step 4.
        tab.js("window.__csp = []; addEventListener('securitypolicyviolation',"
               " function (e) { window.__csp.push(e.effectiveDirective + ' <- ' + e.blockedURI); });")
        tab.js("""(function () {
          window.__try = {};
          try { window.__try.beacon = navigator.sendBeacon('https://example.com/b', 'x'); }
          catch (e) { window.__try.beacon = 'threw:' + e.name; }
          try { new WebSocket('wss://example.com/'); window.__try.ws = 'constructed'; }
          catch (e) { window.__try.ws = 'threw:' + e.name; }
          var s = document.createElement('script');
          s.textContent = 'window.__cspInline = 1';
          document.head.appendChild(s);
          window.__try.inline = window.__cspInline ? 'RAN' : 'BLOCKED';
          var i = new Image(); i.src = 'https://example.com/p.png';
        })()""")
        fetch_res = tab.js(
            "fetch('https://example.com/x').then(function(){return 'REACHED';},"
            "function(e){return 'BLOCKED:' + e.name;})", await_promise=True)
        time.sleep(1.5)
        viol = tab.js("JSON.stringify(window.__csp)")
        tried = tab.js("JSON.stringify(window.__try)")
        print("    attempts: " + str(tried))
        print("    violations reported: " + str(viol))
        v = json.loads(viol or "[]")
        check(str(fetch_res).startswith("BLOCKED"),
              f"a cross-origin fetch is refused by connect-src 'self' ({fetch_res})")
        check(tab.js("window.__try.inline") == "BLOCKED",
              "an injected inline <script> does not execute (no 'unsafe-inline')")
        check(any("connect-src" in s and "example.com" in s for s in v),
              "the browser reports connect-src violations for the cross-origin "
              "fetch / WebSocket / beacon attempts")
        check(any("img-src" in s and "example.com" in s for s in v),
              "even a cross-origin <img> is refused by img-src 'self'")
        check(any("script-src" in s for s in v),
              "the inline-script injection is reported as a script-src violation")

        # ---- the controls, without which none of the above means anything ----
        # This box is sandboxed, so a bare "the fetch failed" would pass against
        # a page with NO CSP at all. Two controls separate the policy from the
        # environment: (a) a same-origin request still succeeds, so the network
        # path works; (b) the identical probes against a CSP-stripped copy of
        # this very page report no violations at all.
        print("\n2b. controls: is it the policy blocking, or just the sandbox?")
        same_origin = tab.js(
            "fetch('app.css').then(function(r){return 'OK:' + r.status;},"
            "function(e){return 'FAILED:' + e.name;})", await_promise=True)
        check(str(same_origin).startswith("OK"),
              f"a same-origin fetch still succeeds ({same_origin}) -- the network path works, "
              "so the refusals above are the policy, not a dead sandbox")

        nocsp = ROOT / "web" / "dist" / "_nocsp.html"
        src = (ROOT / "web" / "dist" / "index.html").read_text()
        i, j = src.index("<meta http-equiv=\"Content-Security-Policy\""), 0
        j = src.index(">", src.index("form-action 'none'", i)) + 1
        nocsp.write_text(src[:i] + "<!-- CSP deliberately removed: test control -->" + src[j:])
        try:
            tab.goto(f"http://127.0.0.1:{port}/_nocsp.html?nonce={nonce}")
            for _ in range(120):
                if tab.js("!!(window.__vj && window.__vj.ready)"):
                    break
                time.sleep(0.25)
            tab.js("window.__csp = []; addEventListener('securitypolicyviolation',"
                   " function (e) { window.__csp.push(e.effectiveDirective + ' <- ' + e.blockedURI); });")
            tab.js("""(function () {
              try { navigator.sendBeacon('https://example.com/b', 'x'); } catch (e) {}
              try { new WebSocket('wss://example.com/'); } catch (e) {}
              var s = document.createElement('script');
              s.textContent = 'window.__cspInline = 1';
              document.head.appendChild(s);
              var i = new Image(); i.src = 'https://example.com/p.png';
            })()""")
            tab.js("fetch('https://example.com/x').then(function(){},function(){})",
                   await_promise=False)
            time.sleep(1.5)
            v2 = json.loads(tab.js("JSON.stringify(window.__csp)") or "[]")
            inline2 = tab.js("window.__cspInline === 1")
            print(f"    same probes on the CSP-stripped copy: violations={v2} inlineRan={inline2}")
            check(not v2, "the CSP-stripped copy of this page reports NO violations "
                          "(so the violations above came from the policy)")
            check(inline2 is True,
                  "and its injected inline <script> DOES run (so 'no unsafe-inline' is "
                  "what blocked it on the real page, not something else)")
        finally:
            nocsp.unlink(missing_ok=True)
        # Drop every request recorded so far, BEFORE navigating back, so the
        # fresh load's own js/wasm fetches are still recorded afterwards. The
        # breach probes -- and crucially the CSP-FREE control page's copies of
        # them, which were NOT blocked -- would otherwise be censused in step 4
        # as if the real page had made them.
        tab.events = [e for e in tab.events if e.get("method") != "Network.requestWillBeSent"]
        # Back to the real page for the rest of the run.
        tab.goto(f"{base}?nonce={nonce}")
        for _ in range(240):
            if tab.js("!!(window.__vj && window.__vj.ready)"):
                break
            time.sleep(0.25)

        # ---------------------------------------------------------------- 3
        print("\n3. the ROM through the real file picker")
        tab.set_file_input("#rom-file", [str(rom)])
        for _ in range(240):
            if tab.js("window.__vj.running === true"):
                break
            time.sleep(0.25)
        check(tab.js("window.__vj.running === true"), "the page accepted the ROM and started")
        title = tab.js("window.__vj.title()")
        check(isinstance(title, str) and title.startswith("AGB KIRBY DX") and "A7KE" in title,
              f'cartridge header reads back as "{title}"')
        check(tab.js("window.__vj.revision()") == 0, "header revision 0")

        # ---------------------------------------------------------------- 4
        print("\n4. network: the page talks to nobody")
        reqs = []
        for e in tab.events:
            if e.get("method") == "Network.requestWillBeSent":
                reqs.append(e["params"]["request"]["url"])
        # The log was cleared after step 2b, so this covers only the real page's
        # own fresh load plus the ROM and gameplay -- none of our breach probes,
        # and none of the CSP-free control page's unblocked copies of them.
        foreign = [u for u in reqs
                   if not (u.startswith(f"http://127.0.0.1:{port}/")
                           or u.startswith("data:") or u.startswith("blob:"))]
        check(not foreign,
              (f"the page made {len(reqs)} requests, every one to its own origin"
               if not foreign else f"foreign requests: {foreign[:4]}"))
        check(not any("example.com" in u for u in reqs),
              "nothing the page did on its own reached for another origin")
        check(any(u.endswith(".wasm") for u in reqs), "the core wasm was fetched from our own origin")

        # ---------------------------------------------------------------- 5
        print("\n5. boot to a stage, gated on the game's own state")
        print(f"    (page had already run {tab.js('window.__vj.frames')} frames "
              "of its own rAF loop before the scripted run starts)")
        # Exactly the per-frame input pattern the core test uses, driven inside
        # one CDP call so the frame timing is identical. Chunked pumping with
        # coarse key holds is NOT equivalent: menus need edges, and holding START
        # for 20 frames in the hub does something different from tapping it.
        path_js = """(function () {
          var path = [], prev = -1;
          function note(i) { var s = window.__vj.gameState();
            if (s !== prev) { path.push('f' + i + ':' + s); prev = s; } }
          /* State-GATED, not a blind tap loop. A blind A/START pattern works
             only if it starts on frame 0; the page's rAF loop advances the game
             a variable number of frames first, and with the pattern shifted a
             START press lands once Kirby is already in the hub, which opens the
             PAUSE screen. gGameState stays 5 while paused, so the run looks like
             "still in the hub" while in fact every later input goes to a menu
             and Kirby never moves -- exactly the 0px-movement failure this
             replaces. So: press only in the states that need pressing, and
             press nothing at all in the hub. */
          var stable = 0;
          for (var i = 0; i < 2400; i++) {
            var s = window.__vj.gameState(), ph = i % 32, bits = 0;
            if (s === 1 || s === 3 || s === 4) {           /* boot logo, title, menu */
              bits = (ph === 0 ? 1 : (ph === 16 ? 8 : 0)); /* A / START */
            } else if (s === 7) {                          /* intro cutscene */
              bits = (ph === 0 ? 1 : 0);                   /* A skips it */
            } else if (s === 5) {                          /* hub: hands off */
              if (++stable > 240) { note(i); break; }
            }
            window.__vj.pump(1, bits);
            note(i);
          }
          return JSON.stringify(path);
        })()"""
        state_path = json.loads(tab.js(path_js, timeout=180))
        print("    gGameState path through boot: " + " -> ".join(state_path))
        check(tab.js("window.__vj.gameState()") == GAME_STATE_HUB,
              "reached the hub (GAME_STATE_HUB, 5)")

        # Let the post-cutscene walk finish: UP only opens the door once Kirby
        # is standing on it. Separate calls on purpose -- see the note below.
        pump(tab, 120, 0)
        print(f"    hub: x={tab.js('window.__vj.playerX()')} y={tab.js('window.__vj.playerY()')}")
        # UP must be HELD, and held longer here than in the node core test: 20
        # frames is enough when we own every frame, but the page's rAF loop
        # interleaves its own, and the measured threshold in the page is ~90.
        # Each hold is its own CDP call rather than one long synchronous JS
        # block: a single blocking block starves the rAF loop entirely, and the
        # hold then behaves differently from the one a real key-hold produces.
        #
        # This has to be ADAPTIVE, not a fixed script. Unlike the node core test,
        # the page is not frame-deterministic: its rAF loop advances the game by
        # a variable number of frames before the scripted run even starts (0 and
        # 10 both observed), so Kirby's sub-pixel position in the hub differs
        # between runs even when pixelX/pixelY read the same. A fixed "hold UP
        # here" therefore passed on some runs and failed on others. Sweep
        # instead: hold UP, and if that did not open a door, nudge along the map
        # and try again. That is what a player does.
        gs = tab.js("window.__vj.gameState()")
        for i in range(20):
            if gs == GAME_STATE_STAGE:
                break
            pump(tab, 90, KEY["UP"])
            gs = tab.js("window.__vj.gameState()")
            if gs == GAME_STATE_STAGE:
                break
            # B first: harmless in the hub, and it backs out of a menu if one
            # somehow opened, so a stuck run can recover instead of burning
            # every remaining attempt against a paused game.
            pump(tab, 5, KEY["B"])
            pump(tab, 25, KEY["RIGHT"] if i % 2 == 0 else KEY["LEFT"])
            pump(tab, 40, 0)
            gs = tab.js("window.__vj.gameState()")
        print(f"    entered after {i + 1} attempt(s); "
              f"x={tab.js('window.__vj.playerX()')} y={tab.js('window.__vj.playerY()')}")
        check(gs == GAME_STATE_STAGE,
              f"reached GAME_STATE_STAGE (8), inside a level (gGameState={gs})")
        pump(tab, 480, 0)
        if a.shots:
            tab.screenshot(a.shots / "01-stage.png")

        # ---------------------------------------------------------------- 6
        print("\n6. verified movement under our input")
        idle = tab.js("window.__vj.playerX()")
        pump(tab, 60, 0)
        check(tab.js("window.__vj.playerX()") == idle,
              f"Kirby is at rest with no input (pixelX={idle}) -- so a later move means something")
        track = [tab.js("window.__vj.playerX()")]
        for _ in range(8):
            pump(tab, 30, KEY["RIGHT"])
            track.append(tab.js("window.__vj.playerX()"))
        moved_r = track[-1] - track[0]
        print("    pixelX holding RIGHT: " + " -> ".join(str(v) for v in track))
        check(moved_r > 40, f"moved {moved_r}px right under held RIGHT")
        if a.shots:
            tab.screenshot(a.shots / "02-moved-right.png")
        back = [tab.js("window.__vj.playerX()")]
        for _ in range(5):
            pump(tab, 30, KEY["LEFT"])
            back.append(tab.js("window.__vj.playerX()"))
        moved_l = back[-1] - back[0]
        print("    pixelX holding LEFT:  " + " -> ".join(str(v) for v in back))
        check(moved_l < -40, f"moved {moved_l}px back under held LEFT")
        check(tab.js("window.__vj.gameState()") == GAME_STATE_STAGE,
              "still in GAME_STATE_STAGE throughout the movement test")
        print(f"    health={tab.js('window.__vj.health()')} lives={tab.js('window.__vj.lives()')}")

        # ---------------------------------------------------------------- 7
        print("\n7. the picture, measured by the driver (not by the page)")
        shot = (a.shots / "03-measured.png") if a.shots else pathlib.Path("/tmp/knidl-shot.png")
        tab.screenshot(shot)
        # pngstat.luma() takes the box as FRACTIONS of the image, so convert the
        # canvas's CSS rect through the viewport. Cropping matters: scoring the
        # whole screenshot would count the page's dark chrome as "picture".
        box = json.loads(tab.js(
            "(function(){var r=document.getElementById('canvas').getBoundingClientRect();"
            "var W=innerWidth,H=innerHeight;return JSON.stringify("
            "[r.left/W, r.top/H, r.right/W, r.bottom/H]);})()"))
        full = pngstat.luma(str(shot))
        crop = pngstat.luma(str(shot), box=box)
        print(f"    canvas box (fractions) {[round(v,3) for v in box]}")
        print(f"    whole screenshot: {full}")
        print(f"    canvas only:      {crop}")
        check(crop["mean"] > 5.0,
              f"the driver's own screenshot of the canvas is not black (mean luma {crop['mean']})")
        check(crop["lit"] > 0.5,
              f"most of the canvas is lit, not a few bright pixels (lit fraction {crop['lit']})")

        # ---------------------------------------------------------------- 8
        print("\n8. audio")
        check(tab.js("window.__vj.audioContextExists()") is False,
              "no AudioContext object exists at all -- muted by absence, not by a zero gain")

        # ---------------------------------------------------------------- 9
        print("\n9. the battery save survives a real page reload")
        save_hash = tab.js("window.__vj.saveHash()")
        before = tab.js("JSON.stringify(window.__vj.readSaveBytes(64))")
        tab.js("window.__vj.flushSave()", await_promise=True)
        nz = tab.js("(function(){var b=window.__vj.readSaveBytes(64);"
                    "return b.filter(function(v){return v!==0;}).length;})()")
        check(nz > 0, f"the game has written its own SRAM ({nz}/64 leading bytes non-zero)")

        stored_before = read_stored_save(tab)
        check(stored_before is not None and len(stored_before) == 32768,
              f"a 32 KiB save record is in IndexedDB ({len(stored_before or [])} bytes)")

        tab.goto(f"{base}?nonce={nonce}")
        for _ in range(240):
            if tab.js("!!(window.__vj && window.__vj.ready)"):
                break
            time.sleep(0.25)
        # Read the PERSISTED record, not the live buffer: comparing live buffers
        # across a reload is a race, because the core rewrites SRAM within
        # seconds of boot.
        stored_after = read_stored_save(tab)
        same = (stored_before is not None and stored_after == stored_before)
        check(same, "the stored save record is byte-identical after a real reload")
        for _ in range(240):
            if tab.js("window.__vj.running === true"):
                break
            time.sleep(0.25)
        check(tab.js("window.__vj.running === true"),
              "the ROM resumed from the local cache after reload, with no second pick")

        # --- the negative control that makes the above worth anything ------
        print("\n9b. negative control: the same assertion must FAIL with no record")
        tab.js("(function(){var r=indexedDB.open('knidl-web',1);"
               "r.onsuccess=function(e){var db=e.target.result;"
               "db.transaction('blobs','readwrite').objectStore('blobs').delete('save:A7KE');};})()")
        time.sleep(1.5)
        stored_gone = read_stored_save(tab)
        check(stored_gone is None,
              "with the record deleted the detector reports nothing stored "
              "(so a pass above was not vacuous)")

        # --------------------------------------------------------------- 10
        print("\n10. page health")
        lines = tab.console()
        bad = [l for l in lines if "[exception]" in l
               or ("error" in l.lower() and "Content-Security-Policy" not in l
                   and "example.com" not in l)]
        for l in bad[:6]:
            print("    " + l)
        check(not bad, f"no uncaught page errors ({len(lines)} console lines, "
                       "CSP-violation notices expected and ignored)")

    finally:
        if chrome:
            chrome.kill()
        srv.terminate()
        try:
            srv.wait(timeout=5)
        except Exception:
            srv.kill()

    npass = sum(1 for ok, _ in results if ok)
    print(f"\n{npass}/{len(results)} checks passed")
    return 0 if npass == len(results) else 1


def read_stored_save(tab):
    """Hash-free read of the persisted save record, as a list of ints."""
    js = """
    new Promise(function (res) {
      var r = indexedDB.open('knidl-web', 1);
      r.onupgradeneeded = function (e) {
        try { e.target.result.createObjectStore('blobs'); } catch (x) {}
      };
      r.onerror = function () { res(null); };
      r.onsuccess = function (e) {
        var db = e.target.result;
        var g;
        try { g = db.transaction('blobs', 'readonly').objectStore('blobs').get('save:A7KE'); }
        catch (x) { res(null); return; }
        g.onerror = function () { res(null); };
        g.onsuccess = function () {
          if (!g.result) { res(null); return; }
          var u = new Uint8Array(g.result);
          var s = 0; for (var i = 0; i < u.length; i++) { s = (s * 31 + u[i]) >>> 0; }
          res(JSON.stringify({ len: u.length, sum: s }));
        };
      };
    })"""
    v = tab.js(js, await_promise=True, timeout=30)
    if not v:
        return None
    d = json.loads(v)
    return _Rec(d["len"], d["sum"])


class _Rec:
    """Length + rolling hash of a stored record; comparable and len()-able."""
    def __init__(self, n, s):
        self.n, self.s = n, s

    def __len__(self):
        return self.n

    def __eq__(self, other):
        return isinstance(other, _Rec) and (self.n, self.s) == (other.n, other.s)

    def __repr__(self):
        return f"<{self.n} bytes, sum {self.s}>"


if __name__ == "__main__":
    sys.exit(main())
