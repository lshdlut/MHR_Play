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
        encoding="utf-8",
        errors="replace",
        env=env,
    )
    return result.stdout


def eval_js(repo_root: Path, npx_path: Path, session: str, source: str) -> object:
    output = run_cli(repo_root, npx_path, session, "eval", source)
    match = re.search(r"### Result\s*(.+?)\s*### Ran Playwright code", output, re.S)
    if not match:
        raise RuntimeError(f"Unable to parse Playwright eval output:\n{output}")
    payload = json.loads(match.group(1).strip())
    return json.loads(payload) if isinstance(payload, str) else payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base_url", help="base URL for the local mjwp_inject server")
    parser.add_argument("--session", default="mhr-mjwp-smoke")
    parser.add_argument("--browser", default="msedge")
    parser.add_argument("--timeout-s", type=float, default=90.0)
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
        f"{args.base_url.rstrip('/')}/mhr.html",
        "--browser",
        args.browser,
    )

    js = (
        "() => JSON.stringify({"
        " title: document.title,"
        " profile: document.documentElement?.getAttribute('data-play-profile') ?? '',"
        " controlCount: document.querySelectorAll('[data-testid=\"section-plugin:mhr-control\"]').length,"
        " scaleCount: document.querySelectorAll('[data-testid=\"section-plugin:mhr-scale\"]').length,"
        " hasHost: !!window.__PLAY_HOST__,"
        " hasBackend: !!window.__PLAY_HOST__?.backend,"
        " hasMesh: !!window.__renderCtx?.scene?.getObjectByName?.('mhr-profile:mesh'),"
        " hasService: !!(window.__PLAY_HOST__?.services?.mhr ?? window.__PLAY_HOST__?.extensions?.mhr?.service),"
        " geom: Number(window.__PLAY_HOST__?.getSnapshot?.()?.scn_ngeom || 0),"
        " vertexCount: Number((window.__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.())?.mhr?.evaluation?.mesh?.vertexCount || 0),"
        " jointCount: Number((window.__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.())?.mhr?.evaluation?.skeleton?.jointCount || 0)"
        "})"
    )

    deadline = time.time() + max(args.timeout_s, 1.0)
    last_payload: dict[str, object] | None = None
    while time.time() < deadline:
        payload = eval_js(repo_root, npx_path, args.session, js)
        if not isinstance(payload, dict):
            raise RuntimeError(f"Unexpected smoke payload: {payload!r}")
        last_payload = payload
        if (
            payload.get("profile") == "mhr"
            and payload.get("hasHost")
            and payload.get("hasBackend")
            and payload.get("hasService")
            and payload.get("hasMesh")
            and int(payload.get("vertexCount", 0)) > 0
            and int(payload.get("jointCount", 0)) > 0
            and int(payload.get("controlCount", 0)) == 1
            and int(payload.get("scaleCount", 0)) == 1
        ):
            print(json.dumps({"ok": True, "payload": payload}))
            run_cli(repo_root, npx_path, args.session, "close")
            return 0
        time.sleep(0.5)

    run_cli(repo_root, npx_path, args.session, "close")
    raise TimeoutError(f"Timed out waiting for injected MHR page readiness. Last payload: {last_payload}")


if __name__ == "__main__":
    raise SystemExit(main())
