#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from mhr_full_reference import (
    OFFICIAL_FULL_CPU_ORACLE_KIND,
    build_random_raw_inputs,
    collect_full_stage_outputs,
    load_full_model,
    repo_root,
    save_stage_outputs,
    write_oracle_manifest,
)
from mhr_reference import build_raw_inputs, load_case_manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="output directory for oracle artifacts")
    parser.add_argument("--manifest", default="local_tools/official_bundle/manifest.json")
    parser.add_argument("--cases", default="tests/golden_cases/manifest.json")
    parser.add_argument("--assets", help="override official asset root")
    parser.add_argument("--lod", type=int, default=1)
    parser.add_argument("--random-seed", type=int, default=0)
    parser.add_argument("--random-batch-size", type=int, default=32)
    args = parser.parse_args()

    root = repo_root()
    out_dir = Path(args.out).resolve()
    processed_manifest = Path(args.manifest).resolve()
    processed_payload = json.loads(processed_manifest.read_text(encoding="utf-8"))
    parameter_metadata = processed_payload["parameterMetadata"]
    counts = parameter_metadata["counts"]

    model, asset_root = load_full_model(root, asset_root=args.assets, lod=args.lod, device="cpu")

    case_manifest = load_case_manifest(Path(args.cases).resolve())
    case_entries = case_manifest.get("cases")
    if not isinstance(case_entries, list) or not case_entries:
        raise ValueError("Golden case manifest requires a non-empty cases list.")

    cases_payload: list[dict[str, object]] = []
    case_base_dir = out_dir / "cases"
    for entry in case_entries:
        case_id = str(entry["id"])
        case_payload = json.loads((Path(args.cases).resolve().parent / str(entry["path"])).read_text(encoding="utf-8"))
        raw_inputs = build_raw_inputs(parameter_metadata, case_payload.get("state", {}))
        stage_outputs = collect_full_stage_outputs(model, raw_inputs)
        case_dir = case_base_dir / case_id
        save_stage_outputs(case_dir, stage_outputs)
        cases_payload.append(
            {
                "id": case_id,
                "batchSize": int(raw_inputs["model_parameters"].shape[0]),
                "path": str(case_dir.relative_to(out_dir).as_posix()),
            }
        )

    random_raw_inputs = build_random_raw_inputs(
        model_parameter_count=int(counts["modelParameterCount"]),
        identity_count=int(counts["identityCount"]),
        expression_count=int(counts["expressionCount"]),
        batch_size=args.random_batch_size,
        seed=args.random_seed,
    )
    random_outputs = collect_full_stage_outputs(model, random_raw_inputs)
    random_dir = out_dir / f"random_batch{args.random_batch_size}_seed{args.random_seed}"
    save_stage_outputs(random_dir, random_outputs)

    write_oracle_manifest(
        out_dir,
        oracle_kind=OFFICIAL_FULL_CPU_ORACLE_KIND,
        asset_root=asset_root,
        lod=args.lod,
        cases=cases_payload,
        random_batches=[
            {
                "id": f"random_batch{args.random_batch_size}_seed{args.random_seed}",
                "batchSize": args.random_batch_size,
                "seed": args.random_seed,
                "path": str(random_dir.relative_to(out_dir).as_posix()),
            }
        ],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
