// The command center's UI state. All mutable state lives in one place and is
// updated through immutable patches (patch() returns a NEW state object), so
// no module can mutate another's view of the world out from under it. The DOM
// refs and timers stay in the composition root (main.ts); this is pure data.

export interface CCState {
  mode: string;
  all: any[];
  // The query `all` was built from. Enter must never act on a list that lags
  // behind the typed text (suggestions are debounced; a fast typist can hit
  // Enter before they arrive) — a stale row would open the WRONG thing.
  allQuery: string;
  idx: number;
  quickView: boolean;
  resizeOpen: boolean;
  moveOpen: boolean;
  leaderPending: boolean;
  inInsert: boolean;
  closeArmed: boolean;
  // Home-grid hint-pick mode (armed by `;f`): each tile shows a letter and the
  // next printable key runs that tile.
  hintArmed: boolean;
}

export interface CCStore {
  get(): CCState;
  patch(p: Partial<CCState>): CCState;
}

export function createStore(initial: Partial<CCState> = {}): CCStore {
  let state: CCState = {
    mode: "search",
    all: [],
    allQuery: "",
    idx: 0,
    quickView: true,
    resizeOpen: false,
    moveOpen: false,
    leaderPending: false,
    inInsert: false,
    closeArmed: false,
    hintArmed: false,
    ...initial,
  };
  return {
    get: () => state,
    patch: (p) => {
      state = { ...state, ...p };
      return state;
    },
  };
}
