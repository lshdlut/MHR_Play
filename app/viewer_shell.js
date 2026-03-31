function createElement(documentRef, tag, className, textContent = '') {
  const element = documentRef.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (textContent) {
    element.textContent = textContent;
  }
  return element;
}

export function mountViewerShell(documentRef, target = documentRef.body) {
  if (!documentRef) {
    throw new Error('mountViewerShell requires a document');
  }

  const existingRoot = documentRef.querySelector('[data-mhr-play-root]');
  if (existingRoot) {
    return {
      root: existingRoot,
      canvas: existingRoot.querySelector('[data-mhr-canvas]'),
      overlay: existingRoot.querySelector('[data-mhr-overlay]'),
      leftPanelMount: existingRoot.querySelector('[data-mhr-panel-content="left"]'),
      rightPanelMount: existingRoot.querySelector('[data-mhr-panel-content="right"]'),
      statusLine: existingRoot.querySelector('[data-mhr-status]'),
    };
  }

  const root = createElement(documentRef, 'div', 'mhr-shell');
  root.setAttribute('data-mhr-play-root', '1');

  const masthead = createElement(documentRef, 'header', 'mhr-shell__masthead');
  masthead.append(
    createElement(documentRef, 'div', 'mhr-shell__eyebrow', 'MHR Play'),
    createElement(documentRef, 'h1', 'mhr-shell__title', 'Public beta runtime shell'),
    createElement(
      documentRef,
      'p',
      'mhr-shell__subtitle',
      'This shell now runs live worker/wasm outputs and keeps the host contract narrow enough for standalone and embed use.',
    ),
  );

  const workspace = createElement(documentRef, 'div', 'mhr-shell__workspace');
  const leftPanel = createElement(documentRef, 'aside', 'mhr-shell__panel mhr-shell__panel--left');
  const center = createElement(documentRef, 'section', 'mhr-shell__viewport');
  const rightPanel = createElement(documentRef, 'aside', 'mhr-shell__panel mhr-shell__panel--right');

  const leftPanelTitle = createElement(documentRef, 'div', 'mhr-shell__panel-title', 'Controls');
  const leftPanelMount = createElement(documentRef, 'div', 'mhr-shell__panel-content');
  leftPanelMount.setAttribute('data-mhr-panel-content', 'left');
  leftPanel.append(leftPanelTitle, leftPanelMount);

  const canvas = createElement(documentRef, 'canvas', 'mhr-shell__canvas');
  canvas.setAttribute('data-mhr-canvas', '1');
  const overlay = createElement(documentRef, 'pre', 'mhr-shell__overlay');
  overlay.setAttribute('data-mhr-overlay', '1');
  center.append(canvas, overlay);

  const rightPanelTitle = createElement(documentRef, 'div', 'mhr-shell__panel-title', 'Runtime Snapshot');
  const rightPanelMount = createElement(documentRef, 'div', 'mhr-shell__panel-content');
  rightPanelMount.setAttribute('data-mhr-panel-content', 'right');
  rightPanel.append(rightPanelTitle, rightPanelMount);

  workspace.append(leftPanel, center, rightPanel);

  const statusLine = createElement(documentRef, 'footer', 'mhr-shell__status', 'Bootstrapping MHR Play...');
  statusLine.setAttribute('data-mhr-status', '1');

  root.append(masthead, workspace, statusLine);
  target.replaceChildren(root);

  return {
    root,
    canvas,
    overlay,
    leftPanelMount,
    rightPanelMount,
    statusLine,
  };
}
