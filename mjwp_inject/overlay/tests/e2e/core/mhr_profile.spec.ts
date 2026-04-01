import { expect, test } from '@playwright/test';

import { waitForMhrProfileReady } from '../test-utils';

const MHR_DEMO_URL = '/mhr.html?assetManifest=/assets/mhr_demo/manifest.json&assetBase=/assets/mhr_demo/';

function pickDistinctTarget(
  current: number,
  min: number,
  max: number,
  step: number,
  direction = 1,
) {
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

test.describe('mhr profile', () => {
  test('boots mhr profile without mujoco panels and evaluates demo assets', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 900 });
    await waitForMhrProfileReady(page, '/mhr.html');

    await expect(page.locator('[data-testid="section-plugin:mhr-control"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="section-plugin:mhr-scale"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="section-plugin:mhr-blend"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="section-plugin:mhr-fixed"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="section-plugin:mhr-pose"]')).toHaveCount(1);
    await expect(page.locator('[data-testid^="section-plugin:mhr-"]')).toHaveCount(5);
    await expect(page.locator('[data-testid="mhr-align-view"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-capture-ghost"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-skin-visible"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-skeleton-visible"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-dark-theme"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-perf-hud"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-skin-half-transparent"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-joint-labels"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-joint-axes"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-free-scale"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-free-blend"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-free-pose"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-free-fixed"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-reset-scale"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-reset-blend"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-reset-fixed"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="mhr-reset-pose"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="section-file"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="panel-right"]')).toBeVisible();

    const result = await page.evaluate(() => {
      const host = (window as any).__PLAY_HOST__ ?? null;
      const mesh = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:mesh') ?? null;
      const scaleRows = Array.from(document.querySelectorAll('[data-testid="section-plugin:mhr-scale"] .mhr-param-row'));
      const blendRows = Array.from(document.querySelectorAll('[data-testid="section-plugin:mhr-blend"] .mhr-param-row'));
      const fixedRows = Array.from(document.querySelectorAll('[data-testid="section-plugin:mhr-fixed"] .mhr-param-row'));
      const poseRows = Array.from(document.querySelectorAll('[data-testid="section-plugin:mhr-pose"] .mhr-param-row'));
      const parameterMetadata = host?.services?.mhr?.snapshot?.()?.mhr?.assets?.parameterMetadata?.parameters
        ?? host?.extensions?.mhr?.getSnapshot?.()?.mhr?.assets?.parameterMetadata?.parameters
        ?? [];
      return {
        playSnapshot: host?.getSnapshot?.() ?? null,
        mhrSnapshot: host?.services?.mhr?.snapshot?.() ?? host?.extensions?.mhr?.getSnapshot?.() ?? null,
        visualSourceMode: (window as any).__viewerStore?.get?.()?.visualSourceMode ?? null,
        hasMhrService: !!host?.services?.mhr,
        extensionBoundToService: !!host?.extensions?.mhr?.service && host?.extensions?.mhr?.service === host?.services?.mhr,
        meshScale: mesh?.scale?.toArray?.() ?? null,
        meshMaterialType: mesh?.material?.type ?? null,
        meshTransparent: !!mesh?.material?.transparent,
        meshOpacity: Number(mesh?.material?.opacity ?? NaN),
        perfHudText: document.querySelector('[data-testid="mhr-perf-hud"]')?.textContent?.trim() ?? '',
        controlTitle: document.querySelector('[data-testid="section-plugin:mhr-control"] .section-toggle')?.textContent?.trim() ?? null,
        scaleTitle: document.querySelector('[data-testid="section-plugin:mhr-scale"] .section-toggle')?.textContent?.trim() ?? null,
        blendTitle: document.querySelector('[data-testid="section-plugin:mhr-blend"] .section-toggle')?.textContent?.trim() ?? null,
        fixedTitle: document.querySelector('[data-testid="section-plugin:mhr-fixed"] .section-toggle')?.textContent?.trim() ?? null,
        poseTitle: document.querySelector('[data-testid="section-plugin:mhr-pose"] .section-toggle')?.textContent?.trim() ?? null,
        fixedPanel: document.querySelector('[data-testid="section-plugin:mhr-fixed"]')?.closest('[data-testid="panel-right"]') ? 'right' : 'left',
        scaleSections: scaleRows.map((row) => row.getAttribute('data-mhr-state-section')),
        scaleKeys: scaleRows.map((row) => row.getAttribute('data-mhr-param-key')),
        scaleLabels: scaleRows.map((row) => row.querySelector('.mhr-param-name')?.textContent?.trim() ?? ''),
        scaleStackedFlags: scaleRows.map((row) => row.classList.contains('mhr-param-row--stacked')),
        blendSections: blendRows.map((row) => row.getAttribute('data-mhr-state-section')),
        blendKeys: blendRows.map((row) => row.getAttribute('data-mhr-param-key')),
        blendLabels: blendRows.map((row) => row.querySelector('.mhr-param-name')?.textContent?.trim() ?? ''),
        fixedSections: fixedRows.map((row) => row.getAttribute('data-mhr-state-section')),
        fixedKeys: fixedRows.map((row) => row.getAttribute('data-mhr-param-key')),
        fixedLabels: fixedRows.map((row) => row.querySelector('.mhr-param-name')?.textContent?.trim() ?? ''),
        fixedExpectedKeys: parameterMetadata
          .filter((parameter: any) => {
            const min = Number(parameter?.min);
            const max = Number(parameter?.max);
            return Number.isFinite(min) && Number.isFinite(max) && min === max;
          })
          .map((parameter: any) => String(parameter?.key || '')),
        poseSections: poseRows.map((row) => row.getAttribute('data-mhr-state-section')),
        poseKeys: poseRows.map((row) => row.getAttribute('data-mhr-param-key')),
        firstBlendStructure: blendRows[0]
          ? {
              lineCount: blendRows[0].classList.contains('control-row') ? 1 : 0,
              metaCount: blendRows[0].querySelectorAll('.mhr-param-meta').length,
              title: blendRows[0].querySelector('.mhr-param-name')?.textContent?.trim() ?? null,
              range: !!blendRows[0].querySelector('input[type="range"]'),
              text: !!blendRows[0].querySelector('input[type="text"]'),
            }
          : null,
      };
    });

    expect(Number(result.playSnapshot?.scn_ngeom || 0)).toBeGreaterThan(0);
    expect(result.hasMhrService).toBeTruthy();
    expect(result.extensionBoundToService).toBeTruthy();
    expect(result.visualSourceMode).toBe('preset-sun');
    expect(result.mhrSnapshot?.mhr?.status).toBe('evaluated');
    expect(result.mhrSnapshot?.mhr?.assets?.bundleId).toBeTruthy();
    expect(Number(result.mhrSnapshot?.mhr?.evaluation?.mesh?.vertexCount || 0)).toBeGreaterThan(0);
    expect(Number(result.mhrSnapshot?.mhr?.evaluation?.skeleton?.jointCount || 0)).toBeGreaterThan(0);
    expect(result.mhrSnapshot?.mhr?.assets?.parameterMetadata?.parameters?.length).toBeGreaterThan(0);
    expect(result.meshScale).toEqual([0.01, 0.01, 0.01]);
    expect(['MeshPhysicalMaterial', 'MeshStandardMaterial']).toContain(result.meshMaterialType);
    expect(result.meshTransparent).toBeFalsy();
    expect(result.meshOpacity).toBeCloseTo(1.0, 6);
    expect(result.perfHudText).toContain('Front');
    expect(result.perfHudText).toContain('Backend');
    expect(result.controlTitle).toBe('Control');
    expect(result.scaleTitle).toBe('Scale: skeletalProportion');
    expect(result.blendTitle).toBe('Blend: surfaceShape');
    expect(result.fixedTitle).toBe('Locked Parameters: skeletalProportion / pose');
    expect(result.poseTitle).toBe('Pose: root / pose');
    expect(result.fixedPanel).toBe('right');
    expect(result.scaleSections.every((section: string | null) => section === 'skeletalProportion')).toBeTruthy();
    expect(result.blendSections.every((section: string | null) => section === 'surfaceShape')).toBeTruthy();
    expect(result.fixedSections.every((section: string | null) => section === 'skeletalProportion' || section === 'pose')).toBeTruthy();
    expect(result.poseSections.every((section: string | null) => section === 'root' || section === 'pose')).toBeTruthy();
    expect(result.blendSections.includes('expression')).toBeFalsy();
    expect(result.poseSections.includes('expertRaw')).toBeFalsy();
    expect(result.scaleKeys.includes('spine0_rx_flexible')).toBeFalsy();
    expect(result.blendKeys.includes('spine0_rx_flexible')).toBeFalsy();
    expect(result.poseKeys.includes('spine0_rx_flexible')).toBeFalsy();
    expect(result.fixedKeys).toEqual(result.fixedExpectedKeys);
    expect(result.scaleLabels.every((label: string) => !label.startsWith('scale_'))).toBeTruthy();
    expect(result.scaleStackedFlags.every(Boolean)).toBeTruthy();
    expect(result.blendLabels.every((label: string) => !label.startsWith('blend_'))).toBeTruthy();
    expect(result.firstBlendStructure).toEqual({
      lineCount: 1,
      metaCount: 0,
      title: 'Identity Width',
      range: true,
      text: true,
    });
  });

  test('resets a full card through the top reset pill', async ({ page }) => {
    await waitForMhrProfileReady(page, MHR_DEMO_URL);

    const blendRowInfo = await page.locator('[data-testid="section-plugin:mhr-blend"] .mhr-param-row').first().evaluate((row) => {
      const range = row.querySelector('input[type="range"]') as HTMLInputElement | null;
      return {
        key: row.getAttribute('data-mhr-param-key'),
        section: row.getAttribute('data-mhr-state-section'),
        current: Number(range?.value || '0'),
        min: Number(range?.min || '-1'),
        max: Number(range?.max || '1'),
        step: Number(range?.step || '0.001'),
      };
    });
    const blendTarget = pickDistinctTarget(
      Number(blendRowInfo.current),
      Number(blendRowInfo.min),
      Number(blendRowInfo.max),
      Number(blendRowInfo.step),
      1,
    );
    const blendRange = page.locator(`[data-testid="mhr-blend-range-${blendRowInfo.key}"]`);
    const blendTextbox = page.locator(`[data-testid="mhr-blend-text-${blendRowInfo.key}"]`);
    const resetButton = page.locator('[data-testid="mhr-reset-blend"]');

    await expect(blendRange).toHaveCount(1);
    await expect(blendTextbox).toHaveCount(1);
    await expect(resetButton).toHaveCount(1);

    const before = await page.evaluate(() => {
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.()
        ?? (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.()
        ?? null;
      return Number(snapshot?.mhr?.revision || 0);
    });

    await blendRange.evaluate((input: HTMLInputElement, value: number) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, blendTarget);

    await page.waitForFunction(({ prevRevision, row, target }) => {
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.()
        ?? (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.()
        ?? null;
      const nextRevision = Number(snapshot?.mhr?.revision || 0);
      const nextValue = Number(snapshot?.mhr?.state?.[row.section]?.[row.key] ?? NaN);
      return (
        snapshot?.mhr?.status === 'evaluated'
        && nextRevision > prevRevision
        && Math.abs(nextValue - Number(target)) <= 1e-9
      );
    }, { prevRevision: before, row: blendRowInfo, target: blendTarget });

    const afterChange = await page.evaluate((row) => {
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.()
        ?? (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.()
        ?? null;
      return {
        revision: Number(snapshot?.mhr?.revision || 0),
        value: Number(snapshot?.mhr?.state?.[row.section]?.[row.key] ?? NaN),
      };
    }, blendRowInfo);
    expect(afterChange.value).toBeCloseTo(blendTarget, 12);

    await resetButton.click();

    await page.waitForFunction(({ prevRevision, row, expected }) => {
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.()
        ?? (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.()
        ?? null;
      const nextRevision = Number(snapshot?.mhr?.revision || 0);
      const nextValue = Number(snapshot?.mhr?.state?.[row.section]?.[row.key] ?? NaN);
      return (
        snapshot?.mhr?.status === 'evaluated'
        && nextRevision > prevRevision
        && Math.abs(nextValue - Number(expected)) <= 1e-9
      );
    }, { prevRevision: afterChange.revision, row: blendRowInfo, expected: blendRowInfo.current });

    const afterReset = await page.evaluate((row) => {
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.()
        ?? (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.()
        ?? null;
      const textbox = document.querySelector(`[data-testid="mhr-blend-text-${row.key}"]`) as HTMLInputElement | null;
      return {
        value: Number(snapshot?.mhr?.state?.[row.section]?.[row.key] ?? NaN),
        textboxValue: Number(textbox?.value ?? NaN),
      };
    }, blendRowInfo);
    expect(afterReset.value).toBeCloseTo(Number(blendRowInfo.current), 12);
    expect(afterReset.textboxValue).toBeCloseTo(Number(blendRowInfo.current), 12);
  });

  test('control card aligns the view and toggles half transparency', async ({ page }) => {
    await waitForMhrProfileReady(page, '/mhr.html');

    const canvas = page.locator('[data-testid="viewer-canvas"]');
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();

    const alignButton = page.locator('[data-testid="mhr-align-view"]');
    const ghostButton = page.locator('[data-testid="mhr-capture-ghost"]');
    const skinVisibleToggle = page.locator('[data-testid="mhr-skin-visible"]');
    const skeletonVisibleToggle = page.locator('[data-testid="mhr-skeleton-visible"]');
    const transparencyToggle = page.locator('[data-testid="mhr-skin-half-transparent"]');
    const jointLabelsToggle = page.locator('[data-testid="mhr-joint-labels"]');
    const localAxesToggle = page.locator('[data-testid="mhr-joint-axes"]');
    const influencePreviewToggle = page.locator('[data-testid="mhr-influence-preview"]');
    const freeScaleToggle = page.locator('[data-testid="mhr-free-scale"]');
    const freeBlendToggle = page.locator('[data-testid="mhr-free-blend"]');
    const controlSection = page.locator('[data-testid="section-plugin:mhr-control"]');
    await expect(alignButton).toHaveCount(1);
    await expect(ghostButton).toHaveCount(1);
    await expect(skinVisibleToggle).toHaveCount(1);
    await expect(skeletonVisibleToggle).toHaveCount(1);
    await expect(transparencyToggle).toHaveCount(1);
    await expect(jointLabelsToggle).toHaveCount(1);
    await expect(localAxesToggle).toHaveCount(1);
    await expect(influencePreviewToggle).toHaveCount(1);
    await expect(freeScaleToggle).toHaveCount(1);
    await expect(freeBlendToggle).toHaveCount(1);

    const controlSectionBox = await controlSection.boundingBox();
    const alignBox = await alignButton.boundingBox();
    const ghostBox = await ghostButton.boundingBox();
    const skinToggleBox = await skinVisibleToggle.boundingBox();
    const skeletonToggleBox = await skeletonVisibleToggle.boundingBox();
    const transparencyToggleBox = await transparencyToggle.boundingBox();
    const labelsToggleBox = await jointLabelsToggle.boundingBox();
    const localAxesToggleBox = await localAxesToggle.boundingBox();
    const influencePreviewToggleBox = await influencePreviewToggle.boundingBox();
    const freeScaleToggleBox = await freeScaleToggle.boundingBox();
    const freeBlendToggleBox = await freeBlendToggle.boundingBox();
    expect(controlSectionBox).toBeTruthy();
    expect(alignBox).toBeTruthy();
    expect(ghostBox).toBeTruthy();
    expect(skinToggleBox).toBeTruthy();
    expect((alignBox?.width || 0)).toBeLessThan((controlSectionBox?.width || 0) * 0.55);
    expect((ghostBox?.width || 0)).toBeLessThan((controlSectionBox?.width || 0) * 0.55);
    expect(Math.abs((ghostBox?.y || 0) - (alignBox?.y || 0))).toBeLessThanOrEqual(2);
    expect((skinToggleBox?.width || 0)).toBeLessThan((controlSectionBox?.width || 0) * 0.55);
    expect((skeletonToggleBox?.width || 0)).toBeLessThan((controlSectionBox?.width || 0) * 0.55);
    expect(Math.abs((skeletonToggleBox?.y || 0) - (skinToggleBox?.y || 0))).toBeLessThanOrEqual(2);
    expect((skinToggleBox?.y || 0)).toBeGreaterThan((alignBox?.y || 0) + 4);
    expect((transparencyToggleBox?.width || 0)).toBeLessThan((controlSectionBox?.width || 0) * 0.55);
    expect((labelsToggleBox?.width || 0)).toBeLessThan((controlSectionBox?.width || 0) * 0.55);
    expect(Math.abs((labelsToggleBox?.y || 0) - (transparencyToggleBox?.y || 0))).toBeLessThanOrEqual(2);
    expect((transparencyToggleBox?.y || 0)).toBeGreaterThan((skinToggleBox?.y || 0) + 4);
    expect((localAxesToggleBox?.width || 0)).toBeLessThan((controlSectionBox?.width || 0) * 0.55);
    expect((influencePreviewToggleBox?.width || 0)).toBeLessThan((controlSectionBox?.width || 0) * 0.55);
    expect(Math.abs((influencePreviewToggleBox?.y || 0) - (localAxesToggleBox?.y || 0))).toBeLessThanOrEqual(2);
    expect((localAxesToggleBox?.y || 0)).toBeGreaterThan((transparencyToggleBox?.y || 0) + 4);
    expect((freeScaleToggleBox?.width || 0)).toBeLessThan((controlSectionBox?.width || 0) * 0.55);
    expect((freeBlendToggleBox?.width || 0)).toBeLessThan((controlSectionBox?.width || 0) * 0.55);
    expect(Math.abs((freeBlendToggleBox?.y || 0) - (freeScaleToggleBox?.y || 0))).toBeLessThanOrEqual(2);
    expect((freeScaleToggleBox?.y || 0)).toBeGreaterThan((localAxesToggleBox?.y || 0) + 4);

    const freeBlendWarning = page.locator('[data-testid="section-plugin:mhr-control"] .control-static').filter({ hasText: '* Free blend can be unsettling.' });
    await expect(freeBlendWarning).toHaveCount(1);

    const before = await page.evaluate(() => {
      const ctx = (window as any).__renderCtx;
      const mesh = ctx?.scene?.getObjectByName?.('mhr-profile:mesh') ?? null;
      const skeleton = ctx?.scene?.getObjectByName?.('mhr-profile:skeleton-bones') ?? null;
      return {
        position: ctx?.camera?.position?.toArray?.() ?? null,
        opacity: Number(mesh?.material?.opacity ?? NaN),
        meshVisible: !!mesh?.visible,
        skeletonVisible: !!skeleton?.visible,
        checked: !!(document.querySelector('[data-testid="mhr-skin-half-transparent"]') as HTMLInputElement | null)?.checked,
      };
    });
    expect(before.opacity).toBeCloseTo(1.0, 6);
    expect(before.meshVisible).toBeTruthy();
    expect(before.skeletonVisible).toBeTruthy();
    expect(before.checked).toBeFalsy();

    const cx = (box?.x || 0) + (box?.width || 0) * 0.5;
    const cy = (box?.y || 0) + (box?.height || 0) * 0.5;
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'left' });
    await page.mouse.move(cx + 120, cy + 36);
    await page.mouse.up({ button: 'left' });

    const afterDrag = await page.evaluate(() => {
      const ctx = (window as any).__renderCtx;
      return {
        position: ctx?.camera?.position?.toArray?.() ?? null,
        target: ctx?.cameraTarget?.toArray?.() ?? null,
      };
    });

    await alignButton.click();

    await page.waitForFunction((dragPose) => {
      const ctx = (window as any).__renderCtx;
      const position = (window as any).__renderCtx?.camera?.position?.toArray?.() ?? null;
      const target = ctx?.cameraTarget?.toArray?.() ?? null;
      if (!Array.isArray(position) || !Array.isArray(target) || !Array.isArray(dragPose?.position)) {
        return false;
      }
      const movedFromDrag = Math.max(
        Math.abs((position[0] ?? 0) - (dragPose.position[0] ?? 0)),
        Math.abs((position[1] ?? 0) - (dragPose.position[1] ?? 0)),
        Math.abs((position[2] ?? 0) - (dragPose.position[2] ?? 0)),
      ) > 1e-3;
      const centeredX = Math.abs((position[0] ?? 0) - (target[0] ?? 0)) <= 0.25;
      return movedFromDrag && centeredX;
    }, afterDrag);

    await skinVisibleToggle.click();
    await page.waitForFunction(() => {
      const mesh = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:mesh') ?? null;
      const checked = !!(document.querySelector('[data-testid="mhr-skin-visible"]') as HTMLInputElement | null)?.checked;
      return !checked && !mesh?.visible;
    });

    await skeletonVisibleToggle.click();
    await page.waitForFunction(() => {
      const skeleton = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:skeleton-bones') ?? null;
      const checked = !!(document.querySelector('[data-testid="mhr-skeleton-visible"]') as HTMLInputElement | null)?.checked;
      return !checked && !skeleton?.visible;
    });

    await freeScaleToggle.click();
    await page.waitForTimeout(180);
    const freeScaleDidNotPolluteSkeleton = await page.evaluate(() => {
      const skeleton = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:skeleton-bones') ?? null;
      const skeletonChecked = !!(document.querySelector('[data-testid="mhr-skeleton-visible"]') as HTMLInputElement | null)?.checked;
      const freeScaleChecked = !!(document.querySelector('[data-testid="mhr-free-scale"]') as HTMLInputElement | null)?.checked;
      return {
        skeletonChecked,
        skeletonVisible: !!skeleton?.visible,
        freeScaleChecked,
      };
    });
    expect(freeScaleDidNotPolluteSkeleton.freeScaleChecked).toBeTruthy();
    expect(freeScaleDidNotPolluteSkeleton.skeletonChecked).toBeFalsy();
    expect(freeScaleDidNotPolluteSkeleton.skeletonVisible).toBeFalsy();
    await freeScaleToggle.click();

    await skinVisibleToggle.click();
    await skeletonVisibleToggle.click();
    await page.waitForFunction(() => {
      const mesh = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:mesh') ?? null;
      const skeleton = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:skeleton-bones') ?? null;
      const skinChecked = !!(document.querySelector('[data-testid="mhr-skin-visible"]') as HTMLInputElement | null)?.checked;
      const skeletonChecked = !!(document.querySelector('[data-testid="mhr-skeleton-visible"]') as HTMLInputElement | null)?.checked;
      return skinChecked && skeletonChecked && !!mesh?.visible && !!skeleton?.visible;
    });

    await transparencyToggle.click();
    await page.waitForFunction(() => {
      const mesh = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:mesh') ?? null;
      const checked = !!(document.querySelector('[data-testid="mhr-skin-half-transparent"]') as HTMLInputElement | null)?.checked;
      return checked
        && !!mesh?.material?.transparent
        && Math.abs(Number(mesh?.material?.opacity ?? NaN) - 0.5) <= 1e-9;
    });

    await jointLabelsToggle.click();
    await page.waitForFunction(() => {
      const overlay = (window as any).__renderCtx?.labelOverlay ?? null;
      const checked = !!(document.querySelector('[data-testid="mhr-joint-labels"]') as HTMLInputElement | null)?.checked;
      const sample = overlay?.mhrJointLabelsSample?.screen ?? null;
      return checked
        && Number(overlay?.mhrJointLabelsDrawn || 0) > 1
        && String(overlay?.mhrJointLabelsSample?.text || '').length > 0
        && Array.isArray(sample)
        && Number(sample[0]) > 0
        && Number(sample[1]) > 0
        && Number(sample[0]) < Number(overlay?.width || 0)
        && Number(sample[1]) < Number(overlay?.height || 0);
    });

    await localAxesToggle.click();
    await page.waitForFunction(() => {
      const scene = (window as any).__renderCtx?.scene ?? null;
      const axes = [
        scene?.getObjectByName?.('mhr-profile:joint-axis-x') ?? null,
        scene?.getObjectByName?.('mhr-profile:joint-axis-y') ?? null,
        scene?.getObjectByName?.('mhr-profile:joint-axis-z') ?? null,
      ];
      const checked = !!(document.querySelector('[data-testid="mhr-joint-axes"]') as HTMLInputElement | null)?.checked;
      return checked && axes.every((axis) => !!axis?.visible);
    });

    await page.locator('[data-testid="section-plugin:mhr-blend"] .mhr-param-row').first().click();
    await influencePreviewToggle.click();

    const previewDragInfo = await page.locator('[data-testid="section-plugin:mhr-blend"] .mhr-param-row').first().evaluate((row) => {
      const range = row.querySelector('input[type="range"]') as HTMLInputElement | null;
      return {
        key: row.getAttribute('data-mhr-param-key'),
        current: Number(range?.value || '0'),
        min: Number(range?.min || '-1'),
        max: Number(range?.max || '1'),
        step: Number(range?.step || '0.001'),
      };
    });
    const previewDragTarget = pickDistinctTarget(
      Number(previewDragInfo.current),
      Number(previewDragInfo.min),
      Number(previewDragInfo.max),
      Number(previewDragInfo.step),
      1,
    );
    await page.locator(`[data-testid="mhr-blend-range-${previewDragInfo.key}"]`).evaluate((input: HTMLInputElement, value: number) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, previewDragTarget);
    await page.waitForFunction(() => {
      const previewOverlay = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:influence-preview') ?? null;
      const mesh = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:mesh') ?? null;
      const colorAttr = mesh?.geometry?.getAttribute?.('color') ?? null;
      if (previewOverlay || !mesh?.visible || !colorAttr?.array) {
        return false;
      }
      const baseR = Number(colorAttr.array[0] || 0);
      const baseG = Number(colorAttr.array[1] || 0);
      const baseB = Number(colorAttr.array[2] || 0);
      for (let index = 3; index < colorAttr.array.length; index += 24) {
        const r = Number(colorAttr.array[index] || 0);
        const g = Number(colorAttr.array[index + 1] || 0);
        const b = Number(colorAttr.array[index + 2] || 0);
        if (Math.abs(r - baseR) > 1e-3 || Math.abs(g - baseG) > 1e-3 || Math.abs(b - baseB) > 1e-3) {
          return true;
        }
      }
      return false;
    });
    await page.waitForTimeout(48);
    const previewStayedVisibleDuringDrag = await page.evaluate(() => {
      const mesh = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:mesh') ?? null;
      const colorAttr = mesh?.geometry?.getAttribute?.('color') ?? null;
      if (!mesh?.visible || !colorAttr?.array) {
        return false;
      }
      const baseR = Number(colorAttr.array[0] || 0);
      const baseG = Number(colorAttr.array[1] || 0);
      const baseB = Number(colorAttr.array[2] || 0);
      for (let index = 3; index < colorAttr.array.length; index += 24) {
        const r = Number(colorAttr.array[index] || 0);
        const g = Number(colorAttr.array[index + 1] || 0);
        const b = Number(colorAttr.array[index + 2] || 0);
        if (Math.abs(r - baseR) > 1e-3 || Math.abs(g - baseG) > 1e-3 || Math.abs(b - baseB) > 1e-3) {
          return true;
        }
      }
      return false;
    });
    expect(previewStayedVisibleDuringDrag).toBeTruthy();

    await influencePreviewToggle.click();
    await page.waitForFunction(() => {
      const mesh = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:mesh') ?? null;
      const colorAttr = mesh?.geometry?.getAttribute?.('color') ?? null;
      const checked = !!(document.querySelector('[data-testid="mhr-influence-preview"]') as HTMLInputElement | null)?.checked;
      if (checked || !colorAttr?.array) {
        return false;
      }
      const baseR = Number(colorAttr.array[0] || 0);
      const baseG = Number(colorAttr.array[1] || 0);
      const baseB = Number(colorAttr.array[2] || 0);
      for (let index = 3; index < colorAttr.array.length; index += 24) {
        const r = Number(colorAttr.array[index] || 0);
        const g = Number(colorAttr.array[index + 1] || 0);
        const b = Number(colorAttr.array[index + 2] || 0);
        if (Math.abs(r - baseR) > 1e-3 || Math.abs(g - baseG) > 1e-3 || Math.abs(b - baseB) > 1e-3) {
          return false;
        }
      }
      return true;
    });

    await ghostButton.click();
    await page.waitForFunction(() => {
      const ghost = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:ghost') ?? null;
      return !!ghost?.visible;
    });

    await ghostButton.click();
    await page.waitForFunction(() => {
      const ghost = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:ghost') ?? null;
      return !ghost?.visible;
    });

    await transparencyToggle.click();
    await page.waitForFunction(() => {
      const mesh = (window as any).__renderCtx?.scene?.getObjectByName?.('mhr-profile:mesh') ?? null;
      const checked = !!(document.querySelector('[data-testid="mhr-skin-half-transparent"]') as HTMLInputElement | null)?.checked;
      return !checked
        && !mesh?.material?.transparent
        && Math.abs(Number(mesh?.material?.opacity ?? NaN) - 1.0) <= 1e-9;
    });
  });

  test('control card toggles dark theme through play theme state', async ({ page }) => {
    await waitForMhrProfileReady(page, '/mhr.html');

    const darkThemeToggle = page.locator('[data-testid="mhr-dark-theme"]');
    await expect(darkThemeToggle).toHaveCount(1);

    const before = await page.evaluate(() => ({
      themeClass: document.body.classList.contains('theme-light'),
      themeAttr: document.documentElement.getAttribute('data-play-theme'),
      themeColor: Number((window as any).__viewerStore?.get?.()?.theme?.color ?? NaN),
      checked: !!(document.querySelector('[data-testid="mhr-dark-theme"]') as HTMLInputElement | null)?.checked,
    }));
    expect(before).toEqual({
      themeClass: false,
      themeAttr: null,
      themeColor: 0,
      checked: true,
    });

    await darkThemeToggle.click();
    await page.waitForFunction(() => {
      const checked = !!(document.querySelector('[data-testid="mhr-dark-theme"]') as HTMLInputElement | null)?.checked;
      return !checked
        && document.body.classList.contains('theme-light')
        && document.documentElement.getAttribute('data-play-theme') === 'light'
        && Number((window as any).__viewerStore?.get?.()?.theme?.color ?? NaN) === 1;
    });

    await darkThemeToggle.click();
    await page.waitForFunction(() => {
      const checked = !!(document.querySelector('[data-testid="mhr-dark-theme"]') as HTMLInputElement | null)?.checked;
      return checked
        && !document.body.classList.contains('theme-light')
        && document.documentElement.getAttribute('data-play-theme') === null
        && Number((window as any).__viewerStore?.get?.()?.theme?.color ?? NaN) === 0;
    });
  });

  test('family random toggles drive continuous interactive changes', async ({ page }) => {
    await waitForMhrProfileReady(page, '/mhr.html');

    const firstScaleRow = page.locator('[data-testid="section-plugin:mhr-scale"] .mhr-param-row').first();
    await expect(firstScaleRow).toHaveCount(1);
    const firstScaleKey = await firstScaleRow.evaluate((row) => ({
      key: String(row.getAttribute('data-mhr-param-key') || ''),
      section: String(row.getAttribute('data-mhr-state-section') || ''),
    }));
    const scaleToggle = page.locator('[data-testid="mhr-free-scale"]');
    await expect(scaleToggle).toHaveCount(1);

    const before = await page.evaluate((row) => {
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? null;
      return {
        revision: Number(snapshot?.mhr?.revision || 0),
        value: Number(snapshot?.mhr?.state?.[row.section]?.[row.key] ?? NaN),
      };
    }, firstScaleKey);

    await scaleToggle.click();

    await page.waitForFunction(({ row, revision, value }) => {
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? null;
      const nextRevision = Number(snapshot?.mhr?.revision || 0);
      const nextValue = Number(snapshot?.mhr?.state?.[row.section]?.[row.key] ?? NaN);
      return nextRevision > revision && Math.abs(nextValue - Number(value)) > 1e-5;
    }, { row: firstScaleKey, revision: before.revision, value: before.value });

    const firstMove = await page.evaluate((row) => {
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? null;
      return {
        revision: Number(snapshot?.mhr?.revision || 0),
        value: Number(snapshot?.mhr?.state?.[row.section]?.[row.key] ?? NaN),
      };
    }, firstScaleKey);

    await page.waitForFunction(({ row, revision, value }) => {
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? null;
      const nextRevision = Number(snapshot?.mhr?.revision || 0);
      const nextValue = Number(snapshot?.mhr?.state?.[row.section]?.[row.key] ?? NaN);
      return nextRevision > revision && Math.abs(nextValue - Number(value)) > 1e-5;
    }, { row: firstScaleKey, revision: firstMove.revision, value: firstMove.value });

    await scaleToggle.click();
    await page.waitForFunction((row) => {
      const input = document.querySelector('[data-testid="mhr-free-scale"]') as HTMLInputElement | null;
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? null;
      const value = Number(snapshot?.mhr?.state?.[row.section]?.[row.key] ?? NaN);
      return !input?.checked && Number.isFinite(value);
    }, firstScaleKey);
  });

  test('free pose animates pose controls without drifting the root state', async ({ page }) => {
    await waitForMhrProfileReady(page, '/mhr.html');

    const rowInfo = await page.evaluate(() => {
      const poseRows = Array.from(document.querySelectorAll('[data-testid="section-plugin:mhr-pose"] .mhr-param-row'));
      const rootRows = poseRows
        .filter((row) => row.getAttribute('data-mhr-state-section') === 'root')
        .map((row) => ({
          key: String(row.getAttribute('data-mhr-param-key') || ''),
          section: String(row.getAttribute('data-mhr-state-section') || ''),
        }))
        .filter((row) => row.key && row.section);
      const poseRow = poseRows.find((row) => (
        row.getAttribute('data-mhr-state-section') === 'pose'
        && !String(row.getAttribute('data-mhr-param-key') || '').startsWith('root')
      ));
      return {
        roots: rootRows,
        pose: poseRow
          ? {
              key: String(poseRow.getAttribute('data-mhr-param-key') || ''),
              section: String(poseRow.getAttribute('data-mhr-state-section') || ''),
            }
          : null,
      };
    });

    expect(rowInfo.roots.length).toBeGreaterThan(0);
    expect(rowInfo.pose?.key).toBeTruthy();

    const before = await page.evaluate(({ roots, pose }) => {
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? null;
      return {
        revision: Number(snapshot?.mhr?.revision || 0),
        rootValues: roots.map((root: { section: string; key: string }) => Number(
          snapshot?.mhr?.state?.[root.section]?.[root.key] ?? NaN,
        )),
        poseValue: Number(snapshot?.mhr?.state?.[pose.section]?.[pose.key] ?? NaN),
      };
    }, rowInfo);

    const freePoseToggle = page.locator('[data-testid="mhr-free-pose"]');
    await expect(freePoseToggle).toHaveCount(1);
    await freePoseToggle.click();

    await page.waitForFunction(({ roots, pose, before }) => {
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? null;
      const revision = Number(snapshot?.mhr?.revision || 0);
      const rootValues = roots.map((root: { section: string; key: string }) => Number(
        snapshot?.mhr?.state?.[root.section]?.[root.key] ?? NaN,
      ));
      const poseValue = Number(snapshot?.mhr?.state?.[pose.section]?.[pose.key] ?? NaN);
      return (
        revision > before.revision
        && Math.abs(poseValue - before.poseValue) > 1e-5
        && rootValues.every((value: number, index: number) => Math.abs(value - before.rootValues[index]) <= 1e-9)
      );
    }, { ...rowInfo, before });

    await freePoseToggle.click();
    await expect(freePoseToggle).not.toBeChecked();
  });

  test('free locked keeps fixed-slot animation within a tight range', async ({ page }) => {
    await waitForMhrProfileReady(page, '/mhr.html');

    const target = { key: 'spine0_rx_flexible', section: 'skeletalProportion' };
    const before = await page.evaluate((row) => {
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? null;
      return {
        revision: Number(snapshot?.mhr?.revision || 0),
        value: Number(snapshot?.mhr?.state?.[row.section]?.[row.key] ?? NaN),
      };
    }, target);

    const freeLockedToggle = page.locator('[data-testid="mhr-free-fixed"]');
    await expect(freeLockedToggle).toHaveCount(1);
    await freeLockedToggle.click();

    await page.waitForFunction(({ row, before }) => {
      const snapshot = (window as any).__PLAY_HOST__?.services?.mhr?.snapshot?.() ?? null;
      const revision = Number(snapshot?.mhr?.revision || 0);
      const value = Number(snapshot?.mhr?.state?.[row.section]?.[row.key] ?? NaN);
      return (
        revision > before.revision
        && Math.abs(value - before.value) > 1e-5
        && Math.abs(value) <= 0.601
      );
    }, { row: target, before });

    await freeLockedToggle.click();
    await expect(freeLockedToggle).not.toBeChecked();
  });

  test('commits slider input immediately and textbox edits only on blur', async ({ page }) => {
    await waitForMhrProfileReady(page, MHR_DEMO_URL);

    const scaleRowInfo = await page.locator('[data-testid="section-plugin:mhr-blend"] .mhr-param-row').first().evaluate((row) => {
      const range = row.querySelector('input[type="range"]') as HTMLInputElement | null;
      return {
        key: row.getAttribute('data-mhr-param-key'),
        section: row.getAttribute('data-mhr-state-section'),
        min: Number(range?.min || '-1'),
        max: Number(range?.max || '1'),
        step: Number(range?.step || '0.001'),
        current: Number(range?.value || '0'),
      };
    });
    const scaleTargetA = pickDistinctTarget(
      Number(scaleRowInfo.current),
      Number(scaleRowInfo.min),
      Number(scaleRowInfo.max),
      Number(scaleRowInfo.step),
      1,
    );
    const scaleTargetB = pickDistinctTarget(
      scaleTargetA,
      Number(scaleRowInfo.min),
      Number(scaleRowInfo.max),
      Number(scaleRowInfo.step),
      -1,
    );

    const firstRange = page.locator('[data-testid^="mhr-blend-range-"]').first();
    await expect(firstRange).toHaveCount(1);

    const before = await page.evaluate(() => {
      const snapshot = (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.() ?? null;
      return Number(snapshot?.mhr?.revision || 0);
    });

    await firstRange.evaluate((input: HTMLInputElement, value: number) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, scaleTargetA);

    await page.waitForFunction(({ prevRevision, row, target }) => {
      const snapshot = (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.() ?? null;
      const nextRevision = Number(snapshot?.mhr?.revision || 0);
      const section = row?.section || '';
      const key = row?.key || '';
      const nextValue = Number(snapshot?.mhr?.state?.[section]?.[key] ?? NaN);
      return (
        snapshot?.mhr?.status === 'evaluated'
        && nextRevision > prevRevision
        && Math.abs(nextValue - Number(target)) <= 1e-9
      );
    }, { prevRevision: before, row: scaleRowInfo, target: scaleTargetA });

    const afterSlider = await page.evaluate(() => {
      const snapshot = (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.() ?? null;
      return {
        revision: Number(snapshot?.mhr?.revision || 0),
        state: snapshot?.mhr?.state ?? null,
      };
    });
    expect(afterSlider.revision).toBeGreaterThan(before);

    const poseRowInfo = await page.locator('[data-testid="section-plugin:mhr-pose"] .mhr-param-row').first().evaluate((row) => ({
      key: row.getAttribute('data-mhr-param-key'),
      section: row.getAttribute('data-mhr-state-section'),
      current: Number((row.querySelector('input[type="range"]') as HTMLInputElement | null)?.value || '0'),
      min: Number((row.querySelector('input[type="range"]') as HTMLInputElement | null)?.min || '-1'),
      max: Number((row.querySelector('input[type="range"]') as HTMLInputElement | null)?.max || '1'),
      step: Number((row.querySelector('input[type="range"]') as HTMLInputElement | null)?.step || '0.001'),
    }));
    const poseTarget = pickDistinctTarget(
      Number(poseRowInfo.current),
      Number(poseRowInfo.min),
      Number(poseRowInfo.max),
      Number(poseRowInfo.step),
      1,
    ).toString();
    const poseTextbox = page.locator('[data-testid^="mhr-pose-text-"]').first();
    await expect(poseTextbox).toHaveCount(1);

    await poseTextbox.evaluate((input: HTMLInputElement, value: string) => {
      input.focus();
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, poseTarget);

    await page.waitForTimeout(180);

    const revisionAfterTyping = await page.evaluate(() => {
      const snapshot = (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.() ?? null;
      return Number(snapshot?.mhr?.revision || 0);
    });
    expect(revisionAfterTyping).toBe(afterSlider.revision);

    await firstRange.evaluate((input: HTMLInputElement, values: number[]) => {
      for (const value of values) {
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, [scaleTargetB, scaleTargetA, scaleTargetB]);

    await page.waitForFunction(({ prevRevision, row, target }) => {
      const snapshot = (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.() ?? null;
      const nextRevision = Number(snapshot?.mhr?.revision || 0);
      const section = row?.section || '';
      const key = row?.key || '';
      const nextValue = Number(snapshot?.mhr?.state?.[section]?.[key] ?? NaN);
      return (
        snapshot?.mhr?.status === 'evaluated'
        && nextRevision > prevRevision
        && Math.abs(nextValue - Number(target)) <= 1e-9
      );
    }, { prevRevision: afterSlider.revision, row: scaleRowInfo, target: scaleTargetB });

    const duringEdit = await page.evaluate((row) => {
      const snapshot = (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.() ?? null;
      const section = row?.section || '';
      const key = row?.key || '';
      const textbox = document.querySelector(`[data-testid="mhr-pose-text-${key}"]`) as HTMLInputElement | null;
      return {
        revision: Number(snapshot?.mhr?.revision || 0),
        value: snapshot?.mhr?.state?.[section]?.[key] ?? null,
        textboxValue: textbox?.value ?? null,
      };
    }, poseRowInfo);

    expect(duringEdit.revision).toBeGreaterThan(afterSlider.revision);
    expect(Number(duringEdit.value)).not.toBe(Number(poseTarget));
    expect(duringEdit.textboxValue).toBe(poseTarget);

    await poseTextbox.evaluate((input: HTMLInputElement) => {
      input.blur();
    });

    await page.waitForFunction(({ prevRevision, row }) => {
      const snapshot = (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.() ?? null;
      const nextRevision = Number(snapshot?.mhr?.revision || 0);
      if (!(nextRevision > prevRevision)) return false;
      const section = row?.section || '';
      const key = row?.key || '';
      return Math.abs(
        Number(snapshot?.mhr?.state?.[section]?.[key] ?? NaN) - Number(row?.target ?? NaN),
      ) <= 1e-9;
    }, { prevRevision: duringEdit.revision, row: { ...poseRowInfo, target: poseTarget } });
  });

  test('keeps fixed raw slots unclamped and echoes them through runtime debug', async ({ page }) => {
    await page.setViewportSize({ width: 1320, height: 960 });
    await waitForMhrProfileReady(page, '/mhr.html?mhrTrace=1');

    const bundleInfo = await page.evaluate(() => {
      const snapshot = (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.() ?? null;
      return {
        bundleId: snapshot?.mhr?.assets?.bundleId ?? '',
        fixedCount: document.querySelectorAll('[data-testid="section-plugin:mhr-fixed"] .mhr-param-row').length,
      };
    });
    test.skip(!String(bundleInfo.bundleId || '').includes('official'), 'full official bundle is unavailable');
    expect(bundleInfo.fixedCount).toBeGreaterThanOrEqual(24);

    const targetValue = 12.345;
    const targetKey = 'spine0_rx_flexible';
    const textbox = page.locator(`[data-testid="mhr-fixed-text-${targetKey}"]`);
    await expect(textbox).toHaveCount(1);

    await textbox.evaluate((input: HTMLInputElement, value: string) => {
      input.focus();
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(targetValue));
    await textbox.evaluate((input: HTMLInputElement) => {
      input.blur();
    });

    await page.waitForFunction(({ key, target }) => {
      const snapshot = (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.() ?? null;
      const stateValue = Number(snapshot?.mhr?.state?.skeletalProportion?.[key] ?? NaN);
      const echoed = Number(snapshot?.mhr?.evaluation?.debug?.fixedSlotEcho?.[key]?.value ?? NaN);
      const trace = (window as any).__MHR_DEBUG_TRACE__ ?? null;
      return (
        snapshot?.mhr?.status === 'evaluated'
        && Math.abs(stateValue - target) <= 1e-9
        && Math.abs(echoed - target) <= 1e-4
        && !!trace?.worker
        && !!trace?.wasm
      );
    }, { key: targetKey, target: targetValue });

    const result = await page.evaluate((key) => {
      const snapshot = (window as any).__PLAY_HOST__?.extensions?.mhr?.getSnapshot?.() ?? null;
      const textboxEl = document.querySelector(`[data-testid="mhr-fixed-text-${key}"]`) as HTMLInputElement | null;
      const rangeEl = document.querySelector(`[data-testid="mhr-fixed-range-${key}"]`) as HTMLInputElement | null;
      return {
        bundleId: snapshot?.mhr?.assets?.bundleId ?? '',
        stateValue: Number(snapshot?.mhr?.state?.skeletalProportion?.[key] ?? NaN),
        echoed: Number(snapshot?.mhr?.evaluation?.debug?.fixedSlotEcho?.[key]?.value ?? NaN),
        textboxValue: textboxEl?.value ?? null,
        rangeValue: Number(rangeEl?.value ?? NaN),
      };
    }, targetKey);

    expect(result.bundleId).toContain('official');
    expect(result.stateValue).toBe(targetValue);
    expect(result.echoed).toBeCloseTo(targetValue, 4);
    expect(result.textboxValue).toBe(String(targetValue));
    expect(result.rangeValue).toBeGreaterThan(3.13);
    expect(result.rangeValue).toBeLessThanOrEqual(Math.PI);
  });

  test('uses play stage scene while preserving responsive camera drag', async ({ page }) => {
    await waitForMhrProfileReady(page, MHR_DEMO_URL);

    const canvas = page.locator('[data-testid="viewer-canvas"]');
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();

    const before = await page.evaluate(() => {
      const ctx = (window as any).__renderCtx;
      const snapshot = (window as any).__PLAY_HOST__?.getSnapshot?.() ?? null;
      return {
        position: ctx?.camera?.position?.toArray?.() ?? null,
        target: ctx?.cameraTarget?.toArray?.() ?? null,
        scnNgeom: Number(snapshot?.scn_ngeom || 0),
      };
    });
    expect(before.position).toBeTruthy();
    expect(before.target).toBeTruthy();
    expect(before.scnNgeom).toBeGreaterThan(0);

    const cx = (box?.x || 0) + (box?.width || 0) * 0.5;
    const cy = (box?.y || 0) + (box?.height || 0) * 0.5;
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'left' });
    await page.mouse.move(cx + 140, cy + 48);
    await page.mouse.up({ button: 'left' });

    await page.waitForFunction((beforePosition) => {
      const position = (window as any).__renderCtx?.camera?.position?.toArray?.() ?? null;
      if (!Array.isArray(position) || !Array.isArray(beforePosition)) {
        return false;
      }
      return Math.max(
        Math.abs((position[0] ?? 0) - (beforePosition[0] ?? 0)),
        Math.abs((position[1] ?? 0) - (beforePosition[1] ?? 0)),
        Math.abs((position[2] ?? 0) - (beforePosition[2] ?? 0)),
      ) > 1e-3;
    }, before.position, { timeout: 10_000 });

    const after = await page.evaluate(() => {
      const ctx = (window as any).__renderCtx;
      const snapshot = (window as any).__PLAY_HOST__?.getSnapshot?.() ?? null;
      return {
        position: ctx?.camera?.position?.toArray?.() ?? null,
        target: ctx?.cameraTarget?.toArray?.() ?? null,
        scnNgeom: Number(snapshot?.scn_ngeom || 0),
      };
    });

    expect(after.position).toBeTruthy();
    expect(after.target).toBeTruthy();
    expect(after.scnNgeom).toBeGreaterThan(0);

    const positionDelta = Math.max(
      Math.abs((after.position?.[0] ?? 0) - (before.position?.[0] ?? 0)),
      Math.abs((after.position?.[1] ?? 0) - (before.position?.[1] ?? 0)),
      Math.abs((after.position?.[2] ?? 0) - (before.position?.[2] ?? 0)),
    );

    expect(positionDelta).toBeGreaterThan(1e-3);
  });

  test('keeps play panel toggle shortcuts in mhr profile', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 900 });
    await waitForMhrProfileReady(page, MHR_DEMO_URL);

    await page.locator('[data-testid="viewer-canvas"]').click({ position: { x: 120, y: 120 } });

    const before = await page.evaluate(() => ({
      left: !!document.querySelector('[data-testid="panel-left"]') && !document.querySelector('[data-testid="panel-left"]')?.classList.contains('is-hidden'),
      right: !!document.querySelector('[data-testid="panel-right"]') && !document.querySelector('[data-testid="panel-right"]')?.classList.contains('is-hidden'),
    }));
    expect(before.left).toBeTruthy();
    expect(before.right).toBeTruthy();

    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.querySelector('[data-testid="panel-left"]')?.classList.contains('is-hidden'));

    await page.keyboard.press('Shift+Tab');
    await page.waitForFunction(() => document.querySelector('[data-testid="panel-right"]')?.classList.contains('is-hidden'));
  });

  test('fails fast when plugin host is missing mhr service', async ({ page }) => {
    await waitForMhrProfileReady(page, MHR_DEMO_URL);

    const errorMessage = await page.evaluate(async () => {
      const previous = (window as any).__PLAY_RUNTIME_CONFIG__;
      (window as any).__PLAY_RUNTIME_CONFIG__ = {
        ...(previous || {}),
        ui: {
          ...(previous?.ui || {}),
          profileId: 'mhr',
        },
      };
      try {
        const mod = await import('/plugins/mhr_profile_plugin.mjs');
        const fakeHost = {
          ui: {
            sections: {
              register() {
                return { dispose() {} };
              },
            },
            kit: {
              namedRow() {
                return { row: document.createElement('div'), label: document.createElement('div'), field: document.createElement('div') };
              },
              fullRow() {
                return { row: document.createElement('div'), field: document.createElement('div') };
              },
              range() {
                const input = document.createElement('input');
                input.type = 'range';
                return input;
              },
              textbox() {
                return document.createElement('input');
              },
              button() {
                return document.createElement('button');
              },
              boolButton() {
                const root = document.createElement('label');
                const input = document.createElement('input');
                input.type = 'checkbox';
                root.append(input);
                return { root, input, text: document.createElement('span') };
              },
            },
          },
          renderer: {
            overlay3d: {
              createScope() {
                return { dispose() {} };
              },
            },
          },
          clock: {
            onUiMainTick() { return () => {}; },
            onUiControlsTick() { return () => {}; },
            onFrame() { return () => {}; },
          },
          services: {},
          logError() {},
          strictCatch() {},
        };
        return Promise.resolve()
          .then(() => mod.registerPlayPlugin(fakeHost as any))
          .then(
            () => '',
            (error: any) => String(error?.message || error),
          );
      } finally {
        (window as any).__PLAY_RUNTIME_CONFIG__ = previous;
      }
    });

    expect(errorMessage).toContain('host.services.mhr');
  });
});
