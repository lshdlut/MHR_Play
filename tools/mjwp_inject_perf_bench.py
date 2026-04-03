#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import statistics
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import Browser, Page, Playwright, sync_playwright

from local_config import repo_root_from_here


DEFAULT_TIMEOUT_S = 120.0
DEFAULT_FREE_DURATION_MS = 2500
DEFAULT_FREE_SAMPLE_MS = 100
MS_EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")

WASM_BRIDGE_TIMING_FIELDS = (
    "resetStateMs",
    "parameterUploadMs",
    "parameterUploadModelMs",
    "parameterUploadIdentityMs",
    "parameterUploadExpressionMs",
    "evaluateCallMs",
    "verticesExportMs",
    "skeletonExportMs",
    "derivedExportMs",
)
WASM_NATIVE_TIMING_FIELDS = (
    "resetStateMs",
    "parameterUploadMs",
    "evaluateCoreMs",
    "verticesExportMs",
    "skeletonExportMs",
    "derivedExportMs",
)
WASM_NATIVE_STAGE_TIMING_FIELDS = (
    "parameterDecodeMs",
    "jointWorldTransformsMs",
    "surfaceMorphMs",
    "poseFeaturesMs",
    "correctiveStage1Ms",
    "correctiveStage2Ms",
    "skinningMs",
    "derivedMs",
)


def parse_fps_text(value: object) -> float:
    text = str(value or "").strip().lower()
    if not text or text == "0 fps":
        return 0.0
    numeric = text.replace("fps", "").strip()
    try:
        return float(numeric)
    except ValueError:
        return 0.0


def summarize_series(values: list[float]) -> dict[str, float]:
    clean = [float(value) for value in values if math.isfinite(float(value))]
    if not clean:
        return {"min": 0.0, "median": 0.0, "p95": 0.0, "max": 0.0, "mean": 0.0}
    ordered = sorted(clean)

    def percentile(fraction: float) -> float:
        if len(ordered) == 1:
            return ordered[0]
        position = (len(ordered) - 1) * fraction
        lower = math.floor(position)
        upper = math.ceil(position)
        if lower == upper:
            return ordered[lower]
        weight = position - lower
        return ordered[lower] * (1.0 - weight) + ordered[upper] * weight

    return {
        "min": float(min(ordered)),
        "median": float(statistics.median(ordered)),
        "p95": float(percentile(0.95)),
        "max": float(max(ordered)),
        "mean": float(statistics.fmean(ordered)),
    }


def collect_trace_value(trace: dict[str, object], path: tuple[str, ...]) -> float | None:
    current: object = trace
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    if current is None:
        return None
    numeric = float(current)
    if not math.isfinite(numeric):
        return None
    return numeric


def collect_trace_values(traces: list[dict[str, object]], *paths: tuple[str, ...]) -> list[float]:
    values: list[float] = []
    for trace in traces:
        if not isinstance(trace, dict):
            continue
        for path in paths:
            numeric = collect_trace_value(trace, path)
            if numeric is not None:
                values.append(numeric)
                break
    return values


def summarize_trace_paths(
    traces: list[dict[str, object]],
    *paths: tuple[str, ...],
) -> dict[str, float] | None:
    values = collect_trace_values(traces, *paths)
    if not values:
        return None
    return summarize_series(values)


def summarize_trace_series(traces: list[dict[str, object]]) -> dict[str, object]:
    unique_traces: list[dict[str, object]] = []
    seen_ids: set[str] = set()
    for trace in traces:
        if not isinstance(trace, dict):
            continue
        trace_id = str(trace.get("traceId") or "")
        if not trace_id or trace_id in seen_ids:
            continue
        seen_ids.add(trace_id)
        unique_traces.append(trace)
    if not unique_traces:
        return {"sampledTraceCount": 0}

    def summarize_fields(
        fields: tuple[str, ...],
        *path_prefixes: tuple[str, ...],
    ) -> dict[str, object]:
        summary: dict[str, object] = {}
        for field in fields:
            stats = summarize_trace_paths(
                unique_traces,
                *(path_prefix + (field,) for path_prefix in path_prefixes),
            )
            if stats is not None:
                summary[field] = stats
        return summary

    parameter_keys = sorted({str(trace.get("parameterKey") or "") for trace in unique_traces if trace.get("parameterKey")})
    state_sections = sorted({str(trace.get("stateSection") or "") for trace in unique_traces if trace.get("stateSection")})
    wasm_bridge_summary = summarize_fields(
        WASM_BRIDGE_TIMING_FIELDS,
        ("wasm", "bridge"),
        ("wasm",),
    )
    wasm_native_summary = summarize_fields(
        WASM_NATIVE_TIMING_FIELDS,
        ("wasm", "native"),
        ("wasm",),
    )
    wasm_stage_summary = summarize_fields(
        WASM_NATIVE_STAGE_TIMING_FIELDS,
        ("wasm", "native", "stageTimings"),
        ("wasm", "native"),
    )
    wasm_summary: dict[str, object] = {}
    if wasm_bridge_summary:
        wasm_summary["bridge"] = wasm_bridge_summary
    if wasm_native_summary or wasm_stage_summary:
        if wasm_stage_summary:
            wasm_native_summary["stageTimings"] = wasm_stage_summary
        wasm_summary["native"] = wasm_native_summary
    return {
        "sampledTraceCount": len(unique_traces),
        "parameterKeys": parameter_keys,
        "stateSections": state_sections,
        "inputToWorkerReceiveMs": summarize_series(collect_trace_values(unique_traces, ("inputToWorkerReceiveMs",))),
        "inputToEventReceiveMs": summarize_series(collect_trace_values(unique_traces, ("inputToEventReceiveMs",))),
        "inputToFirstPresentedMs": summarize_series(collect_trace_values(unique_traces, ("inputToFirstPresentedMs",))),
        "inputToVisuallySettledMs": summarize_series(collect_trace_values(unique_traces, ("inputToVisuallySettledMs",))),
        "workerReceiveToDispatchMs": summarize_series(collect_trace_values(unique_traces, ("workerReceiveToDispatchMs",))),
        "worker": {
            "mergeStatePatchMs": summarize_series(collect_trace_values(unique_traces, ("worker", "mergeStatePatchMs"))),
            "buildRawInputsMs": summarize_series(collect_trace_values(unique_traces, ("worker", "buildRawInputsMs"))),
            "runEvaluateWallMs": summarize_series(collect_trace_values(unique_traces, ("worker", "runEvaluateWallMs"))),
        },
        "mainThread": {
            "eventApplyAndPublishMs": summarize_series(collect_trace_values(unique_traces, ("mainThread", "eventApplyAndPublishMs"))),
            "eventApplyBeforeNotifyMs": summarize_series(collect_trace_values(unique_traces, ("mainThread", "eventApplyBeforeNotifyMs"))),
            "eventToGeometryStartMs": summarize_series(collect_trace_values(unique_traces, ("mainThread", "eventToGeometryStartMs"))),
            "geometryApplyMs": summarize_series(collect_trace_values(unique_traces, ("mainThread", "geometryApplyMs"))),
            "normalsUpdateMs": summarize_series(collect_trace_values(unique_traces, ("mainThread", "normalsUpdateMs"))),
            "boundsUpdateMs": summarize_series(collect_trace_values(unique_traces, ("mainThread", "boundsUpdateMs"))),
            "meshColorApplyMs": summarize_series(collect_trace_values(unique_traces, ("mainThread", "meshColorApplyMs"))),
            "skeletonApplyMs": summarize_series(collect_trace_values(unique_traces, ("mainThread", "skeletonApplyMs"))),
        },
        **({"wasm": wasm_summary} if wasm_summary else {}),
    }


