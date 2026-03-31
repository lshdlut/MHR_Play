import { buildZeroStatePatch } from '../core/state_mapping.mjs';

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
    void onClick();
  });
  return button;
}

function defaultManifestUrl() {
  return './demo_assets/manifest.json';
}

function selectBetaParameters(parameterMetadata) {
  const parameters = Array.isArray(parameterMetadata?.parameters)
    ? parameterMetadata.parameters
    : [];
  return parameters
    .filter((parameter) => parameter?.tier !== 'raw')
    .slice(0, 18);
}

function buildDemoPreset(parameterMetadata, kind) {
  const poseKeys = Object.keys(parameterMetadata?.sections?.pose || {});
  const shapeKeys = Object.keys(parameterMetadata?.sections?.surfaceShape || {});
  const expressionKeys = Object.keys(parameterMetadata?.sections?.expression || {});

  if (kind === 'neutral') {
    return buildZeroStatePatch(parameterMetadata);
  }
  if (kind === 'pose') {
    return {
      root: {},
      pose: poseKeys[0] ? { [poseKeys[0]]: 0.2, ...(poseKeys[1] ? { [poseKeys[1]]: -0.15 } : {}) } : {},
      surfaceShape: {},
      skeletalProportion: {},
      expression: {},
      expertRaw: {},
    };
  }
  if (kind === 'shape') {
    return {
      root: {},
      pose: {},
      surfaceShape: shapeKeys[0] ? { [shapeKeys[0]]: 0.35 } : {},
      skeletalProportion: {},
      expression: expressionKeys[0] ? { [expressionKeys[0]]: 0.3 } : {},
      expertRaw: {},
    };
  }
  return buildZeroStatePatch(parameterMetadata);
}

