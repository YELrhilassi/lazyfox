// The frame key bridge, asserted directly.
//
// Why this file exists at all: the bridge is the ONE place that decides what a
// frame does with a keystroke, and every wrong answer there is a whole class of
// bug rather than a detail — a frame that forwards too little leaves the dead
// keyboard this feature exists to remove, and a frame that forwards too much
// takes keystrokes away from an embedded app (a docs viewer, a chat widget, a
// player) that the user is looking at. Both directions are asserted here, along
// with the two guards that must never be crossed: a caret in the frame's own
// field, and a modifier chord.
//
// The e2e suite (content/focus) proves the same rule against a real Firefox and
// a real iframe; this one proves it about the DECISION, in about a millisecond.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FRAME_OWN,
  FRAME_KEY_CHANNEL,
  FRAME_STATE_CHANNEL,
  installFrameChild,
  installFrameParent,
  keyIsClaimed,
  type FrameKeyMessage,
} from "../../src/extension/content/framekeys.ts";

type Listener = { type: string; fn: (e: any) => void };

/** A window-shaped object with just what the bridge touches. */
function fakeWindow(over: { top?: any; frames?: any[] } = {}) {
  const listeners: Listener[] = [];
  const sent: any[] = [];
  const win: any = {
    listeners,
    sent,
    addEventListener(type: string, fn: (e: any) => void) {
      listeners.push({ type, fn });
    },
    postMessage(msg: any, origin: string) {
      sent.push({ msg, origin });
    },
    frames: over.frames || [],
  };
  win.top = "top" in over ? over.top : win;
  return win;
}

function press(win: any, type: string, key: string, over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const e: any = {
    type,
    key,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    preventDefault() {
      calls.push("preventDefault");
      e.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      calls.push("stopImmediatePropagation");
    },
    ...over,
  };
  for (const l of win.listeners) {
    if (l.type === type) l.fn(e);
  }
  return { swallowed: calls.length > 0, calls };
}

describe("the claimed-key rule", () => {
  test("the leader key is always claimed, whatever the config calls it", () => {
    assert.equal(keyIsClaimed(";", DEFAULT_FRAME_OWN), true);
    assert.equal(keyIsClaimed(" ", { leader: " ", all: false }), true);
  });

  test("the vim scroll keys are claimed", () => {
    for (const k of ["j", "k", "d", "u", "g", "G"]) {
      assert.equal(keyIsClaimed(k, DEFAULT_FRAME_OWN), true, k + " is a scroll key");
    }
  });

  test("anything else is not, so an embedded app keeps its own keys", () => {
    for (const k of ["q", "f", "1", "Enter", "ArrowDown", "Tab"]) {
      assert.equal(keyIsClaimed(k, DEFAULT_FRAME_OWN), false, k + " must pass through");
    }
  });

  test("while the top document captures everything, everything is claimed", () => {
    const own = { leader: ";", all: true };
    for (const k of ["q", "f", "1", "Enter"]) {
      assert.equal(keyIsClaimed(k, own), true, k + " is claimed during a capture");
    }
  });
});

