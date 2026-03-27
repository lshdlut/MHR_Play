import { createBackend } from '../backend/backend_core.mjs';
import {
  applyRuntimeUiToDocument,
  resolveMountConfig,
} from '../core/runtime_config.mjs';
import { logStatus } from '../core/viewer_runtime.mjs';
import { createRendererManager } from '../renderer/pipeline.mjs';
import { createControlManager } from '../ui/control_manager.mjs';
import { createViewerStore } from '../ui/state.mjs';
import { createMhrPlayHost } from './mhr_play_host.mjs';
import { mountViewerShell } from './viewer_shell.js';

function defaultTarget(documentRef) {
  return documentRef.body;
}

export async function mountMhrPlay(options = {}) {
  if (typeof document === 'undefined') {
    throw new Error('mountMhrPlay requires a browser document');
  }

  const { runtimeConfig, assetConfig } = resolveMountConfig({
    target: globalThis,
    runtimeConfig: options.runtimeConfig,
    assetConfig: options.assetConfig,
  });
  applyRuntimeUiToDocument(document, runtimeConfig);

  const target = options.root || defaultTarget(document);
  const shell = mountViewerShell(document, target);
  const store = createViewerStore({
    view: {
      compareMode: runtimeConfig.ui.defaultCompareMode,
    },
  });
  const backend = await createBackend({ runtimeConfig, assetConfig });
  const renderer = createRendererManager({
    canvas: shell.canvas,
    overlay: shell.overlay,
  });
  const controls = createControlManager({
    leftPanelMount: shell.leftPanelMount,
    rightPanelMount: shell.rightPanelMount,
    store,
    backend,
  });

  const unsubscribe = backend.subscribe((snapshot) => {
    renderer.render(snapshot, store.get());
    controls.update(snapshot, store.get());
    shell.statusLine.textContent = `Status: ${snapshot.status}`;
  });

  controls.update(backend.snapshot(), store.get());
  renderer.resize();

  if (assetConfig.manifestUrl) {
    await backend.loadAssets(assetConfig);
  }

  const onResize = () => renderer.resize();
  window.addEventListener('resize', onResize);
  logStatus('MHR Play mounted');

  const destroy = () => {
    unsubscribe();
    window.removeEventListener('resize', onResize);
    controls.dispose();
    renderer.dispose();
    backend.dispose();
    shell.statusLine.textContent = 'Status: destroyed';
  };

  const host = createMhrPlayHost({
    backend,
    store,
    renderer,
    shell,
    destroy,
  });
  window.__MHR_PLAY_HOST__ = host;

  return host;
}