def summarize_trace(trace: dict[str, object] | None) -> dict[str, object]:
    if not isinstance(trace, dict):
        return {}
    plugin = trace.get("plugin") if isinstance(trace.get("plugin"), dict) else {}
    worker = trace.get("worker") if isinstance(trace.get("worker"), dict) else {}
    main_thread = trace.get("mainThread") if isinstance(trace.get("mainThread"), dict) else {}

    def read_ts(section: dict[str, object], key: str) -> float:
        value = section.get(key)
        numeric = float(value) if value is not None else float("nan")
        return numeric if math.isfinite(numeric) else float("nan")

    input_ts = read_ts(plugin, "inputTs")
    event_receive_ts = read_ts(main_thread, "evaluationEventReceiveTs")
    first_presented_ts = read_ts(main_thread, "firstPresentedFrameTs")
    visually_settled_ts = read_ts(main_thread, "visuallySettledFrameTs")
    worker_receive_ts = read_ts(worker, "applyStateAndEvaluateReceivedTs")
    worker_dispatch_ts = read_ts(worker, "evaluationDispatchTs")

    def diff_ms(end_ts: float, start_ts: float) -> float | None:
        if not math.isfinite(end_ts) or not math.isfinite(start_ts):
            return None
        return float(end_ts - start_ts)

    return {
        "traceId": trace.get("traceId"),
        "parameterKey": trace.get("parameterKey"),
        "stateSection": trace.get("stateSection"),
        "source": trace.get("source"),
        "inputToWorkerReceiveMs": diff_ms(worker_receive_ts, input_ts),
        "inputToEventReceiveMs": diff_ms(event_receive_ts, input_ts),
        "inputToFirstPresentedMs": diff_ms(first_presented_ts, input_ts),
        "inputToVisuallySettledMs": diff_ms(visually_settled_ts, input_ts),
        "workerReceiveToDispatchMs": diff_ms(worker_dispatch_ts, worker_receive_ts),
        "worker": {
            "mergeStatePatchMs": worker.get("mergeStatePatchMs"),
            "buildRawInputsMs": worker.get("buildRawInputsMs"),
            "runEvaluateWallMs": worker.get("runEvaluateWallMs"),
        },
        "mainThread": {
            "eventApplyAndPublishMs": main_thread.get("eventApplyAndPublishMs"),
            "eventApplyBeforeNotifyMs": main_thread.get("eventApplyBeforeNotifyMs"),
            "eventToGeometryStartMs": main_thread.get("eventToGeometryStartMs"),
            "geometryApplyMs": main_thread.get("geometryApplyMs"),
            "normalsUpdateMs": main_thread.get("normalsUpdateMs"),
            "boundsUpdateMs": main_thread.get("boundsUpdateMs"),
            "meshColorApplyMs": main_thread.get("meshColorApplyMs"),
            "meshColorApplied": main_thread.get("meshColorApplied"),
            "skeletonApplyMs": main_thread.get("skeletonApplyMs"),
            "firstPresentedAfterGeometryMs": main_thread.get("firstPresentedAfterGeometryMs"),
            "visuallySettledAfterGeometryMs": main_thread.get("visuallySettledAfterGeometryMs"),
        },
        "wasm": trace.get("wasm"),
    }


def build_state_js() -> str:
    return (
        "() => ({"
        " title: document.title,"
        " profile: document.documentElement?.getAttribute('data-play-profile') ?? '',"
        " requestedLod: Number(new URL(window.location.href).searchParams.get('lod') || 0),"
        " visualSourceMode: window.__PLAY_HOST__?.store?.get?.()?.visualSourceMode ?? '',"
        " hasHost: !!window.__PLAY_HOST__,"
        " hasBackend: !!window.__PLAY_HOST__?.backend,"
        " hasService: !!(window.__PLAY_HOST__?.services?.mhr ?? window.__PLAY_HOST__?.extensions?.mhr?.service),"
        " hasMesh: !!window.__renderCtx?.scene?.getObjectByName?.('mhr-profile:mesh'),"
        " pending: !!(window.__PLAY_HOST__?.services?.mhr?.hasPendingCommit?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.hasPendingCommit?.()),"
        " seq: Number((window.__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.())?.mhr?.evaluation?.seq || 0),"
        " revision: Number((window.__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.())?.mhr?.revision || 0),"
        " assetLod: Number((window.__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.())?.mhr?.assets?.lod ?? -1),"
        " derivedLod: Number((window.__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.())?.mhr?.evaluation?.derived?.lod ?? -1),"
        " vertexCount: Number((window.__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.())?.mhr?.evaluation?.mesh?.vertexCount || 0),"
        " jointCount: Number((window.__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.())?.mhr?.evaluation?.skeleton?.jointCount || 0),"
        " frontHud: document.querySelector('[data-testid=\"mhr-perf-hud\"] [data-info-field=\"front-fps\"]')?.textContent ?? '',"
        " backendHud: document.querySelector('[data-testid=\"mhr-perf-hud\"] [data-info-field=\"backend-fps\"]')?.textContent ?? '',"
        " trace: globalThis.__MHR_DEBUG_TRACE__ || null,"
        " preview: (() => {"
        "   const preview = (window.__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.())?.mhr?.evaluation?.influencePreview || null;"
        "   if (!preview) return null;"
        "   const magnitudes = preview.magnitudes;"
        "   let nonZeroCount = 0;"
        "   if (magnitudes && typeof magnitudes.length === 'number') {"
        "     for (let index = 0; index < magnitudes.length; index += 1) {"
        "       if (Number(magnitudes[index] || 0) > 0) nonZeroCount += 1;"
        "     }"
        "   }"
        "   return {"
        "     parameterKey: String(preview.parameterKey || ''),"
        "     stateSection: String(preview.stateSection || ''),"
        "     revision: Number(preview.revision || 0),"
        "     vertexCount: Number(preview.vertexCount || 0),"
        "     maxMagnitude: Number(preview.maxMagnitude || 0),"
        "     appliedDelta: Number(preview.appliedDelta || 0),"
        "     nonZeroCount,"
        "   };"
        " })()"
        "})"
    )