export function createControlManager({ leftPanelMount, rightPanelMount, store, backend }) {
  const documentRef = leftPanelMount.ownerDocument;
  const compareModes = ['skin', 'skeleton', 'both'];
  const diagnosticsEl = documentRef.createElement('pre');
  diagnosticsEl.className = 'mhr-pre';
  const parameterPanel = documentRef.createElement('div');
  parameterPanel.className = 'mhr-parameter-panel';
  const manifestInput = documentRef.createElement('input');
  manifestInput.className = 'mhr-input';
  manifestInput.value = defaultManifestUrl();
  manifestInput.placeholder = 'manifest URL';

  leftPanelMount.append(
    createCard(
      documentRef,
      'Beta Shell',
      'This shell is now wired to live worker/wasm runtime outputs while keeping the host contract narrow and stable.',
    ),
  );

  const manifestCard = documentRef.createElement('section');
  manifestCard.className = 'mhr-card';
  const manifestTitle = documentRef.createElement('h2');
  manifestTitle.className = 'mhr-card__title';
  manifestTitle.textContent = 'Asset Manifest';
  const manifestBody = documentRef.createElement('div');
  manifestBody.className = 'mhr-stack';
  manifestBody.append(
    manifestInput,
    createButton(documentRef, 'Load Assets', 'mhr-button', async () => {
      await backend.loadAssets({
        manifestUrl: manifestInput.value.trim(),
      });
      await backend.evaluate({ compareMode: store.get().view.compareMode });
    }),
  );
  manifestCard.append(manifestTitle, manifestBody);
  leftPanelMount.append(manifestCard);

  const compareRow = documentRef.createElement('div');
  compareRow.className = 'mhr-button-row';
  for (const mode of compareModes) {
    compareRow.append(
      createButton(documentRef, mode, 'mhr-button--ghost', async () => {
        store.update((draft) => {
          draft.view.compareMode = mode;
        });
        await backend.setState({ root: { compareMode: mode } });
        await backend.evaluate({ compareMode: mode });
      }),
    );
  }
  leftPanelMount.append(compareRow);

  const actionRow = documentRef.createElement('div');
  actionRow.className = 'mhr-button-row';
  actionRow.append(
    createButton(documentRef, 'Evaluate', 'mhr-button', async () => {
      await backend.evaluate({ compareMode: store.get().view.compareMode });
    }),
  );
  leftPanelMount.append(actionRow);

  leftPanelMount.append(parameterPanel);

  rightPanelMount.append(
    createCard(
      documentRef,
      'Runtime Snapshot',
      'The right panel is driven by backend snapshots carrying live mesh and skeleton outputs.',
    ),
  );
  rightPanelMount.append(diagnosticsEl);

  function renderParameterControls(snapshot) {
    const parameterMetadata = snapshot?.assets?.parameterMetadata || null;
    parameterPanel.replaceChildren();
    if (!parameterMetadata) {
      return;
    }

    const betaParameters = selectBetaParameters(parameterMetadata);
    if (!betaParameters.length) {
      return;
    }

    const presets = documentRef.createElement('div');
    presets.className = 'mhr-button-row';
    presets.append(
      createButton(documentRef, 'Neutral', 'mhr-button--ghost', async () => {
        const patch = buildDemoPreset(parameterMetadata, 'neutral');
        await backend.setState(patch);
        await backend.evaluate({ compareMode: store.get().view.compareMode });
      }),
      createButton(documentRef, 'Pose Demo', 'mhr-button--ghost', async () => {
        const patch = buildDemoPreset(parameterMetadata, 'pose');
        await backend.setState(patch);
        await backend.evaluate({ compareMode: store.get().view.compareMode });
      }),
      createButton(documentRef, 'Shape Demo', 'mhr-button--ghost', async () => {
        const patch = buildDemoPreset(parameterMetadata, 'shape');
        await backend.setState(patch);
        await backend.evaluate({ compareMode: store.get().view.compareMode });
      }),
      createButton(documentRef, 'Reset', 'mhr-button--ghost', async () => {
        const patch = buildZeroStatePatch(parameterMetadata);
        patch.root.compareMode = store.get().view.compareMode;
        await backend.setState(patch);
        await backend.evaluate({ compareMode: store.get().view.compareMode });
      }),
    );
    parameterPanel.append(createCard(documentRef, 'Presets', 'Minimal beta presets for quick validation.'));
    parameterPanel.append(presets);

    const controlsCard = documentRef.createElement('section');
    controlsCard.className = 'mhr-card';
    const title = documentRef.createElement('h2');
    title.className = 'mhr-card__title';
    title.textContent = 'Parameters';
    controlsCard.append(title);

    for (const parameter of betaParameters) {
      const row = documentRef.createElement('label');
      row.className = 'mhr-slider';
      const name = documentRef.createElement('span');
      name.className = 'mhr-slider__name';
      name.textContent = parameter.label || parameter.key;
      const valueEl = documentRef.createElement('span');
      valueEl.className = 'mhr-slider__value';
      valueEl.textContent = `${parameter.default ?? 0}`;
      const input = documentRef.createElement('input');
      input.type = 'range';
      input.min = String(parameter.min ?? -1);
      input.max = String(parameter.max ?? 1);
      input.step = '0.01';
      input.value = String(parameter.default ?? 0);
      input.addEventListener('input', () => {
        valueEl.textContent = Number(input.value).toFixed(2);
      });
      input.addEventListener('change', () => {
        const section = parameter.stateSection;
        const patch = {
          root: {},
          pose: {},
          surfaceShape: {},
          skeletalProportion: {},
          expression: {},
          expertRaw: {},
        };
        if (section === 'root') {
          patch.root[parameter.key] = Number(input.value);
        } else if (section === 'pose') {
          patch.pose[parameter.key] = Number(input.value);
        } else if (section === 'surfaceShape') {
          patch.surfaceShape[parameter.key] = Number(input.value);
        } else if (section === 'skeletalProportion') {
          patch.skeletalProportion[parameter.key] = Number(input.value);
        } else if (section === 'expression') {
          patch.expression[parameter.key] = Number(input.value);
        }
        void backend.setState(patch).then(() => backend.evaluate({ compareMode: store.get().view.compareMode }));
      });
      row.append(name, input, valueEl);
      controlsCard.append(row);
    }
    parameterPanel.append(controlsCard);
  }

  function update(snapshot, uiState) {
    if (snapshot?.assets?.manifestUrl && !manifestInput.matches(':focus')) {
      manifestInput.value = snapshot.assets.manifestUrl;
    }
    renderParameterControls(snapshot);
    diagnosticsEl.textContent = JSON.stringify(
      {
        status: snapshot?.status || 'unknown',
        compareMode: uiState?.view?.compareMode || 'both',
        assets: snapshot?.assets
          ? {
              bundleId: snapshot.assets.bundleId,
              parameterCount: snapshot.assets.parameterCount,
              counts: snapshot.assets.counts || null,
            }
          : null,
        evaluation: snapshot?.evaluation
          ? {
              mesh: {
                vertexCount: snapshot.evaluation.mesh?.vertexCount || 0,
                faceCount: snapshot.evaluation.mesh?.faceCount || 0,
              },
              skeleton: {
                jointCount: snapshot.evaluation.skeleton?.jointCount || 0,
              },
              derived: snapshot.evaluation.derived || null,
            }
          : null,
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
