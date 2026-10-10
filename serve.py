"""Serve Pocket Casper on this PC for testing: python serve.py  →  http://localhost:8800

localhost counts as a secure origin, so WebGPU and offline mode work in a desktop browser here.
(A phone needs an HTTPS address instead: see README.md.)
"""
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8800


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")  # always pick up edits while developing
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"Pocket Casper on http://localhost:{PORT}")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
