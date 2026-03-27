export const DEFAULT_UI_STATE = Object.freeze({
  shell: Object.freeze({
    leftPanelVisible: true,
    rightPanelVisible: true,
    statusLine: 'booting',
  }),
  view: Object.freeze({
    compareMode: 'both',
    controlTier: 'curated',
  }),
});

function cloneState(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createViewerStore(initialState = {}) {
  let state = {
    ...cloneState(DEFAULT_UI_STATE),
    ...cloneState(initialState),
  };
  const listeners = new Set();

  function get() {
    return cloneState(state);
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') {
      return () => {};
    }
    listeners.add(fn);
    fn(get());
    return () => listeners.delete(fn);
  }

  function commit(nextState) {
    state = nextState;
    for (const fn of listeners) {
      fn(get());
    }
    return get();
  }

  function set(patch) {
    const next = {
      ...state,
      ...cloneState(patch || {}),
    };
    return commit(next);
  }

  function update(mutator) {
    if (typeof mutator !== 'function') {
      return get();
    }
    const draft = get();
    mutator(draft);
    return commit(draft);
  }

  return {
    get,
    set,
    update,
    subscribe,
  };
}