STATE_JS = build_state_js()


def ready_predicate(payload: object, lod: int) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("profile") == "mhr"
        and int(payload.get("requestedLod", -1)) == int(lod)
        and payload.get("visualSourceMode") == "preset-sun"
        and bool(payload.get("hasHost"))
        and bool(payload.get("hasBackend"))
        and bool(payload.get("hasService"))
        and bool(payload.get("hasMesh"))
        and int(payload.get("assetLod", -1)) == int(lod)
        and int(payload.get("derivedLod", -1)) == int(lod)
        and int(payload.get("vertexCount", 0)) > 0
        and int(payload.get("jointCount", 0)) > 0
    )


def build_first_slider_js(prefix: str, state_section: str | None = None) -> str:
    selector = f'[data-testid^="{prefix}-range-"]'
    section_condition = (
        "true"
        if not state_section
        else f"String(row?.dataset?.mhrStateSection || '') === {json.dumps(state_section)}"
    )
    return (
        f"""
        () => {{
          const inputs = Array.from(document.querySelectorAll({json.dumps(selector)}));
          const input = inputs.find((entry) => {{
            const row = entry?.closest('.mhr-param-row');
            return {section_condition};
          }}) || null;
          const row = input?.closest('.mhr-param-row');
          return {{
            found: !!input,
            testId: input?.getAttribute('data-testid') || '',
            parameterKey: row?.dataset?.mhrParamKey || '',
            stateSection: row?.dataset?.mhrStateSection || '',
            min: Number(input?.min || 0),
            max: Number(input?.max || 0),
            value: Number(input?.value || 0),
          }};
        }}
        """
    )


def build_toggle_js(test_id: str, desired: bool) -> str:
    selector = f'[data-testid="{test_id}"]'
    desired_literal = "true" if desired else "false"
    return (
        f"""
        () => {{
          const root = document.querySelector({json.dumps(selector)});
          if (!root) return {{ ok: false, error: 'missing-toggle' }};
          const input = root.matches('input[type="checkbox"]') ? root : root.querySelector('input[type="checkbox"]');
          const desired = {desired_literal};
          if (input) {{
            if (!!input.checked !== desired) input.click();
            return {{ ok: true, value: !!input.checked }};
          }}
          const button = root.matches('button,[role="button"]') ? root : root.querySelector('button,[role="button"]');
          if (!button) return {{ ok: false, error: 'missing-button' }};
          const pressed = String(button.getAttribute('aria-pressed') || '').toLowerCase() === 'true';
          if (pressed !== desired) button.click();
          return {{ ok: true, value: String(button.getAttribute('aria-pressed') || '').toLowerCase() === 'true' }};
        }}
        """
    )


def build_slider_dispatch_js(test_id: str, target_value: float) -> str:
    selector = f'[data-testid="{test_id}"]'
    return (
        f"""
        () => {{
          const input = document.querySelector({json.dumps(selector)});
          if (!input) return {{ ok: false, error: 'missing-slider' }};
          const row = input.closest('.mhr-param-row');
          const previousValue = Number(input.value || 0);
          const nextValue = Number({json.dumps(float(target_value))});
          input.value = String(nextValue);
          input.dispatchEvent(new Event('input', {{ bubbles: true }}));
          return {{
            ok: true,
            previousValue,
            nextValue,
            parameterKey: row?.dataset?.mhrParamKey || '',
            stateSection: row?.dataset?.mhrStateSection || '',
          }};
        }}
        """
    )


