from __future__ import annotations

import json
import os
import sys
import tempfile
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


def python_has_exact_runtime_kernels(python_executable: str | Path) -> bool:
    python_path = Path(python_executable).expanduser().resolve()
    library_bin = python_path.parent / "Library" / "bin"
    if not library_bin.exists():
        return False
    has_mkl = any((library_bin / filename).exists() for filename in ("mkl_rt.2.dll", "mkl_rt.dll"))
    has_cblas = (library_bin / "libcblas.dll").exists()
    return has_mkl and has_cblas


def _candidate_python_executables() -> list[Path]:
    home = Path.home()
    candidates = [
        home / "miniforge3" / "envs" / "myconda" / "python.exe",
        home / "miniforge3" / "python.exe",
        home / "miniconda3" / "envs" / "myconda" / "python.exe",
        home / "miniconda3" / "python.exe",
        home / "anaconda3" / "envs" / "myconda" / "python.exe",
        home / "anaconda3" / "python.exe",
    ]
    for root_name in ("miniforge3", "miniconda3", "anaconda3"):
        env_root = home / root_name / "envs"
        if not env_root.exists():
            continue
        for env_path in sorted(env_root.iterdir()):
            candidates.append(env_path / "python.exe")
    return candidates


def resolve_exact_runtime_python_executable(
    repo_root: Path,
    config: dict[str, Any] | None = None,
) -> str:
    payload = config if config is not None else load_local_config(repo_root)
    resolved = resolve_python_executable(repo_root, payload)
    candidates: list[Path] = [Path(resolved).expanduser()]
    candidates.extend(_candidate_python_executables())

    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        if candidate.exists() and python_has_exact_runtime_kernels(candidate):
            return str(candidate.resolve())
    return resolved


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
        temp_candidate = Path(tempfile.gettempdir()) / "mhr-official-assets" / "assets"
        return temp_candidate.resolve() if temp_candidate.exists() else None
    candidate = ref_root / "assets"
    return candidate.resolve() if candidate.exists() else None


def official_bundle_dir(repo_root: Path, lod: int) -> Path:
    return repo_root / "local_tools" / "official_bundle" / f"lod{int(lod)}"


def official_bundle_manifest_path(repo_root: Path, lod: int) -> Path:
    return official_bundle_dir(repo_root, lod) / "manifest.json"


def official_runtime_ir_dir(repo_root: Path, lod: int) -> Path:
    return repo_root / "local_tools" / "official_runtime_ir" / f"lod{int(lod)}"


def official_runtime_ir_manifest_path(repo_root: Path, lod: int) -> Path:
    return official_runtime_ir_dir(repo_root, lod) / "manifest.json"
