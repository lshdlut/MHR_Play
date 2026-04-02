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


def wait_for_condition(
    repo_root: Path,
    npx_path: Path,
    session: str,
    source: str,
    predicate,
    timeout_s: float,
) -> object:
    deadline = time.time() + max(timeout_s, 0.1)
    last_payload = None
    while time.time() < deadline:
        payload = eval_js(repo_root, npx_path, session, source)
        last_payload = payload
        if predicate(payload):
            return payload
        time.sleep(0.2)
    raise TimeoutError(f"Timed out waiting for condition. Last payload: {last_payload}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base_url", help="base URL for the local mjwp_inject server")
    parser.add_argument("--session", default="mhr-mjwp-smoke")
    parser.add_argument("--browser", default="msedge")
    parser.add_argument("--lod", type=int, default=1)
    parser.add_argument("--switch-to-lod", type=int, default=None)
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
        f"{args.base_url.rstrip('/')}/mhr.html?lod={int(args.lod)}",
        "--browser",
        args.browser,
    )

    js = (
        "() => JSON.stringify({"
        " title: document.title,"
        " profile: document.documentElement?.getAttribute('data-play-profile') ?? '',"
        " requestedLod: Number(new URL(window.location.href).searchParams.get('lod') || 0),"
        " visualSourceMode: window.__PLAY_HOST__?.store?.get?.()?.visualSourceMode ?? '',"
        " controlCount: document.querySelectorAll('[data-testid=\"section-plugin:mhr-control\"]').length,"
        " scaleCount: document.querySelectorAll('[data-testid=\"section-plugin:mhr-scale\"]').length,"
        " expressionCount: document.querySelectorAll('[data-testid=\"section-plugin:mhr-expression\"]').length,"
        " controlActionRows: document.querySelectorAll('.mhr-control-action-row').length,"
        " controlBoolRows: document.querySelectorAll('.mhr-control-bool-row').length,"
        " hasLodSelect: !!document.querySelector('[data-testid=\"mhr-lod-select\"]'),"
        " hasFreeExpression: !!document.querySelector('[data-testid=\"mhr-free-expression\"]'),"
        " jointAxesShareRow: (() => {"
        "   const labelsRow = document.querySelector('[data-testid=\"mhr-joint-labels\"]')?.closest('.mhr-control-bool-row');"
        "   const axesRow = document.querySelector('[data-testid=\"mhr-joint-axes\"]')?.closest('.mhr-control-bool-row');"
        "   return !!labelsRow && labelsRow === axesRow;"
        " })(),"
        " hasFreeBlendWarningRow: (() => {"
        "   const rows = Array.from(document.querySelectorAll('[data-testid=\"section-plugin:mhr-control\"] .control-static'));"
        "   return rows.some((row) => String(row.textContent || '').includes('Free blend and free expression can be unsettling.'));"
        " })(),"
        " hasHost: !!window.__PLAY_HOST__,"
        " hasBackend: !!window.__PLAY_HOST__?.backend,"
        " hasMesh: !!window.__renderCtx?.scene?.getObjectByName?.('mhr-profile:mesh'),"
        " hasService: !!(window.__PLAY_HOST__?.services?.mhr ?? window.__PLAY_HOST__?.extensions?.mhr?.service),"
        " geom: Number(window.__PLAY_HOST__?.getSnapshot?.()?.scn_ngeom || 0),"
        " assetLod: Number((window.__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.())?.mhr?.assets?.lod ?? -1),"
        " derivedLod: Number((window.__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.())?.mhr?.evaluation?.derived?.lod ?? -1),"
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
            and int(payload.get("requestedLod", -1)) == int(args.lod)
            and payload.get("visualSourceMode") == "preset-sun"
            and payload.get("hasLodSelect")
            and payload.get("hasFreeExpression")
            and payload.get("jointAxesShareRow")
            and payload.get("hasFreeBlendWarningRow")
            and payload.get("hasHost")
            and payload.get("hasBackend")
            and payload.get("hasService")
            and payload.get("hasMesh")
            and int(payload.get("assetLod", -1)) == int(args.lod)
            and int(payload.get("derivedLod", -1)) == int(args.lod)
            and int(payload.get("controlActionRows", 0)) >= 1
            and int(payload.get("controlBoolRows", 0)) >= 1
            and int(payload.get("vertexCount", 0)) > 0
            and int(payload.get("jointCount", 0)) > 0
            and int(payload.get("controlCount", 0)) == 1
            and int(payload.get("scaleCount", 0)) == 1
            and int(payload.get("expressionCount", 0)) == 1
        ):
            eval_js(
                repo_root,
                npx_path,
                args.session,
                (
                    "() => JSON.stringify({"
                    " clicked: (() => {"
                    "   const root = document.querySelector('[data-testid=\"mhr-joint-labels\"]');"
                    "   if (!root) return false;"
                    "   const input = root.matches('input[type=\"checkbox\"]') ? root : root.querySelector('input[type=\"checkbox\"]');"
                    "   if (input && !input.checked) { input.click(); return true; }"
                    "   const button = root.matches('button,[role=\"button\"]') ? root : root.querySelector('button,[role=\"button\"]');"
                    "   if (button && String(button.getAttribute('aria-pressed') || '').toLowerCase() !== 'true') { button.click(); return true; }"
                    "   return true;"
                    " })()"
                    "})"
                ),
            )
            label_payload = wait_for_condition(
                repo_root,
                npx_path,
                args.session,
                (
                    "() => JSON.stringify({"
                    " labelsDrawn: Number(window.__PLAY_HOST__?.renderer?.getContext?.()?.labelOverlay?.mhrJointLabelsDrawn || 0),"
                    " sample: window.__PLAY_HOST__?.renderer?.getContext?.()?.labelOverlay?.mhrJointLabelsSample || null"
                    "})"
                ),
                lambda value: isinstance(value, dict) and int(value.get("labelsDrawn", 0)) > 0,
                timeout_s=8.0,
            )
            payload["jointLabelsDrawn"] = int(label_payload.get("labelsDrawn", 0))
            payload["jointLabelsSample"] = label_payload.get("sample")
            if args.switch_to_lod is not None and int(args.switch_to_lod) != int(args.lod):
                eval_js(
                    repo_root,
                    npx_path,
                    args.session,
                    (
                        "() => JSON.stringify({"
                        f" requested: {int(args.switch_to_lod)},"
                        " switched: (() => {"
                        "   const select = document.querySelector('[data-testid=\"mhr-lod-select\"]');"
                        "   if (!select) return false;"
                        f"   select.value = String({int(args.switch_to_lod)});"
                        "   select.dispatchEvent(new Event('change', { bubbles: true }));"
                        "   return true;"
                        " })()"
                        "})"
                    ),
                )
                switched_payload = wait_for_condition(
                    repo_root,
                    npx_path,
                    args.session,
                    js,
                    lambda value: (
                        isinstance(value, dict)
                        and value.get("profile") == "mhr"
                        and int(value.get("requestedLod", -1)) == int(args.switch_to_lod)
                        and value.get("visualSourceMode") == "preset-sun"
                        and value.get("hasLodSelect")
                        and value.get("hasFreeExpression")
                        and value.get("jointAxesShareRow")
                        and value.get("hasFreeBlendWarningRow")
                        and value.get("hasHost")
                        and value.get("hasBackend")
                        and value.get("hasService")
                        and value.get("hasMesh")
                        and int(value.get("assetLod", -1)) == int(args.switch_to_lod)
                        and int(value.get("derivedLod", -1)) == int(args.switch_to_lod)
                        and int(value.get("expressionCount", 0)) == 1
                        and int(value.get("vertexCount", 0)) > 0
                        and int(value.get("jointCount", 0)) > 0
                    ),
                    timeout_s=max(12.0, args.timeout_s),
                )
                switched_label_payload = wait_for_condition(
                    repo_root,
                    npx_path,
                    args.session,
                    (
                        "() => JSON.stringify({"
                        " labelsDrawn: Number(window.__PLAY_HOST__?.renderer?.getContext?.()?.labelOverlay?.mhrJointLabelsDrawn || 0),"
                        " sample: window.__PLAY_HOST__?.renderer?.getContext?.()?.labelOverlay?.mhrJointLabelsSample || null"
                        "})"
                    ),
                    lambda value: isinstance(value, dict) and int(value.get("labelsDrawn", 0)) > 0,
                    timeout_s=8.0,
                )
                switched_payload["jointLabelsDrawn"] = int(switched_label_payload.get("labelsDrawn", 0))
                switched_payload["jointLabelsSample"] = switched_label_payload.get("sample")
                print(json.dumps({
                    "ok": True,
                    "payload": switched_payload,
                    "initialPayload": payload,
                }))
            else:
                print(json.dumps({"ok": True, "payload": payload}))
            run_cli(repo_root, npx_path, args.session, "close")
            return 0
        time.sleep(0.5)

    run_cli(repo_root, npx_path, args.session, "close")
    raise TimeoutError(f"Timed out waiting for injected MHR page readiness. Last payload: {last_payload}")


if __name__ == "__main__":
    raise SystemExit(main())