def build_free_bench_js(
    toggle_test_ids: str | list[str],
    slider_test_id: str | None,
    duration_ms: int,
    sample_ms: int,
) -> str:
    toggle_ids = [toggle_test_ids] if isinstance(toggle_test_ids, str) else list(toggle_test_ids)
    toggle_selectors = [f'[data-testid="{toggle_id}"]' for toggle_id in toggle_ids]
    slider_selector = f'[data-testid="{slider_test_id}"]' if slider_test_id else None
    return f"""
    async () => {{
      const parseFps = (text) => {{
        const raw = String(text || '').trim().toLowerCase();
        if (!raw || raw === '0 fps') return 0;
        const numeric = Number(raw.replace('fps', '').trim());
        return Number.isFinite(numeric) ? numeric : 0;
      }};
      const readToggle = (selector) => {{
        const root = document.querySelector(selector);
        if (!root) return {{ root: null, value: false }};
        const input = root.matches('input[type="checkbox"]') ? root : root.querySelector('input[type="checkbox"]');
        if (input) return {{ root, value: !!input.checked, click: () => input.click() }};
        const button = root.matches('button,[role="button"]') ? root : root.querySelector('button,[role="button"]');
        if (!button) return {{ root, value: false }};
        return {{
          root,
          value: String(button.getAttribute('aria-pressed') || '').toLowerCase() === 'true',
          click: () => button.click(),
        }};
      }};
      const setToggles = (desired) => {{
        let found = false;
        for (const selector of {json.dumps(toggle_selectors)}) {{
          const state = readToggle(selector);
          if (!state.root || typeof state.click !== 'function') continue;
          found = true;
          if (!!state.value !== !!desired) state.click();
        }}
        return found;
      }};
      const summarizeTrace = (trace) => {{
        if (!trace || typeof trace !== 'object') return null;
        const plugin = trace.plugin && typeof trace.plugin === 'object' ? trace.plugin : null;
        const worker = trace.worker && typeof trace.worker === 'object' ? trace.worker : null;
        const mainThread = trace.mainThread && typeof trace.mainThread === 'object' ? trace.mainThread : null;
        const normalizeNumber = (value) => {{
          const numeric = Number(value || 0);
          return Number.isFinite(numeric) ? numeric : 0;
        }};
        const readBridgeTiming = (bridge) => {{
          if (!bridge || typeof bridge !== 'object') return null;
          return {{
            resetStateMs: normalizeNumber(bridge.resetStateMs),
            parameterUploadMs: normalizeNumber(bridge.parameterUploadMs),
            parameterUploadModelMs: normalizeNumber(bridge.parameterUploadModelMs),
            parameterUploadIdentityMs: normalizeNumber(bridge.parameterUploadIdentityMs),
            parameterUploadExpressionMs: normalizeNumber(bridge.parameterUploadExpressionMs),
            evaluateCallMs: normalizeNumber(bridge.evaluateCallMs),
            verticesExportMs: normalizeNumber(bridge.verticesExportMs),
            skeletonExportMs: normalizeNumber(bridge.skeletonExportMs),
            derivedExportMs: normalizeNumber(bridge.derivedExportMs),
          }};
        }};
        const readStageTimings = (native) => {{
          const stage = native && typeof native === 'object' && native.stageTimings && typeof native.stageTimings === 'object'
            ? native.stageTimings
            : null;
          if (!stage) return null;
          const timings = {{
            parameterDecodeMs: normalizeNumber(stage.parameterDecodeMs),
            jointWorldTransformsMs: normalizeNumber(stage.jointWorldTransformsMs),
            surfaceMorphMs: normalizeNumber(stage.surfaceMorphMs),
            poseFeaturesMs: normalizeNumber(stage.poseFeaturesMs),
            correctiveStage1Ms: normalizeNumber(stage.correctiveStage1Ms),
            correctiveStage2Ms: normalizeNumber(stage.correctiveStage2Ms),
            skinningMs: normalizeNumber(stage.skinningMs),
            derivedMs: normalizeNumber(stage.derivedMs),
          }};
          return Object.values(timings).some((value) => value !== 0) ? timings : null;
        }};
        const readNativeTiming = (native) => {{
          if (!native || typeof native !== 'object') return null;
          const timings = {{
            resetStateMs: normalizeNumber(native.resetStateMs),
            parameterUploadMs: normalizeNumber(native.parameterUploadMs),
            evaluateCoreMs: normalizeNumber(native.evaluateCoreMs),
            verticesExportMs: normalizeNumber(native.verticesExportMs),
            skeletonExportMs: normalizeNumber(native.skeletonExportMs),
            derivedExportMs: normalizeNumber(native.derivedExportMs),
          }};
          const stageTimings = readStageTimings(native);
          if (stageTimings) timings.stageTimings = stageTimings;
          return timings;
        }};
        const readWasmTiming = (wasm) => {{
          if (!wasm || typeof wasm !== 'object') return null;
          if ('bridge' in wasm || 'native' in wasm) {{
            const next = {{}};
            const bridge = readBridgeTiming(wasm.bridge);
            const native = readNativeTiming(wasm.native);
            if (bridge) next.bridge = bridge;
            if (native) next.native = native;
            return Object.keys(next).length > 0 ? next : null;
          }}
          if ('evalMs' in wasm || 'compareMs' in wasm || 'marshalMs' in wasm) {{
            return {{
              evalMs: normalizeNumber(wasm.evalMs),
              compareMs: normalizeNumber(wasm.compareMs),
              marshalMs: normalizeNumber(wasm.marshalMs),
            }};
          }}
          return null;
        }};
        return {{
          traceId: String(trace.traceId || ''),
          parameterKey: String(trace.parameterKey || ''),
          stateSection: String(trace.stateSection || ''),
          source: String(trace.source || ''),
          plugin: plugin ? {{
            inputTs: Number(plugin.inputTs || 0),
          }} : null,
          worker: worker ? {{
            applyStateAndEvaluateReceivedTs: Number(worker.applyStateAndEvaluateReceivedTs || 0),
            evaluationDispatchTs: Number(worker.evaluationDispatchTs || 0),
            mergeStatePatchMs: Number(worker.mergeStatePatchMs || 0),
            buildRawInputsMs: Number(worker.buildRawInputsMs || 0),
            runEvaluateWallMs: Number(worker.runEvaluateWallMs || 0),
          }} : null,
          mainThread: mainThread ? {{
            evaluationEventReceiveTs: Number(mainThread.evaluationEventReceiveTs || 0),
            eventApplyBeforeNotifyMs: Number(mainThread.eventApplyBeforeNotifyMs || 0),
            eventApplyAndPublishMs: Number(mainThread.eventApplyAndPublishMs || 0),
            eventToGeometryStartMs: Number(mainThread.eventToGeometryStartMs || 0),
            geometryApplyMs: Number(mainThread.geometryApplyMs || 0),
            normalsUpdateMs: Number(mainThread.normalsUpdateMs || 0),
            boundsUpdateMs: Number(mainThread.boundsUpdateMs || 0),
            meshColorApplyMs: Number(mainThread.meshColorApplyMs || 0),
            meshColorApplied: !!mainThread.meshColorApplied,
            skeletonApplyMs: Number(mainThread.skeletonApplyMs || 0),
            firstPresentedFrameTs: Number(mainThread.firstPresentedFrameTs || 0),
            visuallySettledFrameTs: Number(mainThread.visuallySettledFrameTs || 0),
          }} : null,
          wasm: readWasmTiming(trace.wasm),
        }};
      }};
      const readState = () => {{
        const snapshot = window.__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.();
        const seq = Number(snapshot?.mhr?.evaluation?.seq || 0);
        const pending = !!(window.__PLAY_HOST__?.services?.mhr?.hasPendingCommit?.() ?? window.__PLAY_HOST__?.extensions?.mhr?.hasPendingCommit?.());
        const frontHud = document.querySelector('[data-testid="mhr-perf-hud"] [data-info-field="front-fps"]')?.textContent ?? '';
        const backendHud = document.querySelector('[data-testid="mhr-perf-hud"] [data-info-field="backend-fps"]')?.textContent ?? '';
        const slider = {json.dumps(slider_selector)} ? document.querySelector({json.dumps(slider_selector)}) : null;
        const trace = summarizeTrace(globalThis.__MHR_DEBUG_TRACE__ || null);
        return {{
          ts: performance.now(),
          seq,
          pending,
          frontFps: parseFps(frontHud),
          backendFps: parseFps(backendHud),
          sliderValue: Number(slider?.value || 0),
          trace,
        }};
      }};

      if (!setToggles(true)) return {{ ok: false, error: 'missing-toggle' }};
      await new Promise((resolve) => setTimeout(resolve, Math.max(120, {int(sample_ms)})));
      const samples = [];
      const start = performance.now();
      while (performance.now() - start < {int(duration_ms)}) {{
        samples.push(readState());
        await new Promise((resolve) => setTimeout(resolve, {int(sample_ms)}));
      }}
      const beforeStop = readState();
      setToggles(false);
      const stopStart = performance.now();
      let stableSince = performance.now();
      let lastSeq = beforeStop.seq;
      let stopPending = beforeStop.pending;
      while (performance.now() - stopStart < 6000) {{
        const next = readState();
        if (next.seq !== lastSeq || next.pending) {{
          stableSince = performance.now();
          lastSeq = next.seq;
          stopPending = next.pending;
        }}
        if (!next.pending && performance.now() - stableSince >= 400) {{
          return {{
            ok: true,
            samples,
            stopLatencyMs: performance.now() - stopStart,
            finalSeq: next.seq,
            finalPending: next.pending,
          }};
        }}
        await new Promise((resolve) => setTimeout(resolve, {int(sample_ms)}));
      }}
      return {{
        ok: true,
        samples,
        stopLatencyMs: 6000,
        finalSeq: lastSeq,
        finalPending: stopPending,
        stopTimeout: true,
      }};
    }}
    """


