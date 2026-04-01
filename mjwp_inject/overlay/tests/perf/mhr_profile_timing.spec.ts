import { expect, test } from '@playwright/test';

import { waitForMhrProfileReady } from '../e2e/test-utils';

function percentile(values: number[], p: number) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, p));
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * clamped) - 1));
  return sorted[index];
}

function summarize(values: number[]) {
  return {
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : 0,
  };
}

function pickDistinctTarget(current: number, min: number, max: number, step: number, direction = 1) {
  const safeMin = Number.isFinite(min) ? min : -1;
  const safeMax = Number.isFinite(max) ? max : 1;
  const safeStep = Number.isFinite(step) && step > 0 ? step : Math.max((safeMax - safeMin) / 200, 0.001);
  const span = safeMax - safeMin;
  if (!(span > 0)) {
    return current;
  }
  const delta = Math.max(safeStep * 4, span * 0.18);
  let candidate = direction >= 0 ? current + delta : current - delta;
  if (candidate > safeMax) {
    candidate = current - delta;
  }
  if (candidate < safeMin) {
    candidate = current + delta;
  }
  candidate = Math.max(safeMin, Math.min(safeMax, candidate));
  const snapped = safeMin + (Math.round((candidate - safeMin) / safeStep) * safeStep);
  const clamped = Math.max(safeMin, Math.min(safeMax, snapped));
  if (Math.abs(clamped - current) <= (safeStep * 0.5)) {
    const fallback = direction >= 0
      ? Math.max(safeMin, Math.min(safeMax, current - delta))
      : Math.max(safeMin, Math.min(safeMax, current + delta));
    return safeMin + (Math.round((fallback - safeMin) / safeStep) * safeStep);
  }
  return clamped;
}

async function sampleTrace(page: any, selector: string, direction: number) {
  const locator = page.locator(selector).first();
  const info = await locator.evaluate((input: HTMLInputElement) => {
    const row = input.closest('.mhr-param-row');
    return {
      key: row?.getAttribute('data-mhr-param-key') ?? '',
      min: Number(input.min || '-1'),
      max: Number(input.max || '1'),
      step: Number(input.step || '0.001'),
      current: Number(input.value || '0'),
    };
  });
  const target = pickDistinctTarget(
    Number(info.current),
    Number(info.min),
    Number(info.max),
    Number(info.step),
    direction,
  );
  const previousTraceId = await page.evaluate(() => (window as any).__MHR_DEBUG_TRACE__?.traceId ?? null);
  await locator.evaluate((input: HTMLInputElement, value: number) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, target);
  await page.waitForFunction(({ prevTraceId, key }) => {
    const trace = (window as any).__MHR_DEBUG_TRACE__ ?? null;
    return (
      !!trace
      && trace.traceId !== prevTraceId
      && trace.parameterKey === key
      && !!trace.mainThread?.visuallySettledFrameTs
    );
  }, { prevTraceId: previousTraceId, key: info.key }, { timeout: 120000 });
  return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__MHR_DEBUG_TRACE__ ?? null)));
}

