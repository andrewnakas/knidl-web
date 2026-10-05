#!/usr/bin/env python3
"""Serve web/dist for local play and for the headless test.

    python3 tools/serve.py [port]

Port 0 (the default) binds an ephemeral port and prints it, so two agents on
this box can never collide on a fixed one.

Threaded, because a single-threaded handler deadlocks the moment the page asks
for the 663 KB core while another request is still open.

There is deliberately NO way to hand the ROM to the page over HTTP: the test
feeds it through the real <input type=file> over the DevTools protocol, so the
path under test is the one a user gets. Nothing outside web/dist is reachable.
"""
import argparse
import functools
import http.server
import pathlib
import socketserver
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "web" / "dist"


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *a):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("port", nargs="?", type=int, default=0)
    a = ap.parse_args()
    if not ROOT.is_dir():
        print(f"no such directory: {ROOT} (run `make` in web/ first)", file=sys.stderr)
        return 1
    h = functools.partial(Handler, directory=str(ROOT))
    with Server(("127.0.0.1", a.port), h) as srv:
        print(f"PORT {srv.server_address[1]}", flush=True)
        srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