def build_lod_switch_js(target_lod: int) -> str:
    return (
        f"""
        () => {{
          const select = document.querySelector('[data-testid="mhr-lod-select"]');
          if (!select) return {{ ok: false, error: 'missing-lod-select' }};
          const nextValue = String({int(target_lod)});
          select.value = nextValue;
          select.dispatchEvent(new Event('change', {{ bubbles: true }}));
          return {{ ok: true, targetLod: Number(nextValue) }};
        }}
        """
    )


def find_edge_executable() -> Path:
    if not MS_EDGE_PATH.exists():
        raise FileNotFoundError(f"Edge executable not found at {MS_EDGE_PATH}")
    return MS_EDGE_PATH


def launch_browser(playwright: Playwright) -> Browser:
    edge_executable = find_edge_executable()
    return playwright.chromium.launch(
        executable_path=str(edge_executable),
        headless=False,
        args=["--window-size=1600,1200"],
    )


def evaluate(page: Page, js_source: str) -> Any:
    return page.evaluate(js_source)


def poll_until(page: Page, predicate, *, timeout_s: float, interval_s: float = 0.1) -> Any:
    deadline = time.time() + max(timeout_s, 0.1)
    last_payload = None
    while time.time() < deadline:
        payload = evaluate(page, STATE_JS)
        last_payload = payload
        if predicate(payload):
            return payload
        time.sleep(interval_s)
    raise TimeoutError(f"Timed out waiting for condition. Last payload: {last_payload}")


def ensure_toggle(page: Page, test_id: str, desired: bool) -> None:
    payload = evaluate(page, build_toggle_js(test_id, desired))
    if not isinstance(payload, dict) or not payload.get("ok"):
        raise RuntimeError(f"Unable to toggle {test_id}: {payload!r}")


def get_state(page: Page) -> dict[str, Any]:
    payload = evaluate(page, STATE_JS)
    if not isinstance(payload, dict):
        raise RuntimeError(f"Unexpected page state payload: {payload!r}")
    return payload


def wait_for_slider(page: Page, prefix: str, state_section: str | None = None, timeout_s: float = 15.0) -> dict[str, Any]:
    deadline = time.time() + max(timeout_s, 0.1)
    last_payload: object = None
    js_source = build_first_slider_js(prefix, state_section)
    while time.time() < deadline:
        payload = evaluate(page, js_source)
        last_payload = payload
        if isinstance(payload, dict) and payload.get("found"):
            return payload
        time.sleep(0.1)
    raise RuntimeError(f"Unable to find slider for {prefix} ({state_section or 'any'}): {last_payload!r}")


def wait_ready(page: Page, lod: int, timeout_s: float) -> dict[str, Any]:
    return poll_until(page, lambda value: ready_predicate(value, lod), timeout_s=timeout_s)


def run_slider_bench(
    page: Page,
    *,
    prefix: str,
    state_section: str | None,
    label: str,
    ratio: float,
    preview_enabled: bool,
    timeout_s: float,
) -> dict[str, Any]:
    ensure_toggle(page, "mhr-influence-preview", preview_enabled)
    slider = wait_for_slider(page, prefix, state_section, timeout_s)
    min_value = float(slider["min"])
    max_value = float(slider["max"])
    current_value = float(slider["value"])
    span = max_value - min_value
    if not math.isfinite(span) or span <= 0:
        raise RuntimeError(f"Invalid slider span for {label}: {slider!r}")
    target_value = min_value + (span * ratio)
    if abs(target_value - current_value) < max(span * 0.1, 0.05):
        target_value = min_value + (span * (0.25 if ratio >= 0.5 else 0.75))
    pre_state = get_state(page)
    previous_trace_id = (
        pre_state.get("trace", {}).get("traceId")
        if isinstance(pre_state.get("trace"), dict)
        else None
    )
    previous_seq = int(pre_state.get("seq", 0))
    dispatch_started = time.perf_counter()
    dispatched = evaluate(page, build_slider_dispatch_js(str(slider["testId"]), float(target_value)))
    if not isinstance(dispatched, dict) or not dispatched.get("ok"):
        raise RuntimeError(f"Unable to dispatch slider input for {label}: {dispatched!r}")
    settled = poll_until(
        page,
        lambda value: (
            isinstance(value, dict)
            and isinstance(value.get("trace"), dict)
            and value["trace"].get("traceId") != previous_trace_id
            and value["trace"].get("parameterKey") == slider.get("parameterKey")
            and value["trace"].get("stateSection") == slider.get("stateSection")
            and isinstance(value["trace"].get("mainThread"), dict)
            and value["trace"]["mainThread"].get("visuallySettledFrameTs")
            and int(value.get("seq", 0)) > previous_seq
            and (
                not preview_enabled
                or (
                    isinstance(value.get("preview"), dict)
                    and value["preview"].get("parameterKey") == slider.get("parameterKey")
                    and value["preview"].get("stateSection") == slider.get("stateSection")
                    and int(value["preview"].get("revision", 0)) == int(value.get("revision", 0))
                )
            )
        ),
        timeout_s=timeout_s,
    )
    wall_ms = (time.perf_counter() - dispatch_started) * 1000.0
    preview = settled.get("preview")
    preview_summary = None
    if isinstance(preview, dict):
        preview_summary = {
            "parameterKey": preview.get("parameterKey"),
            "stateSection": preview.get("stateSection"),
            "maxMagnitude": preview.get("maxMagnitude"),
            "appliedDelta": preview.get("appliedDelta"),
            "vertexCount": preview.get("vertexCount"),
            "nonZeroCount": preview.get("nonZeroCount"),
        }
    return {
        "label": label,
        "parameterKey": slider.get("parameterKey"),
        "stateSection": slider.get("stateSection"),
        "sliderTestId": slider.get("testId"),
        "previewEnabled": preview_enabled,
        "fromValue": current_value,
        "toValue": dispatched.get("nextValue"),
        "settledWallMs": wall_ms,
        "frontHudFps": parse_fps_text(settled.get("frontHud")),
        "backendHudFps": parse_fps_text(settled.get("backendHud")),
        "trace": summarize_trace(settled.get("trace") if isinstance(settled.get("trace"), dict) else None),
        "preview": preview_summary,
    }