describe("a child frame forwards what the owner claims, and nothing else", () => {
  const isTypingEvent = (e: any) =>
    !!(e && e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA"));

  // A child frame with a REAL (fake) top above it. An earlier version of this
  // helper pointed `win.top` at a string, so every `postMessage` threw and was
  // swallowed by the bridge's own guard — three tests failed and the failure
  // said nothing about the product. The top has to be a window-shaped object
  // for "what did the frame hand up" to be a question with an answer.
  function child(over: { top?: any } = {}) {
    const win = fakeWindow(over);
    const top = over.top || fakeWindow();
    win.top = top;
    win.topSent = top.sent;
    installFrameChild({ win, isTypingEvent });
    return win;
  }

  test("the leader key is swallowed here and handed up", () => {
    const win = child();
    const r = press(win, "keydown", ";");
    assert.equal(r.swallowed, true, "the frame swallows a key the top document owns");
    assert.equal(win.topSent.length, 1);
    const msg: FrameKeyMessage = win.topSent[0].msg;
    assert.equal(msg.ch, FRAME_KEY_CHANNEL);
    assert.equal(msg.type, "keydown");
    assert.equal(msg.key, ";");
    assert.equal(win.topSent[0]!.origin, "*");
    // Cross-origin frames can only be told with "*", and the message carries a
    // key name rather than anything a page could read out of the document.
  });

  test("a scroll key travels too, and carries its modifiers", () => {
    const win = child();
    press(win, "keydown", "j", { shiftKey: false });
    press(win, "keydown", "G", { shiftKey: true, repeat: true });
    assert.equal(win.topSent.length, 2);
    assert.equal(win.topSent[1]!.msg.shift, true);
    assert.equal(win.topSent[1]!.msg.repeat, true);
  });

  test("keyup travels as well, so a held leader can be released", () => {
    const win = child();
    press(win, "keyup", ";");
    assert.equal(win.topSent.length, 1);
    assert.equal(win.topSent[0]!.msg.type, "keyup");
  });

  test("a key Lazyfox does not own is left entirely alone", () => {
    const win = child();
    const r = press(win, "keydown", "q");
    assert.equal(r.swallowed, false, "an unclaimed key must reach the frame's page");
    assert.equal(win.topSent.length, 0);
  });

  test("a caret in the frame's own field keeps every key", () => {
    const win = child();
    const input = { tagName: "INPUT" };
    const r = press(win, "keydown", ";", { target: input });
    assert.equal(r.swallowed, false, "typing wins over the leader, in a frame as on a page");
    assert.equal(win.topSent.length, 0);
  });

  test("a modifier chord is the browser's and the page's", () => {
    const win = child();
    const r = press(win, "keydown", "j", { ctrlKey: true });
    assert.equal(r.swallowed, false);
    assert.equal(win.topSent.length, 0);
  });

  test("a key another handler already took is not forwarded", () => {
    const win = child();
    const r = press(win, "keydown", ";", { defaultPrevented: true });
    assert.equal(r.swallowed, false);
    assert.equal(win.topSent.length, 0);
  });

  test("the top frame's state decides the claimed set", () => {
    const win = child();
    // Only the TOP frame may steer this: the tag is public.
    const stranger = { postMessage: () => {} };
    for (const l of win.listeners) {
      if (l.type === "message") {
        l.fn({ source: stranger, data: { ch: FRAME_STATE_CHANNEL, leader: ";", all: true } });
      }
    }
    assert.equal(press(win, "keydown", "q").swallowed, false, "a stranger cannot widen the set");
    // ...and the top frame can.
    for (const l of win.listeners) {
      if (l.type === "message") {
        l.fn({ source: win.top, data: { ch: FRAME_STATE_CHANNEL, leader: ";", all: true } });
      }
    }
    assert.equal(press(win, "keydown", "q").swallowed, true, "a capture claims everything");
  });

  test("a custom leader key is honoured, and the default is left behind", () => {
    const win = child();
    for (const l of win.listeners) {
      if (l.type === "message") {
        l.fn({ source: win.top, data: { ch: FRAME_STATE_CHANNEL, leader: ",", all: false } });
      }
    }
    assert.equal(press(win, "keydown", ",").swallowed, true, "the configured leader is claimed");
    assert.equal(press(win, "keydown", ";").swallowed, false, "the old leader is not");
  });
});

describe("the top document takes forwarded keys and keeps the frames told", () => {
  function parent(own = { leader: ";", all: false }) {
    const delivered: FrameKeyMessage[] = [];
    const frameA = fakeWindow();
    const frameB = fakeWindow();
    const win = fakeWindow({ frames: [frameA, frameB] });
    const bridge = installFrameParent({
      win,
      own: () => own,
      dispatch: (m) => delivered.push(m),
    });
    const message = (source: any, data: any) => {
      for (const l of win.listeners) if (l.type === "message") l.fn({ source, data });
    };
    return { win, bridge, delivered, frameA, frameB, message };
  }

  test("a frame's key reaches the dispatcher, intact", () => {
    const p = parent();
    p.message(p.frameA, {
      ch: FRAME_KEY_CHANNEL,
      type: "keydown",
      key: ";",
      shift: true,
      repeat: false,
    });
    assert.equal(p.delivered.length, 1);
    assert.deepEqual(
      {
        key: p.delivered[0]!.key,
        shift: p.delivered[0]!.shift,
        type: p.delivered[0]!.type,
      },
      { key: ";", shift: true, type: "keydown" }
    );
  });

  test("a keyup is delivered as a keyup", () => {
    const p = parent();
    p.message(p.frameA, { ch: FRAME_KEY_CHANNEL, type: "keyup", key: "j" });
    assert.equal(p.delivered[0]!.type, "keyup");
  });

  test("a message from anything that is not one of this document's frames is ignored", () => {
    const p = parent();
    p.message("not-a-frame", { ch: FRAME_KEY_CHANNEL, type: "keydown", key: ";" });
    p.message(null, { ch: FRAME_KEY_CHANNEL, type: "keydown", key: ";" });
    assert.equal(p.delivered.length, 0, "a page must not be able to inject keys");
  });

  test("a message on another channel, or with no usable key, is ignored", () => {
    const p = parent();
    p.message(p.frameA, { ch: "something-else", key: ";" });
    p.message(p.frameA, { ch: FRAME_KEY_CHANNEL, key: "" });
    p.message(p.frameA, { ch: FRAME_KEY_CHANNEL, key: "x".repeat(200) });
    p.message(p.frameA, null);
    assert.equal(p.delivered.length, 0);
  });

  test("the owner state is published to every frame, at install and on demand", () => {
    const p = parent({ leader: ",", all: true });
    // At install...
    assert.equal(p.frameA.sent.length, 1);
    assert.equal(p.frameB.sent.length, 1);
    assert.deepEqual(p.frameA.sent[0]!.msg, { ch: FRAME_STATE_CHANNEL, leader: ",", all: true });
    // ...and after a key changed the state.
    p.bridge.broadcast();
    assert.equal(p.frameA.sent.length, 2);
    assert.equal(p.frameB.sent.length, 2);
  });

  test("a frame that refuses the message does not stop the others from being told", () => {
    const p = parent();
    p.frameA.postMessage = () => {
      throw new Error("frame is gone");
    };
    p.bridge.broadcast();
    assert.equal(p.frameB.sent.length, 2, "the second frame is still told");
  });
});
