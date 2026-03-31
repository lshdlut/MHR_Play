#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from pathlib import Path

from local_config import repo_root_from_here


def resolve_npx() -> Path:
    candidates = []
    emsdk_home = os.environ.get("EMSDK_HOME", "").strip()
    if emsdk_home:
        candidates.append(Path(emsdk_home) / "node" / "22.16.0_64bit" / "bin" / "npx.cmd")
    candidates.extend(
        [
            Path(r"C:\emsdk\node\22.16.0_64bit\bin\npx.cmd"),
            Path(r"C:\Program Files\nodejs\npx.cmd"),
        ]
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError("Unable to locate npx.cmd for Playwright CLI.")


def cli_command(npx_path: Path, session: str, *args: str) -> list[str]:
    return [
        str(npx_path),
        "--yes",
        "--package",
        "@playwright/cli",
        "playwright-cli",
        "--session",
        session,
        *args,
    ]


def run_cli(repo_root: Path, npx_path: Path, session: str, *args: str) -> str:
    env = {
        **os.environ,
        "PATH": str(npx_path.parent) + os.pathsep + os.environ.get("PATH", ""),
    }
    result = subprocess.run(
        cli_command(npx_path, session, *args),
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    return result.stdout


def eval_js(repo_root: Path, npx_path: Path, session: str, source: str) -> str:
    output = run_cli(repo_root, npx_path, session, "eval", source)
    match = re.search(r"### Result\s*(.+?)\s*### Ran Playwright code", output, re.S)
    if not match:
        raise RuntimeError(f"Unable to parse Playwright eval output:\n{output}")
    return match.group(1).strip()


def wait_for_text(repo_root: Path, npx_path: Path, session: str, js_source: str, expected: str, timeout_s: float = 30.0) -> str:
    deadline = time.time() + timeout_s
    last_value = ""
    while time.time() < deadline:
        last_value = eval_js(repo_root, npx_path, session, js_source)
        if expected in last_value:
            return last_value
        time.sleep(0.5)
    raise TimeoutError(f"Timed out waiting for {expected!r}. Last value: {last_value}")


def latest_snapshot_file(repo_root: Path) -> Path:
    snapshot_dir = repo_root / ".playwright-cli"
    snapshots = sorted(snapshot_dir.glob("page-*.yml"), key=lambda path: path.stat().st_mtime)
    if not snapshots:
        raise FileNotFoundError("No Playwright snapshot file found.")
    return snapshots[-1]


def find_button_ref(snapshot_path: Path, label: str) -> str:
    pattern = re.compile(rf'button "{re.escape(label)}".*?\[ref=(e\d+)\]')
    match = pattern.search(snapshot_path.read_text(encoding="utf-8"))
    if not match:
        raise RuntimeError(f"Unable to find button {label!r} in {snapshot_path}")
    return match.group(1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base_url", help="base URL for the local/public beta server")
    parser.add_argument("--session", default="mhr-beta-smoke")
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    npx_path = resolve_npx()

    try:
        run_cli(repo_root, npx_path, args.session, "close")
    except subprocess.CalledProcessError:
        pass

    run_cli(
        repo_root,
        npx_path,
        args.session,
        "open",
        f"{args.base_url.rstrip('/')}/index.html",
        "--browser",
        "msedge",
    )

    standalone_status = wait_for_text(
        repo_root,
        npx_path,
        args.session,
        "() => (document.querySelector('[data-mhr-status]')?.textContent ?? '')",
        "evaluated",
    )
    overlay_text = eval_js(
        repo_root,
        npx_path,
        args.session,
        "() => (document.querySelector('[data-mhr-overlay]')?.textContent ?? '')",
    )
    if "joints: 3" not in overlay_text:
        raise RuntimeError(f"Standalone overlay did not expose live runtime counts:\n{overlay_text}")
    vertex_match = re.search(r"vertices:\s*(\d+)", overlay_text)
    if not vertex_match or int(vertex_match.group(1)) < 12:
        raise RuntimeError(f"Standalone overlay still looks trivial:\n{overlay_text}")

    run_cli(repo_root, npx_path, args.session, "snapshot")
    skeleton_ref = find_button_ref(latest_snapshot_file(repo_root), "skeleton")
    run_cli(repo_root, npx_path, args.session, "click", skeleton_ref)
    wait_for_text(
        repo_root,
        npx_path,
        args.session,
        "() => (document.querySelector('[data-mhr-overlay]')?.textContent ?? '')",
        "compareMode: skeleton",
    )

    run_cli(
        repo_root,
        npx_path,
        args.session,
        "open",
        f"{args.base_url.rstrip('/')}/embed.html",
        "--browser",
        "msedge",
    )
    embed_status = wait_for_text(
        repo_root,
        npx_path,
        args.session,
        "() => (document.querySelector('[data-mhr-status]')?.textContent ?? '')",
        "evaluated",
    )
    embed_state_raw = eval_js(
        repo_root,
        npx_path,
        args.session,
        "() => JSON.stringify((() => { const host = window.__MHR_PLAY_EMBED_DEMO__; const snapshot = host?.getSnapshot?.(); return { status: snapshot?.status ?? '', vertexCount: snapshot?.evaluation?.mesh?.vertexCount ?? 0, jointCount: snapshot?.evaluation?.skeleton?.jointCount ?? 0 }; })())",
    )
    embed_state = json.loads(embed_state_raw)
    if isinstance(embed_state, str):
        embed_state = json.loads(embed_state)
    if embed_state.get("status") != "evaluated" or embed_state.get("jointCount") != 3 or int(embed_state.get("vertexCount", 0)) < 12:
        raise RuntimeError(f"Embed state mismatch: {embed_state}")

    destroyed_status = eval_js(
        repo_root,
        npx_path,
        args.session,
        "() => { window.__MHR_PLAY_EMBED_DEMO__.destroy(); return document.querySelector('[data-mhr-status]')?.textContent ?? ''; }",
    )
    if "destroyed" not in destroyed_status:
        raise RuntimeError(f"Embed destroy did not update status: {destroyed_status}")

    print(
        json.dumps(
            {
                "ok": True,
                "standaloneStatus": standalone_status,
                "embedStatus": embed_status,
                "embedState": embed_state,
            }
        )
    )
    run_cli(repo_root, npx_path, args.session, "close")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
