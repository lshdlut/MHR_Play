#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from local_config import load_local_config, repo_root_from_here, resolve_mhr_asset_root
from mhr_reference import (
    OFFICIAL_ORACLE_KIND,
    build_parameter_metadata,
    evaluate_state_patch,
    load_case_manifest,
    load_torchscript_model,
)


def save_case_outputs(case_dir: Path, result: dict) -> None:
    case_dir.mkdir(parents=True, exist_ok=True)
    np.save(case_dir / "vertices.npy", result["vertices"])
    np.save(case_dir / "skeleton_state.npy", result["skeleton_state"])
    (case_dir / "derived.json").write_text(
        json.dumps(result["derived"], indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cases",
        default="tests/golden_cases/manifest.json",
        help="path to the golden case manifest",
    )
    parser.add_argument(
        "--out",
        default="local_tools/mhr_parity/ref_py",
        help="output directory for oracle artifacts",
    )
    parser.add_argument("--asset-root", help="path to official MHR assets")
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    config = load_local_config(repo_root)
    asset_root = Path(args.asset_root).resolve() if args.asset_root else resolve_mhr_asset_root(repo_root, config)
    if asset_root is None:
        raise SystemExit(
            "Oracle generation requires --asset-root or MHR_ASSET_ROOT / .repo_local_config.json."
        )

    case_manifest_path = Path(args.cases).resolve()
    case_manifest = load_case_manifest(case_manifest_path)
    cases = case_manifest.get("cases")
    if not isinstance(cases, list) or not cases:
        raise SystemExit("Golden case manifest requires a non-empty cases list.")

    model = load_torchscript_model(asset_root)
    parameter_metadata = build_parameter_metadata(model)
    out_root = Path(args.out).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    report = {
        "oracle": OFFICIAL_ORACLE_KIND,
        "assetRoot": str(asset_root),
        "cases": [],
    }

    for entry in cases:
        if not isinstance(entry, dict):
            raise ValueError("Golden case entries must be objects.")
        case_id = str(entry.get("id", "")).strip()
        case_path = case_manifest_path.parent / str(entry.get("path", "")).strip()
        if not case_id or not case_path.exists():
            raise ValueError(f"Invalid golden case entry: {entry}")
        case_payload = json.loads(case_path.read_text(encoding="utf-8"))
        state = case_payload.get("state", {})
        result = evaluate_state_patch(model, parameter_metadata, state)
        save_case_outputs(out_root / case_id, result)
        report["cases"].append(
            {
                "id": case_id,
                "path": str(case_path),
                "derived": result["derived"],
            }
        )

    (out_root / "report.json").write_text(
        json.dumps(report, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote oracle outputs to {out_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