test('perf: mhr profile full official bundle timing trace', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await waitForMhrProfileReady(page, '/mhr.html?mhrTrace=1', { timeoutMs: 120_000 });

  const bundleInfo = await page.evaluate(() => {
    const snapshot = (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.() ?? null;
    return {
      bundleId: snapshot?.mhr?.assets?.bundleId ?? '',
      blendCount: document.querySelectorAll('[data-testid="section-plugin:mhr-blend"] .mhr-param-row').length,
      poseCount: document.querySelectorAll('[data-testid="section-plugin:mhr-pose"] .mhr-param-row').length,
    };
  });
  test.skip(!String(bundleInfo.bundleId || '').includes('official'), 'full official bundle unavailable');
  expect(bundleInfo.blendCount).toBeGreaterThan(0);
  expect(bundleInfo.poseCount).toBeGreaterThan(0);

  const pingSamples = await page.evaluate(async () => {
    const backend = (window as any).__PLAY_HOST__?.extensions?.mhr?.backend;
    if (!backend?.debugPing) {
      return [];
    }
    const samples = [];
    for (let index = 0; index < 12; index += 1) {
      const mainSentTs = performance.timeOrigin + performance.now();
      // eslint-disable-next-line no-await-in-loop
      const pong = await backend.debugPing(mainSentTs);
      samples.push({
        roundTripMs: Number(pong?.mainReceiveTs || 0) - Number(pong?.mainSentTs || 0),
        mainToWorkerMs: Number(pong?.workerReceiveTs || 0) - Number(pong?.mainSentTs || 0),
        workerToMainMs: Number(pong?.mainReceiveTs || 0) - Number(pong?.workerDispatchTs || 0),
      });
    }
    return samples;
  });

  const blendSelector = '[data-testid="section-plugin:mhr-blend"] input[type="range"]';
  const poseSelector = '[data-testid="section-plugin:mhr-pose"] .mhr-param-row[data-mhr-state-section="root"] input[type="range"]';

  const collectSummary = (traces: any[]) => {
    const stages: Record<string, number[]> = {
      ui_input_to_flush_ms: [],
      plugin_debounce_wait_ms: [],
      plugin_flush_to_setstate_send_ms: [],
      main_to_worker_setstate_ms: [],
      worker_merge_state_patch_ms: [],
      worker_build_raw_inputs_ms: [],
      wasm_copy_in_bridge_ms: [],
      wasm_evaluate_bridge_ms: [],
      wasm_evaluate_core_native_ms: [],
      wasm_copy_out_bridge_ms: [],
      worker_post_message_ms: [],
      main_event_to_geometry_start_ms: [],
      main_event_apply_publish_ms: [],
      geometry_apply_ms: [],
      normals_update_ms: [],
      skeleton_apply_ms: [],
      first_presented_after_geometry_ms: [],
      visually_settled_after_geometry_ms: [],
      end_to_end_input_to_settle_ms: [],
    };

    for (const trace of traces) {
      const plugin = trace?.plugin || {};
      const worker = trace?.worker || {};
      const wasmBridge = trace?.wasm?.bridge || {};
      const wasmNative = trace?.wasm?.native || {};
      const main = trace?.mainThread || {};

      stages.ui_input_to_flush_ms.push(Number(plugin.flushStartTs || 0) - Number(plugin.inputTs || 0));
      stages.plugin_debounce_wait_ms.push(Number(plugin.debounceWaitMs || 0));
      stages.plugin_flush_to_setstate_send_ms.push(Number(plugin.setStateDispatchTs || 0) - Number(plugin.flushStartTs || 0));
      stages.main_to_worker_setstate_ms.push(Number(worker.setStateReceivedTs || 0) - Number(plugin.setStateDispatchTs || 0));
      stages.worker_merge_state_patch_ms.push(Number(worker.mergeStatePatchMs || 0));
      stages.worker_build_raw_inputs_ms.push(Number(worker.buildRawInputsMs || 0));
      stages.wasm_copy_in_bridge_ms.push(Number(wasmBridge.parameterUploadMs || 0));
      stages.wasm_evaluate_bridge_ms.push(Number(wasmBridge.evaluateCallMs || 0));
      stages.wasm_evaluate_core_native_ms.push(Number(wasmNative.evaluateCoreMs || 0));
      stages.wasm_copy_out_bridge_ms.push(
        Number(wasmBridge.verticesExportMs || 0)
        + Number(wasmBridge.skeletonExportMs || 0)
        + Number(wasmBridge.derivedExportMs || 0),
      );
      stages.worker_post_message_ms.push(Number(main.evaluationEventReceiveTs || 0) - Number(worker.evaluationDispatchTs || 0));
      stages.main_event_to_geometry_start_ms.push(Number(main.eventToGeometryStartMs || 0));
      stages.main_event_apply_publish_ms.push(Number(main.eventApplyAndPublishMs || 0));
      stages.geometry_apply_ms.push(Number(main.geometryApplyMs || 0));
      stages.normals_update_ms.push(Number(main.normalsUpdateMs || 0));
      stages.skeleton_apply_ms.push(Number(main.skeletonApplyMs || 0));
      stages.first_presented_after_geometry_ms.push(Number(main.firstPresentedAfterGeometryMs || 0));
      stages.visually_settled_after_geometry_ms.push(Number(main.visuallySettledAfterGeometryMs || 0));
      stages.end_to_end_input_to_settle_ms.push(Number(main.visuallySettledFrameTs || 0) - Number(plugin.inputTs || 0));
    }

    return Object.fromEntries(
      Object.entries(stages).map(([key, values]) => [key, summarize(values)]),
    );
  };

  const blendTraces = [];
  const poseTraces = [];
  for (let index = 0; index < 30; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    blendTraces.push(await sampleTrace(page, blendSelector, index % 2 === 0 ? 1 : -1));
  }
  for (let index = 0; index < 30; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    poseTraces.push(await sampleTrace(page, poseSelector, index % 2 === 0 ? 1 : -1));
  }

  const summary = {
    bundleId: bundleInfo.bundleId,
    ping: {
      roundTripMs: summarize(pingSamples.map((sample: any) => Number(sample.roundTripMs || 0))),
      mainToWorkerMs: summarize(pingSamples.map((sample: any) => Number(sample.mainToWorkerMs || 0))),
      workerToMainMs: summarize(pingSamples.map((sample: any) => Number(sample.workerToMainMs || 0))),
    },
    blend: collectSummary(blendTraces),
    pose: collectSummary(poseTraces),
  };

  // eslint-disable-next-line no-console
  console.log('[mhr-perf-summary]', JSON.stringify(summary, null, 2));

  expect(summary.blend.end_to_end_input_to_settle_ms.median).toBeGreaterThan(0);
  expect(summary.pose.end_to_end_input_to_settle_ms.median).toBeGreaterThan(0);
});
