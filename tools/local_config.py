from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


LOCAL_CONFIG_FILE = ".repo_local_config.json"


def repo_root_from_here(here: str | Path) -> Path:
    return Path(here).resolve().parents[1]


def load_local_config(repo_root: Path) -> dict[str, Any]:
    config_path = repo_root / LOCAL_CONFIG_FILE
    if not config_path.exists():
        return {}
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{LOCAL_CONFIG_FILE} must contain a JSON object.")
    return payload


def resolve_config_value(
    *,
    env_key: str,
    config: dict[str, Any],
    config_key: str,
    default: str = "",
) -> str:
    env_value = os.environ.get(env_key, "").strip()
    if env_value:
        return env_value
    config_value = str(config.get(config_key, "")).strip()
    if config_value:
        return config_value
    return default


def resolve_python_executable(repo_root: Path, config: dict[str, Any] | None = None) -> str:
    payload = config if config is not None else load_local_config(repo_root)
    return resolve_config_value(
        env_key="PYTHON_EXE",
        config=payload,
        config_key="python_exe",
        default=sys.executable,
    )


def resolve_mhr_reference_root(repo_root: Path, config: dict[str, Any] | None = None) -> Path | None:
    payload = config if config is not None else load_local_config(repo_root)
    value = resolve_config_value(
        env_key="MHR_REF_ROOT",
        config=payload,
        config_key="mhr_ref_root",
    )
    return Path(value).expanduser().resolve() if value else None


def resolve_mhr_asset_root(repo_root: Path, config: dict[str, Any] | None = None) -> Path | None:
    payload = config if config is not None else load_local_config(repo_root)
    value = resolve_config_value(
        env_key="MHR_ASSET_ROOT",
        config=payload,
        config_key="mhr_asset_root",
    )
    if value:
        return Path(value).expanduser().resolve()

    ref_root = resolve_mhr_reference_root(repo_root, payload)
    if ref_root is None:
        return None
    candidate = ref_root / "assets"
    return candidate.resolve() if candidate.exists() else None
