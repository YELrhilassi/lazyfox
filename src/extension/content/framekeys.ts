// Keys typed while a CHILD FRAME has focus, and the one rule that gets them to
// the document that owns them.
//
// WHY THIS EXISTS. The content script used to be injected into the top frame
// only, and to return immediately everywhere else. A frame is a different
// document: when focus is inside one — an embedded player, a docs viewer, a
// checkout field, a captcha, a comment widget — the key event is delivered to
// THAT document and the top frame's listener never runs. So every Lazyfox key
// went dead while a frame had focus, and the repair a user inevitably discovers
// is to click the page, which moves the keyboard out of the frame. That is the
// report this file answers, and it is now measured rather than argued: the e2e
// suite puts focus in a frame, presses `;`, and (before this change) the frame's
// own document received the key while the top document's leader stayed dark.
//
// THE RULE, and why it is a rule rather than forwarding everything:
//
//   * the TOP document is the owner — the leader, the popups, the hints, the
//     overlays and the key engine all live there, in the coordinate space of
//     the page the user is looking at;
//   * a frame forwards a key ONLY when the top document claims that key
//     anyway. The claimed set is the leader key and the vim scroll keys, and
//     "everything" while the leader is armed or a hint layer is up. An
//     embedded app therefore keeps every key Lazyfox does not own globally —
//     the same set it keeps in the top document — and the amplification a page
//     could get out of forwarding is bounded by that same set;
//   * the frame SWALLOWS what it forwards, because the top document would have
//     swallowed it: a key that is a Lazyfox binding in the top frame must not
//     reach an embedded app as well;
//   * the frame NEVER decides what a key means. It forwards a key name, and the
//     top document's own capture listener — the same one a real keystroke
//     reaches — decides. One key engine, one state, no second implementation.
//
// The state the frame needs travels ONE way and is cached: the top document
// broadcasts { leader, all } after every key it handled (a key is the only thing
// that can change the answer), and a fresh frame starts from the default — the
// leader key plus the scroll keys — which is correct for every config until the
// first broadcast arrives. A frame's own page cannot steer this: a message is
// honoured only when its source IS the top frame.
//
// TYPES. Deliberately no DOM lib types — the shapes below are local, and the
// events are `any`. This module is imported by the Node unit-test project,
// which typechecks without the DOM lib (the same reason src/chrome/env.ts
// declares its own window shape), and a `Window` annotation here would make the
// rule unreachable from the test that asserts it.

/** Channel tag for a forwarded key (child -> top). */
export const FRAME_KEY_CHANNEL = "lazyfox-frame-key";
/** Channel tag for the owner state (top -> every frame). */
export const FRAME_STATE_CHANNEL = "lazyfox-frame-state";

/**
 * The keys the top document claims whatever the leader is doing: the vim
 * scroll keys. The leader key is claimed too, and it comes from the config, so
 * it travels in the state rather than being listed here.
 */
export const BASE_SCROLL_KEYS = "jkdugG";

/** How much of the owner state a frame keeps. */
export interface FrameOwn {
  /** The configured leader key. */
  leader: string;
  /** The top document is capturing EVERY key right now (leader armed, hints up). */
  all: boolean;
}

export const DEFAULT_FRAME_OWN: FrameOwn = { leader: ";", all: false };

/**
 * Whether the top document claims this key right now.
 *
 * Exported because it is the whole rule, and a rule this small is worth
 * asserting directly rather than only through a fake window.
 */
export function keyIsClaimed(key: string, own: FrameOwn): boolean {
  if (own.all) return true;
  if (key === own.leader) return true;
  return key.length === 1 && BASE_SCROLL_KEYS.indexOf(key) !== -1;
}

/** The message a child frame sends. `type` is the event name, so keyup travels too. */
export interface FrameKeyMessage {
  ch: string;
  type: "keydown" | "keyup";
  key: string;
  shift: boolean;
  repeat: boolean;
}

/**
 * The slice of a frame's window this module touches.
 *
 * `top` is typed as possibly null because the DOM lib does, and because a
 * detached frame genuinely has no top to reach.
 */
export interface FrameWindow {
  top: FrameWindow | null;
  frames: ArrayLike<FrameWindow>;
  addEventListener(type: string, fn: (e: any) => void, capture?: boolean): void;
  postMessage(message: any, targetOrigin: string): void;
}

export interface FrameChildDeps {
  /** The frame's own window. */
  win: FrameWindow;
  /** `isTypingEvent` — the same predicate the top frame's guard uses. */
  isTypingEvent(e: any): boolean;
}

/**
 * In a CHILD frame: hand the top document the keys it claims.
 *
 * Registered at capture phase on the frame's window, so it runs before the
 * frame's page sees the key — and it is installed at `document_start`, before
 * the page's own scripts exist.
 */
