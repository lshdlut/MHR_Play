#!/usr/bin/env python3
from __future__ import annotations

import argparse
import http.server
import mimetypes
import os


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path: str) -> str:  # type: ignore[override]
        normalized = path.split("?", 1)[0].split("#", 1)[0]
        _base, ext = os.path.splitext(normalized)
        ext = ext.lower()
        if ext in (".mjs", ".js"):
            return "text/javascript; charset=utf-8"
        if ext == ".wasm":
            return "application/wasm"
        guessed = mimetypes.types_map.get(ext)
        if guessed is None:
            return "application/octet-stream"
        if guessed.startswith("text/") and "charset=" not in guessed:
            return guessed + "; charset=utf-8"
        return guessed

    def end_headers(self) -> None:  # type: ignore[override]
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "public, max-age=0, must-revalidate")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".", help="directory to serve")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    os.chdir(root)
    httpd = http.server.ThreadingHTTPServer(("", args.port), Handler)
    print(f"Serving {root} on http://localhost:{args.port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
