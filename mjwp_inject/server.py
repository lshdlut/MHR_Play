#!/usr/bin/env python3
from __future__ import annotations

import argparse
import http.server
import mimetypes
import os
from pathlib import Path


class MountedHandler(http.server.SimpleHTTPRequestHandler):
    mounts: dict[str, Path] = {}

    def _has_header(self, name: str) -> bool:
        prefix = (name + ":").lower().encode("latin-1")
        for line in getattr(self, "_headers_buffer", []):
            if isinstance(line, (bytes, bytearray)) and line.lower().startswith(prefix):
                return True
        return False

    def translate_path(self, path: str) -> str:  # type: ignore[override]
        cleaned = path.split("?", 1)[0].split("#", 1)[0]
        for prefix, root in self.mounts.items():
            if cleaned == prefix.rstrip("/") or cleaned.startswith(prefix):
                rel = cleaned[len(prefix):].lstrip("/")
                return str((root / rel).resolve())
        return super().translate_path(path)

    def end_headers(self) -> None:  # type: ignore[override]
        if not self._has_header("X-Content-Type-Options"):
            self.send_header("X-Content-Type-Options", "nosniff")
        if not self._has_header("Cache-Control"):
            self.send_header("Cache-Control", "public, max-age=0, must-revalidate")
        super().end_headers()

    def guess_type(self, path: str) -> str:  # type: ignore[override]
        target = path.split("?", 1)[0].split("#", 1)[0]
        ext = Path(target).suffix.lower()
        if ext in (".mjs", ".js"):
            return "text/javascript; charset=utf-8"
        if ext == ".wasm":
            return "application/wasm"
        ctype = mimetypes.types_map.get(ext)
        if ctype is None:
            return "application/octet-stream"
        if ctype.startswith("text/") and "charset=" not in ctype:
            ctype += "; charset=utf-8"
        return ctype

    def send_head(self):  # type: ignore[override]
        cleaned = self.path.split("?", 1)[0].split("#", 1)[0]
        path = self.translate_path(cleaned)
        ext = Path(path).suffix.lower()
        force_ok = ext in (".mjs", ".js", ".wasm")
        if not force_ok:
            return super().send_head()
        if os.path.isdir(path):
            for index in ("index.html", "index.htm"):
                index_path = os.path.join(path, index)
                if os.path.exists(index_path):
                    path = index_path
                    break
        if not os.path.exists(path):
            self.send_error(404, "File not found")
            return None
        try:
            handle = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        stat = os.fstat(handle.fileno())
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        return handle


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--forge-root", default="")
    parser.add_argument("--official-root", default="")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    repo_root = Path(args.repo_root).resolve()
    forge_root = Path(args.forge_root).resolve() if args.forge_root else None
    official_root = Path(args.official_root).resolve() if args.official_root else (repo_root / "local_tools" / "official_runtime_ir")

    os.chdir(root)
    mounts: dict[str, Path] = {
        "/mhr-official/": official_root,
    }
    if forge_root and forge_root.exists():
        mounts["/forge/"] = forge_root
    MountedHandler.mounts = mounts

    server = http.server.ThreadingHTTPServer(("", args.port), MountedHandler)
    print(f"Serving {root} on http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