export function installFrameChild(deps: FrameChildDeps): void {
  const win = deps.win;
  let own: FrameOwn = DEFAULT_FRAME_OWN;

  // The top frame's state. Verified by SOURCE, not by shape: the tag is public
  // (a page can read it), and a page that could steer this one would be able to
  // make a frame swallow arbitrary keys.
  win.addEventListener(
    "message",
    (e: any) => {
      let top: FrameWindow | null = null;
      try {
        top = win.top;
      } catch (err) {
        // A top window that cannot even be read is not one to trust with the
        // ownership state.
        return;
      }
      if (!top || e.source !== top) return;
      const d = e.data as Partial<FrameOwn> | null | undefined;
      if (!d || typeof d !== "object" || (d as { ch?: unknown }).ch !== FRAME_STATE_CHANNEL) return;
      own = {
        leader: typeof d.leader === "string" && d.leader ? d.leader : DEFAULT_FRAME_OWN.leader,
        all: d.all === true,
      };
    },
    true
  );

  const forward = (e: any): void => {
    if (!e || e.defaultPrevented || e.isComposing) return;
    // Chords belong to the browser and to the page: Lazyfox claims none of them,
    // and a frame that swallowed Ctrl+C would be taking copy away from an
    // embedded app.
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // The user is typing HERE, and the keys are the field's. This is the same
    // decision the top frame's guard makes for its own fields.
    if (deps.isTypingEvent(e)) return;
    if (!keyIsClaimed(e.key, own)) return;
    // Swallowed in the frame, exactly as the top document would have swallowed
    // it (see the header): the top document is the only thing that knows what a
    // key means, so the frame cannot ask before deciding.
    e.preventDefault();
    e.stopImmediatePropagation();
    let top: FrameWindow | null = null;
    try {
      top = win.top;
    } catch (err) {
      top = null;
    }
    if (!top) return;
    try {
      top.postMessage(
        {
          ch: FRAME_KEY_CHANNEL,
          type: e.type === "keyup" ? "keyup" : "keydown",
          key: e.key,
          shift: !!e.shiftKey,
          repeat: !!e.repeat,
        } as FrameKeyMessage,
        "*"
      );
    } catch (err) {
      // A frame whose top cannot be reached keeps its own behaviour: the key
      // was swallowed for nothing, which is no worse than the dead keyboard
      // this whole file exists to remove.
    }
  };

  win.addEventListener("keydown", forward, true);
  win.addEventListener("keyup", forward, true);
}

export interface FrameParentDeps {
  /** The TOP document's window. */
  win: FrameWindow;
  /** The configured leader key and whether every key is currently captured. */
  own(): FrameOwn;
  /**
   * Run a forwarded key through this document's own dispatcher.
   *
   * Handed in rather than done here because the dispatcher is reached by
   * dispatching a real event on this document (see main.ts) — that is what makes
   * a forwarded key and a typed one take exactly the same path.
   */
  dispatch(msg: FrameKeyMessage): void;
}

export interface FrameParent {
  /** Tell every frame what this document claims. Called after every handled key. */
  broadcast(): void;
}

/** Whether a window is one of this document's own frames. */
function isOwnFrame(win: FrameWindow, source: unknown): boolean {
  if (!source) return false;
  try {
    const frames = win.frames;
    const n = Number(frames.length) || 0;
    for (let i = 0; i < n; i++) {
      if (frames[i] === source) return true;
    }
  } catch (err) {
    // an unreadable frame list is not permission to trust the source
  }
  return false;
}

/**
 * In the TOP document: take forwarded keys, and keep the frames told.
 *
 * The ownership state is published after every key this document handled,
 * because a key is the only thing that can change it (arming the leader,
 * dismissing it, opening a hint layer, closing one). A frame that was not
 * listening when the state changed is wrong until the next key — bounded by one
 * keypress, and the alternative (a channel plus a polling handshake) buys
 * nothing a user can perceive.
 */
export function installFrameParent(deps: FrameParentDeps): FrameParent {
  const win = deps.win;

  win.addEventListener(
    "message",
    (e: any) => {
      const d = e.data as Partial<FrameKeyMessage> | null | undefined;
      if (!d || typeof d !== "object" || d.ch !== FRAME_KEY_CHANNEL) return;
      if (!isOwnFrame(win, e.source)) return;
      const key = typeof d.key === "string" ? d.key : "";
      // A KEY NAME, not a payload: bounded so a hostile frame cannot hand the
      // dispatcher a document-sized string.
      if (!key || key.length > 24) return;
      deps.dispatch({
        ch: FRAME_KEY_CHANNEL,
        type: d.type === "keyup" ? "keyup" : "keydown",
        key,
        shift: d.shift === true,
        repeat: d.repeat === true,
      });
    },
    true
  );

  function broadcast(): void {
    let own: FrameOwn;
    try {
      own = deps.own();
    } catch (err) {
      return; // a state that cannot be read is not one to publish
    }
    let frames: FrameWindow[] = [];
    try {
      const list = win.frames;
      const n = Number(list.length) || 0;
      for (let i = 0; i < n; i++) {
        const f = list[i];
        if (f) frames.push(f);
      }
    } catch (err) {
      frames = [];
    }
    for (const f of frames) {
      try {
        f.postMessage({ ch: FRAME_STATE_CHANNEL, leader: own.leader, all: own.all }, "*");
      } catch (err) {
        // A frame that is gone, or a cross-origin frame that refuses, is not a
        // reason to stop telling the others.
      }
    }
  }

  // One broadcast at install, so a frame that loaded before this document's
  // script is told the state rather than relying on the default forever.
  broadcast();
  return { broadcast };
}
