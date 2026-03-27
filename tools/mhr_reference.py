from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np


OFFICIAL_ORACLE_KIND = "official-torchscript"


def import_torch():
    try:
        import torch
    except ImportError as error:  # pragma: no cover - depends on local env
        raise RuntimeError(
            "Torch is required for official MHR reference tooling. "
            "Set PYTHON_EXE to an environment that provides torch."
        ) from error
    return torch


def load_torchscript_model(asset_root: Path):
    torch = import_torch()
    model_path = asset_root / "mhr_model.pt"
    if not model_path.exists():
        raise FileNotFoundError(f"Official TorchScript model not found: {model_path}")
    model = torch.jit.load(str(model_path), map_location="cpu")
    model.eval()
    return model


def classify_model_parameter(name: str) -> tuple[str, str]:
    if name.startswith("root_"):
        return "root", "curated"
    if name.endswith("_flexible") or name.startswith("scale_"):
        return "skeletalProportion", "grouped"
    return "pose", "grouped"


def build_parameter_metadata(model) -> dict[str, Any]:
    parameter_names = list(model.get_parameter_names())
    parameter_limits = model.get_parameter_limits().detach().cpu().numpy().astype(np.float32)
    identity_count = int(model.get_num_identity_blendshapes())
    expression_count = int(model.get_num_face_expression_blendshapes())
    model_parameter_count = len(parameter_names) - identity_count

    parameters: list[dict[str, Any]] = []
    sections: dict[str, dict[str, int]] = {
        "root": {},
        "pose": {},
        "skeletalProportion": {},
        "surfaceShape": {},
        "expression": {},
    }

    for raw_index, name in enumerate(parameter_names[:model_parameter_count]):
        state_section, tier = classify_model_parameter(name)
        parameters.append(
            {
                "key": name,
                "label": name,
                "domain": "model",
                "stateSection": state_section,
                "tier": tier,
                "rawIndex": raw_index,
                "default": 0.0,
                "min": float(parameter_limits[raw_index, 0]),
                "max": float(parameter_limits[raw_index, 1]),
            }
        )
        sections[state_section][name] = raw_index

    for local_index, name in enumerate(parameter_names[model_parameter_count:]):
        raw_index = model_parameter_count + local_index
        alias = f"blend_{local_index:02d}"
        parameters.append(
            {
                "key": name,
                "label": name,
                "domain": "identity",
                "stateSection": "surfaceShape",
                "tier": "grouped",
                "rawIndex": local_index,
                "default": 0.0,
                "min": float(parameter_limits[raw_index, 0]),
                "max": float(parameter_limits[raw_index, 1]),
            }
        )
        sections["surfaceShape"][name] = local_index
        sections["surfaceShape"][alias] = local_index

    for raw_index in range(expression_count):
        key = f"expression_{raw_index:02d}"
        alt_key = f"expression_{raw_index}"
        parameters.append(
            {
                "key": key,
                "label": key,
                "domain": "expression",
                "stateSection": "expression",
                "tier": "grouped",
                "rawIndex": raw_index,
                "default": 0.0,
                "min": -1.0,
                "max": 1.0,
            }
        )
        sections["expression"][key] = raw_index
        sections["expression"][alt_key] = raw_index

    return {
        "semanticLayers": ["curated", "grouped", "raw"],
        "groups": [
            {"id": "root", "label": "Root / Global"},
            {"id": "pose", "label": "Pose"},
            {"id": "surfaceShape", "label": "Surface Shape"},
            {"id": "skeletalProportion", "label": "Skeletal Proportion"},
            {"id": "expression", "label": "Expression"},
            {"id": "expertRaw", "label": "Expert Raw"},
        ],
        "counts": {
            "modelParameterCount": model_parameter_count,
            "identityCount": identity_count,
            "expressionCount": expression_count,
            "parameterCount": len(parameters),
        },
        "parameters": parameters,
        "sections": sections,
    }


