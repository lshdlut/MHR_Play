#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

from local_config import repo_root_from_here


COMMON_TEST_ARGS = [
    "tools/run_node.py",
    "--test",
    "tests/tooling/repo_contracts.test.mjs",
    "tests/tooling/entry_boundary.test.mjs",
    "tests/tooling/runtime_config.test.mjs",
    "tests/tooling/asset_bundle_loader.test.mjs",
    "tests/tooling/asset_preprocess.test.mjs",
]


def run(repo_root: Path, *args: str) -> None:
    subprocess.run([sys.executable, *args], cwd=repo_root, check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--artifact", default="dist/site")
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    artifact_root = (repo_root / args.artifact).resolve()

    run(repo_root, *COMMON_TEST_ARGS)
    run(repo_root, "tools/build_demo_bundle.py")
    run(repo_root, "tools/build_wasm_runtime.py")
    run(repo_root, "tools/export_site.py", "--out", args.artifact)

    required_paths = [
        artifact_root / "index.html",
        artifact_root / "embed.html",
        artifact_root / "worker" / "mhr_runtime_wasm.gen.mjs",
        artifact_root / "demo_assets" / "manifest.json",
    ]
    for required_path in required_paths:
        if not required_path.exists():
            raise FileNotFoundError(f"Missing exported artifact path: {required_path}")

    forbidden_paths = [
        artifact_root / "mjwp_inject",
        artifact_root / "native",
        artifact_root / "tests",
        artifact_root / "tools",
        artifact_root / "doc",
    ]
    for forbidden_path in forbidden_paths:
        if forbidden_path.exists():
            raise RuntimeError(f"Exported site contains dev-only content: {forbidden_path}")

    server = subprocess.Popen(
        [
            sys.executable,
            "tools/dev_server.py",
            "--root",
            str(artifact_root),
            "--port",
            str(args.port),
        ],
        cwd=repo_root,
    )
    try:
        time.sleep(1.0)
        run(repo_root, "tools/browser_smoke.py", f"http://127.0.0.1:{args.port}")
    finally:
        server.terminate()
        server.wait(timeout=10)

    print(f"Release check passed for {artifact_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
