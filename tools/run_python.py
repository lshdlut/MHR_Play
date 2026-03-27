#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys

from pathlib import Path

from local_config import load_local_config, repo_root_from_here, resolve_python_executable


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--print-exe", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    config = load_local_config(repo_root)
    python_executable = resolve_python_executable(repo_root, config)

    if args.print_exe:
        print(python_executable)
        return 0

    command = list(args.command)
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        raise SystemExit("run_python.py requires a command after the wrapper.")

    completed = subprocess.run([python_executable, *command], cwd=repo_root)
    return int(completed.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