def _assert_numeric(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be numeric, got {type(value).__name__}.")
    return float(value)


def _assign_named_values(
    payload: dict[str, Any],
    *,
    section_name: str,
    lookup: dict[str, int],
    target: np.ndarray,
) -> None:
    if not payload:
        return
    if not isinstance(payload, dict):
        raise ValueError(f"{section_name} must be an object.")
    for key, raw_value in payload.items():
        if key not in lookup:
            raise KeyError(f"Unknown {section_name} parameter: {key}")
        target[lookup[key]] = _assert_numeric(raw_value, f"{section_name}.{key}")


def build_raw_inputs(parameter_metadata: dict[str, Any], state_patch: dict[str, Any]) -> dict[str, np.ndarray]:
    counts = parameter_metadata["counts"]
    sections = parameter_metadata["sections"]
    model_parameters = np.zeros((counts["modelParameterCount"],), dtype=np.float32)
    identity = np.zeros((counts["identityCount"],), dtype=np.float32)
    expression = np.zeros((counts["expressionCount"],), dtype=np.float32)

    _assign_named_values(state_patch.get("root", {}), section_name="root", lookup=sections["root"], target=model_parameters)
    _assign_named_values(state_patch.get("pose", {}), section_name="pose", lookup=sections["pose"], target=model_parameters)
    _assign_named_values(
        state_patch.get("skeletalProportion", {}),
        section_name="skeletalProportion",
        lookup=sections["skeletalProportion"],
        target=model_parameters,
    )
    _assign_named_values(
        state_patch.get("surfaceShape", {}),
        section_name="surfaceShape",
        lookup=sections["surfaceShape"],
        target=identity,
    )
    _assign_named_values(
        state_patch.get("expression", {}),
        section_name="expression",
        lookup=sections["expression"],
        target=expression,
    )

    expert_raw = state_patch.get("expertRaw", {})
    if expert_raw:
        if not isinstance(expert_raw, dict):
            raise ValueError("expertRaw must be an object.")
        _assign_named_values(
            expert_raw.get("modelParameters", {}),
            section_name="expertRaw.modelParameters",
            lookup={
                **sections["root"],
                **sections["pose"],
                **sections["skeletalProportion"],
            },
            target=model_parameters,
        )
        _assign_named_values(
            expert_raw.get("identity", {}),
            section_name="expertRaw.identity",
            lookup=sections["surfaceShape"],
            target=identity,
        )
        _assign_named_values(
            expert_raw.get("expression", {}),
            section_name="expertRaw.expression",
            lookup=sections["expression"],
            target=expression,
        )

    return {
        "identity": identity.reshape(1, -1),
        "model_parameters": model_parameters.reshape(1, -1),
        "expression": expression.reshape(1, -1),
    }


def evaluate_state_patch(model, parameter_metadata: dict[str, Any], state_patch: dict[str, Any]) -> dict[str, Any]:
    torch = import_torch()
    raw_inputs = build_raw_inputs(parameter_metadata, state_patch)
    with torch.no_grad():
        vertices, skeleton_state = model(
            torch.from_numpy(raw_inputs["identity"]),
            torch.from_numpy(raw_inputs["model_parameters"]),
            torch.from_numpy(raw_inputs["expression"]),
        )

    vertices_np = vertices.detach().cpu().numpy().astype(np.float32)
    skeleton_np = skeleton_state.detach().cpu().numpy().astype(np.float32)
    derived = {
        "vertexCount": int(vertices_np.shape[1]),
        "jointCount": int(skeleton_np.shape[1]),
        "rootTranslation": [float(x) for x in skeleton_np[0, 1, 0:3]],
        "firstVertex": [float(x) for x in vertices_np[0, 0, 0:3]],
        "skeletonExtentY": float(skeleton_np[0, :, 1].max() - skeleton_np[0, :, 1].min()),
    }
    return {
        "vertices": vertices_np,
        "skeleton_state": skeleton_np,
        "derived": derived,
    }


def load_case_manifest(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Golden case manifest must be a JSON object.")
    return payload
