function formatOverlay(snapshot, uiState) {
  return [
    'MHR Play Placeholder Renderer',
    `status: ${snapshot?.status || 'unknown'}`,
    `compareMode: ${uiState?.view?.compareMode || 'both'}`,
    `revision: ${snapshot?.revision || 0}`,
    `bundle: ${snapshot?.assets?.bundleId || 'not loaded'}`,
    `evaluation digest: ${snapshot?.evaluation?.derived?.digest || 'n/a'}`,
  ].join('\n');
}

export function createRendererManager({ canvas, overlay }) {
  const ctx = canvas?.getContext?.('2d') || null;

  function resize() {
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width));
    canvas.height = Math.max(1, Math.floor(rect.height));
  }

  function render(snapshot, uiState) {
    resize();
    if (ctx) {
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#fff3e1');
      gradient.addColorStop(1, '#f2d7b5');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = '#3b2a18';
      ctx.font = '700 22px Space Grotesk, sans-serif';
      ctx.fillText('MHR Play Skeleton', 28, 42);
      ctx.font = '500 14px IBM Plex Sans, sans-serif';
      ctx.fillStyle = '#7a6851';
      ctx.fillText('Renderer consumes backend truth + UI-only store.', 28, 68);

      ctx.strokeStyle = 'rgba(59, 42, 24, 0.12)';
      for (let x = 24; x < width; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, 88);
        ctx.lineTo(x, height - 24);
        ctx.stroke();
      }
      for (let y = 88; y < height; y += 32) {
        ctx.beginPath();
        ctx.moveTo(24, y);
        ctx.lineTo(width - 24, y);
        ctx.stroke();
      }
    }

    if (overlay) {
      overlay.textContent = formatOverlay(snapshot, uiState);
    }
  }

  function dispose() {
    if (overlay) {
      overlay.textContent = 'Renderer disposed.';
    }
  }

  return {
    render,
    resize,
    dispose,
  };
}