def summarize_free_bench(result: dict[str, Any]) -> dict[str, Any]:
    samples = result.get("samples") if isinstance(result.get("samples"), list) else []
    if not samples:
        return {"sampleCount": 0}
    seqs = [int(sample.get("seq", 0)) for sample in samples if isinstance(sample, dict)]
    front = [float(sample.get("frontFps", 0) or 0) for sample in samples if isinstance(sample, dict)]
    backend = [float(sample.get("backendFps", 0) or 0) for sample in samples if isinstance(sample, dict)]
    slider_values = [float(sample.get("sliderValue", 0) or 0) for sample in samples if isinstance(sample, dict)]
    pending_ratio = (
        sum(1 for sample in samples if isinstance(sample, dict) and sample.get("pending")) / len(samples)
        if samples
        else 0.0
    )
    value_changes = 0
    last_value = None
    for value in slider_values:
        if last_value is None or not math.isclose(value, last_value, rel_tol=0.0, abs_tol=1e-6):
            if last_value is not None:
                value_changes += 1
            last_value = value
    duration_ms = 0.0
    if len(samples) >= 2:
        duration_ms = float(samples[-1]["ts"]) - float(samples[0]["ts"])
    seq_delta = max(seqs) - min(seqs) if seqs else 0
    seq_rate_hz = (seq_delta * 1000.0 / duration_ms) if duration_ms > 0 else 0.0
    traces = [
        summarize_trace(sample.get("trace") if isinstance(sample.get("trace"), dict) else None)
        for sample in samples
        if isinstance(sample, dict)
        and isinstance(sample.get("trace"), dict)
        and str(sample["trace"].get("source") or "") == "family-random"
    ]
    return {
        "sampleCount": len(samples),
        "durationMs": duration_ms,
        "seqDelta": seq_delta,
        "seqRateHz": seq_rate_hz,
        "sliderValueChangeCount": value_changes,
        "pendingRatio": pending_ratio,
        "frontFps": summarize_series(front),
        "backendFps": summarize_series(backend),
        "traceSummary": summarize_trace_series(traces),
        "stopLatencyMs": float(result.get("stopLatencyMs", 0.0)),
        "stopTimeout": bool(result.get("stopTimeout", False)),
    }


def run_free_bench(
    page: Page,
    *,
    family_label: str,
    toggle_test_id: str,
    slider_prefix: str,
    slider_state_section: str | None,
    duration_ms: int,
    sample_ms: int,
) -> dict[str, Any]:
    ensure_toggle(page, "mhr-influence-preview", False)
    slider = wait_for_slider(page, slider_prefix, slider_state_section, 15.0)
    payload = evaluate(page, build_free_bench_js(toggle_test_id, str(slider["testId"]), duration_ms, sample_ms))
    if not isinstance(payload, dict) or not payload.get("ok"):
        raise RuntimeError(f"Unable to run free bench for {family_label}: {payload!r}")
    return {
        "family": family_label,
        **summarize_free_bench(payload),
    }


def run_free_combo_bench(
    page: Page,
    *,
    family_label: str,
    toggle_test_ids: list[str],
    slider_prefix: str | None,
    slider_state_section: str | None,
    duration_ms: int,
    sample_ms: int,
) -> dict[str, Any]:
    ensure_toggle(page, "mhr-influence-preview", False)
    slider_test_id = None
    if slider_prefix and slider_state_section:
        slider = wait_for_slider(page, slider_prefix, slider_state_section, 15.0)
        slider_test_id = str(slider["testId"])
    payload = evaluate(page, build_free_bench_js(toggle_test_ids, slider_test_id, duration_ms, sample_ms))
    if not isinstance(payload, dict) or not payload.get("ok"):
        raise RuntimeError(f"Unable to run free combo bench for {family_label}: {payload!r}")
    return {
        "family": family_label,
        **summarize_free_bench(payload),
    }


def run_lod_switch_bench(
    page: Page,
    *,
    current_lod: int,
    target_lod: int,
    timeout_s: float,
) -> dict[str, Any]:
    before = get_state(page)
    started = time.perf_counter()
    dispatched = evaluate(page, build_lod_switch_js(target_lod))
    if not isinstance(dispatched, dict) or not dispatched.get("ok"):
        raise RuntimeError(f"Unable to switch LoD to {target_lod}: {dispatched!r}")
    settled = poll_until(
        page,
        lambda value: (
            ready_predicate(value, target_lod)
            and isinstance(value, dict)
            and int(value.get("requestedLod", -1)) == int(target_lod)
            and int(value.get("assetLod", -1)) == int(target_lod)
            and int(value.get("derivedLod", -1)) == int(target_lod)
        ),
        timeout_s=timeout_s,
    )
    return {
        "fromLod": current_lod,
        "toLod": target_lod,
        "wallMs": (time.perf_counter() - started) * 1000.0,
        "beforeVertexCount": int(before.get("vertexCount", 0)),
        "afterVertexCount": int(settled.get("vertexCount", 0)),
        "beforeJointCount": int(before.get("jointCount", 0)),
        "afterJointCount": int(settled.get("jointCount", 0)),
        "frontHudFps": parse_fps_text(settled.get("frontHud")),
        "backendHudFps": parse_fps_text(settled.get("backendHud")),
    }


