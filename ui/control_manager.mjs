function createCard(documentRef, title, body) {
  const card = documentRef.createElement('section');
  card.className = 'mhr-card';

  const titleEl = documentRef.createElement('h2');
  titleEl.className = 'mhr-card__title';
  titleEl.textContent = title;

  const bodyEl = documentRef.createElement('p');
  bodyEl.className = 'mhr-card__body';
  bodyEl.textContent = body;

  card.append(titleEl, bodyEl);
  return card;
}

function createButton(documentRef, label, className, onClick) {
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', () => {
    onClick();
  });
  return button;
}

export function createControlManager({ leftPanelMount, rightPanelMount, store, backend }) {
  const documentRef = leftPanelMount.ownerDocument;
  const compareModes = ['skin', 'skeleton', 'both', 'preset', 'sweep'];
  const diagnosticsEl = documentRef.createElement('pre');
  diagnosticsEl.className = 'mhr-pre';

  leftPanelMount.append(
    createCard(
      documentRef,
      'Architecture Rules',
      'Bootstrap owns runtime inputs, backend owns evaluation truth, and the UI store stays free of mesh and skeleton buffers.',
    ),
  );

  const buttonRow = documentRef.createElement('div');
  buttonRow.className = 'mhr-button-row';
  for (const mode of compareModes) {
    buttonRow.append(
      createButton(documentRef, mode, 'mhr-button--ghost', async () => {
        store.update((draft) => {
          draft.view.compareMode = mode;
        });
        await backend.setState({ root: { compareMode: mode } });
        await backend.evaluate({ compareMode: mode });
      }),
    );
  }
  leftPanelMount.append(buttonRow);

  const actions = documentRef.createElement('div');
  actions.className = 'mhr-button-row';
  actions.append(
    createButton(documentRef, 'Load Stub Assets', 'mhr-button', async () => {
      await backend.loadAssets({ bundleUrl: './tests/fixtures/processed_bundle/manifest.json' });
    }),
    createButton(documentRef, 'Evaluate Once', 'mhr-button', async () => {
      await backend.evaluate({ compareMode: store.get().view.compareMode });
    }),
  );
  leftPanelMount.append(actions);

  rightPanelMount.append(
    createCard(
      documentRef,
      'Snapshot Boundary',
      'This panel is intentionally driven by backend snapshots instead of mirrored runtime truth inside the UI store.',
    ),
  );
  rightPanelMount.append(diagnosticsEl);

  function update(snapshot, uiState) {
    diagnosticsEl.textContent = JSON.stringify(
      {
        status: snapshot?.status || 'unknown',
        compareMode: uiState?.view?.compareMode || 'both',
        assets: snapshot?.assets || null,
        evaluation: snapshot?.evaluation || null,
        diagnostics: snapshot?.diagnostics || [],
      },
      null,
      2,
    );
  }

  function dispose() {
    diagnosticsEl.textContent = 'Controls disposed.';
  }

  return {
    update,
    dispose,
  };
}
