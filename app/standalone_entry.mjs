import { mountMhrPlay } from './mount.mjs';

if (typeof window !== 'undefined') {
  window.__MHR_PLAY__ = Object.freeze({
    apiVersion: 1,
    mount: (options = {}) => mountMhrPlay(options),
  });
}

if (typeof document !== 'undefined') {
  await mountMhrPlay();
}