def run_bench(
    page: Page,
    *,
    base_url: str,
    lod: int,
    switch_to_lod: int,
    timeout_s: float,
    free_duration_ms: int,
    free_sample_ms: int,
) -> dict[str, Any]:
    started = time.perf_counter()
    page.goto(f"{base_url.rstrip('/')}/mhr.html?lod={int(lod)}&mhrTrace=1", wait_until="domcontentloaded")
    ready = wait_ready(page, lod, timeout_s)
    boot_wall_ms = (time.perf_counter() - started) * 1000.0

    interactions = {
        "scale": run_slider_bench(
            page,
            prefix="mhr-scale",
            state_section="skeletalProportion",
            label="scale-slider",
            ratio=0.78,
            preview_enabled=False,
            timeout_s=timeout_s,
        ),
        "blend": run_slider_bench(
            page,
            prefix="mhr-blend",
            state_section="surfaceShape",
            label="blend-slider",
            ratio=0.72,
            preview_enabled=False,
            timeout_s=timeout_s,
        ),
        "expression": run_slider_bench(
            page,
            prefix="mhr-expression",
            state_section="expression",
            label="expression-slider",
            ratio=0.7,
            preview_enabled=False,
            timeout_s=timeout_s,
        ),
        "root": run_slider_bench(
            page,
            prefix="mhr-pose",
            state_section="root",
            label="root-slider",
            ratio=0.68,
            preview_enabled=False,
            timeout_s=timeout_s,
        ),
        "pose": run_slider_bench(
            page,
            prefix="mhr-pose",
            state_section="pose",
            label="pose-slider",
            ratio=0.68,
            preview_enabled=False,
            timeout_s=timeout_s,
        ),
        "previewBlend": run_slider_bench(
            page,
            prefix="mhr-blend",
            state_section="surfaceShape",
            label="blend-preview",
            ratio=0.34,
            preview_enabled=True,
            timeout_s=timeout_s,
        ),
        "previewExpression": run_slider_bench(
            page,
            prefix="mhr-expression",
            state_section="expression",
            label="expression-preview",
            ratio=0.3,
            preview_enabled=True,
            timeout_s=timeout_s,
        ),
    }

    free_metrics = {
        "scale": run_free_bench(
            page,
            family_label="scale",
            toggle_test_id="mhr-free-scale",
            slider_prefix="mhr-scale",
            slider_state_section="skeletalProportion",
            duration_ms=free_duration_ms,
            sample_ms=free_sample_ms,
        ),
        "blend": run_free_bench(
            page,
            family_label="blend",
            toggle_test_id="mhr-free-blend",
            slider_prefix="mhr-blend",
            slider_state_section="surfaceShape",
            duration_ms=free_duration_ms,
            sample_ms=free_sample_ms,
        ),
        "expression": run_free_bench(
            page,
            family_label="expression",
            toggle_test_id="mhr-free-expression",
            slider_prefix="mhr-expression",
            slider_state_section="expression",
            duration_ms=free_duration_ms,
            sample_ms=free_sample_ms,
        ),
        "pose": run_free_bench(
            page,
            family_label="pose",
            toggle_test_id="mhr-free-pose",
            slider_prefix="mhr-pose",
            slider_state_section="pose",
            duration_ms=free_duration_ms,
            sample_ms=free_sample_ms,
        ),
        "fixed": run_free_bench(
            page,
            family_label="fixed",
            toggle_test_id="mhr-free-fixed",
            slider_prefix="mhr-fixed",
            slider_state_section="pose",
            duration_ms=free_duration_ms,
            sample_ms=free_sample_ms,
        ),
        "blendExpression": run_free_combo_bench(
            page,
            family_label="blendExpression",
            toggle_test_ids=["mhr-free-blend", "mhr-free-expression"],
            slider_prefix="mhr-blend",
            slider_state_section="surfaceShape",
            duration_ms=free_duration_ms,
            sample_ms=free_sample_ms,
        ),
        "allFamilies": run_free_combo_bench(
            page,
            family_label="allFamilies",
            toggle_test_ids=[
                "mhr-free-scale",
                "mhr-free-blend",
                "mhr-free-expression",
                "mhr-free-pose",
                "mhr-free-fixed",
            ],
            slider_prefix=None,
            slider_state_section=None,
            duration_ms=free_duration_ms,
            sample_ms=free_sample_ms,
        ),
    }

    lod_switch = None
    if int(switch_to_lod) != int(lod):
        lod_switch = run_lod_switch_bench(
            page,
            current_lod=lod,
            target_lod=switch_to_lod,
            timeout_s=max(timeout_s, 30.0),
        )

    final_state = get_state(page)
    return {
        "ok": True,
        "baseUrl": base_url.rstrip("/"),
        "browser": "msedge",
        "lod": int(lod),
        "switchToLod": int(switch_to_lod),
        "boot": {
            "readyWallMs": boot_wall_ms,
            "vertexCount": int(ready.get("vertexCount", 0)),
            "jointCount": int(ready.get("jointCount", 0)),
            "frontHudFps": parse_fps_text(ready.get("frontHud")),
            "backendHudFps": parse_fps_text(ready.get("backendHud")),
        },
        "interactions": interactions,
        "freeFamilies": free_metrics,
        "lodSwitch": lod_switch,
        "finalState": {
            "requestedLod": int(final_state.get("requestedLod", -1)),
            "assetLod": int(final_state.get("assetLod", -1)),
            "derivedLod": int(final_state.get("derivedLod", -1)),
            "vertexCount": int(final_state.get("vertexCount", 0)),
            "jointCount": int(final_state.get("jointCount", 0)),
            "frontHudFps": parse_fps_text(final_state.get("frontHud")),
            "backendHudFps": parse_fps_text(final_state.get("backendHud")),
        },
    }


def open_ready_page(context, *, base_url: str, lod: int, timeout_s: float) -> tuple[Page, dict[str, Any], float]:
    page = context.new_page()
    started = time.perf_counter()
    page.goto(f"{base_url.rstrip('/')}/mhr.html?lod={int(lod)}&mhrTrace=1", wait_until="domcontentloaded")
    ready = wait_ready(page, lod, timeout_s)
    boot_wall_ms = (time.perf_counter() - started) * 1000.0
    return page, ready, boot_wall_ms


