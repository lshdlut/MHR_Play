#!/usr/bin/env python3
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


DEFAULT_WINDOWS_NODE = Path(r"C:\Program Files\nodejs\node.exe")
EMSDK_NODE_ROOT = Path(r"C:\emsdk\node")


def resolve_node() -> str:
    env_value = os.environ.get("NODE_EXE", "").strip()
    if env_value:
        candidate = Path(env_value)
        if candidate.exists():
            return str(candidate)

    node_on_path = shutil.which("node")
    if node_on_path:
        return node_on_path

    if DEFAULT_WINDOWS_NODE.exists():
        return str(DEFAULT_WINDOWS_NODE)

    if EMSDK_NODE_ROOT.exists():
        matches = sorted(EMSDK_NODE_ROOT.glob("*/bin/node.exe"), reverse=True)
        if matches:
            return str(matches[0])

    raise SystemExit(
        "Node executable not found. Set NODE_EXE or install Node at the default Windows location."
    )


def main() -> int:
    node_exe = resolve_node()
    if len(sys.argv) <= 1:
        raise SystemExit("Usage: python tools/run_node.py <node-args...>")

    result = subprocess.run([node_exe, *sys.argv[1:]], check=False)
    return int(result.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