def close_page(page: Page | None) -> None:
    if page is None:
        return
    try:
        if not page.is_closed():
            page.close()
    except Exception:
        return


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("base_url", help="base URL for the local mjwp_inject server")
    parser.add_argument("--lod", type=int, default=1)
    parser.add_argument("--switch-to-lod", type=int, default=6)
    parser.add_argument("--timeout-s", type=float, default=DEFAULT_TIMEOUT_S)
    parser.add_argument("--free-duration-ms", type=int, default=DEFAULT_FREE_DURATION_MS)
    parser.add_argument("--free-sample-ms", type=int, default=DEFAULT_FREE_SAMPLE_MS)
    parser.add_argument("--out", default="", help="optional JSON output path")
    args = parser.parse_args()

    repo_root = repo_root_from_here(__file__)
    with sync_playwright() as playwright:
        browser = launch_browser(playwright)
        context = browser.new_context(viewport={"width": 1600, "height": 1200})
        result = None
        page = context.new_page()
        try:
            close_page(page)

            boot_page, ready, boot_wall_ms = open_ready_page(
                context,
                base_url=args.base_url,
                lod=args.lod,
                timeout_s=args.timeout_s,
            )
            boot = {
                "readyWallMs": boot_wall_ms,
                "vertexCount": int(ready.get("vertexCount", 0)),
                "jointCount": int(ready.get("jointCount", 0)),
                "frontHudFps": parse_fps_text(ready.get("frontHud")),
                "backendHudFps": parse_fps_text(ready.get("backendHud")),
            }
            close_page(boot_page)

            interactions_page, _, _ = open_ready_page(
                context,
                base_url=args.base_url,
                lod=args.lod,
                timeout_s=args.timeout_s,
            )
            interactions = {
                "scale": run_slider_bench(
                    interactions_page,
                    prefix="mhr-scale",
                    state_section="skeletalProportion",
                    label="scale-slider",
                    ratio=0.78,
                    preview_enabled=False,
                    timeout_s=args.timeout_s,
                ),
                "blend": run_slider_bench(
                    interactions_page,
                    prefix="mhr-blend",
                    state_section="surfaceShape",
                    label="blend-slider",
                    ratio=0.72,
                    preview_enabled=False,
                    timeout_s=args.timeout_s,
                ),
                "expression": run_slider_bench(
                    interactions_page,
                    prefix="mhr-expression",
                    state_section="expression",
                    label="expression-slider",
                    ratio=0.7,
                    preview_enabled=False,
                    timeout_s=args.timeout_s,
                ),
                "root": run_slider_bench(
                    interactions_page,
                    prefix="mhr-pose",
                    state_section="root",
                    label="root-slider",
                    ratio=0.68,
                    preview_enabled=False,
                    timeout_s=args.timeout_s,
                ),
                "pose": run_slider_bench(
                    interactions_page,
                    prefix="mhr-pose",
                    state_section="pose",
                    label="pose-slider",
                    ratio=0.68,
                    preview_enabled=False,
                    timeout_s=args.timeout_s,
                ),
                "previewBlend": run_slider_bench(
                    interactions_page,
                    prefix="mhr-blend",
                    state_section="surfaceShape",
                    label="blend-preview",
                    ratio=0.34,
                    preview_enabled=True,
                    timeout_s=args.timeout_s,
                ),
                "previewExpression": run_slider_bench(
                    interactions_page,
                    prefix="mhr-expression",
                    state_section="expression",
                    label="expression-preview",
                    ratio=0.3,
                    preview_enabled=True,
                    timeout_s=args.timeout_s,
                ),
            }
            close_page(interactions_page)

            free_configs = [
                ("scale", "mhr-free-scale", "mhr-scale", "skeletalProportion"),
                ("blend", "mhr-free-blend", "mhr-blend", "surfaceShape"),
                ("expression", "mhr-free-expression", "mhr-expression", "expression"),
                ("pose", "mhr-free-pose", "mhr-pose", "root"),
                ("fixed", "mhr-free-fixed", "mhr-fixed", None),
            ]
            free_combo_configs = [
                (
                    "blendExpression",
                    ["mhr-free-blend", "mhr-free-expression"],
                    "mhr-blend",
                    "surfaceShape",
                ),
                (
                    "allFamilies",
                    [
                        "mhr-free-scale",
                        "mhr-free-blend",
                        "mhr-free-expression",
                        "mhr-free-pose",
                        "mhr-free-fixed",
                    ],
                    None,
                    None,
                ),
            ]
            free_metrics = {}
            for family_label, toggle_test_id, slider_prefix, slider_state_section in free_configs:
                free_page, _, _ = open_ready_page(
                    context,
                    base_url=args.base_url,
                    lod=args.lod,
                    timeout_s=args.timeout_s,
                )
                try:
                    free_metrics[family_label] = run_free_bench(
                        free_page,
                        family_label=family_label,
                        toggle_test_id=toggle_test_id,
                        slider_prefix=slider_prefix,
                        slider_state_section=slider_state_section,
                        duration_ms=args.free_duration_ms,
                        sample_ms=args.free_sample_ms,
                    )
                finally:
                    close_page(free_page)
            for family_label, toggle_test_ids, slider_prefix, slider_state_section in free_combo_configs:
                free_page, _, _ = open_ready_page(
                    context,
                    base_url=args.base_url,
                    lod=args.lod,
                    timeout_s=args.timeout_s,
                )
                try:
                    free_metrics[family_label] = run_free_combo_bench(
                        free_page,
                        family_label=family_label,
                        toggle_test_ids=toggle_test_ids,
                        slider_prefix=slider_prefix,
                        slider_state_section=slider_state_section,
                        duration_ms=args.free_duration_ms,
                        sample_ms=args.free_sample_ms,
                    )
                finally:
                    close_page(free_page)

            lod_page, _, _ = open_ready_page(
                context,
                base_url=args.base_url,
                lod=args.lod,
                timeout_s=args.timeout_s,
            )
            lod_switch = None
            final_state = get_state(lod_page)
            if int(args.switch_to_lod) != int(args.lod):
                lod_switch = run_lod_switch_bench(
                    lod_page,
                    current_lod=args.lod,
                    target_lod=args.switch_to_lod,
                    timeout_s=max(args.timeout_s, 30.0),
                )
                final_state = get_state(lod_page)
            close_page(lod_page)

            result = {
                "ok": True,
                "baseUrl": args.base_url.rstrip("/"),
                "browser": "msedge",
                "lod": int(args.lod),
                "switchToLod": int(args.switch_to_lod),
                "boot": boot,
                "interactions": interactions,
                "freeFamilies": free_metrics,
                "lodSwitch": lod_switch,
                "finalState": {
                    "requestedLod": int(final_state.get("requestedLod", -1)),
                    "assetLod": int(final_state.get("assetLod", -1)),
                    "derivedLod": int(final_state.get("derivedLod", -1)),
                    "vertexCount": int(final_state.get("vertexCount", 0)),
                    "jointCount": int(final_state.get("jointCount", 0)),
                    "frontHudFps": parse_fps_text(final_state.get("frontHud")),
                    "backendHudFps": parse_fps_text(final_state.get("backendHud")),
                },
            }
        finally:
            try:
                context.close()
            except Exception:
                pass
            try:
                browser.close()
            except Exception:
                pass

    if result is None:
        raise RuntimeError("Performance bench did not produce a result.")

    serialized = json.dumps(result, indent=2)
    print(serialized)
    if args.out:
        out_path = Path(args.out)
        if not out_path.is_absolute():
            out_path = repo_root / out_path
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(serialized + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
