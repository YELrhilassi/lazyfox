// WHOSE TYPING SIGNAL IS IT, AND IS IT STILL TRUE?
//
// The chrome helper cannot see a remote page's focused element, so two of its
// typing signals come from page content: `contentTyping`, a latch fed by the
// frame script, and `lfTyping`, a session value on the TAB written by whichever
// content script last saw a caret in a field. Both are STICKY — neither is
// retracted when the document they describe goes away (a navigation, a crash, a
// page whose script never runs again: a PDF viewer, a restricted domain).
//
// That stickiness is not a cosmetic mis-ranking of one key. While one of them
// says "typing", the chrome dispatcher declines EVERY key, and on a chrome-owned
// page (about:, an extension page, an error page) there is no content script to
// answer instead — so the leader key still works (it has its own rescue branch)
// while `;f`, `;t`, the scroll keys and every binding are dead. A fresh tab in
// the same window works perfectly, which is why the report reads as "some keys
// work and others don't, and then it fixes itself".
//
// So the host says WHEN the content-derived answers may be believed: only while
// this tab still has a content script. The per-keystroke signals — the event's
// own target, the command dispatcher, Services.focus — are always consulted,
// and they are the ones a chrome-owned page needs.
//
// The fakes below are deliberately the real shapes those functions read
// (`SessionStore.getCustomTabValue`, `window.gBrowser.selectedTab`, the frame
// script's message listener), because the bug lived in the seam between them
// rather than in any one of them.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTypingChannel } from "../../src/chrome/typing.ts";

/** The frame script's listener, captured from the message manager fake. */
let frameReport: ((m: { data?: { typing?: boolean } }) => void) | null = null;

function installFakes(lfTyping: string): void {
  frameReport = null;
  const g = globalThis as unknown as Record<string, unknown>;
  g.Ci = { nsIFile: {}, nsISubstitutingProtocolHandler: {} };
  g.Services = {
    dirsvc: { get: () => ({}) },
    io: {
      newFileURI: () => ({}),
      getProtocolHandler: () => ({ QueryInterface: () => ({ setSubstitution: () => {} }) }),
    },
    mm: {
      loadFrameScript: () => {},
      addMessageListener: (name: string, fn: (m: unknown) => void) => {
        if (name === "lazyfox:editing") frameReport = fn as (m: { data?: { typing?: boolean } }) => void;
      },
    },
    console: { logStringMessage: () => {} },
    focus: { focusedElement: null },
  };
  g.SessionStore = { getCustomTabValue: () => lfTyping };
  g.window = { gBrowser: { selectedTab: {}, selectedBrowser: undefined } };
}

/** A keydown that carries no live focus information of its own. */
const bare = (): KeyboardEvent => ({ key: "j" }) as unknown as KeyboardEvent;

/** A keydown whose own target IS an editable — the live, per-event signal. */
function typingEvent(): KeyboardEvent {
  const input = {
    tagName: "INPUT",
    isContentEditable: false,
    getAttribute: () => null,
    closest: () => null,
    shadowRoot: null,
  };
  return { key: "x", originalTarget: input } as unknown as KeyboardEvent;
}

describe("a content-derived typing signal is believed only while content is live", () => {
  test("a stale tab value is believed when the host says content is live", () => {
    installFakes("1");
    const typing = createTypingChannel();
    assert.equal(typing.focusedIsTyping(bare()), true);
  });

  test("and is REFUSED when no content script is there to keep it honest", () => {
    installFakes("1");
    const typing = createTypingChannel({ contentSignalsLive: () => false });
    assert.equal(
      typing.focusedIsTyping(bare()),
      false,
      "a chrome-owned page must not inherit the typing flag of the document that used to be here",
    );
  });

  test("the frame script's latch is gated the same way, and reset() clears it", () => {
    installFakes("0");
    const typing = createTypingChannel({ contentSignalsLive: () => true });
    assert.ok(frameReport, "the fake message manager must have registered the listener");
    frameReport!({ data: { typing: true } });
    assert.equal(typing.focusedIsTyping(bare()), true, "the latch is read when content is live");
    typing.reset();
    assert.equal(typing.focusedIsTyping(bare()), false, "reset() drops it (the window-blur rule)");

    // The same latch, refused by a channel that has been told content is not
    // live. This is the half that matters: the latch is the signal a chrome-owned
    // page has no way to clear.
    installFakes("0");
    const gated = createTypingChannel({ contentSignalsLive: () => false });
    frameReport!({ data: { typing: true } });
    assert.equal(
      gated.focusedIsTyping(bare()),
      false,
      "the gate applies to the latch, not only to the tab value",
    );
  });

  test("a live focus signal is ALWAYS believed, gate or no gate", () => {
    installFakes("0");
    const typing = createTypingChannel({ contentSignalsLive: () => false });
    assert.equal(
      typing.focusedIsTyping(typingEvent()),
      true,
      "an event whose own target is an input needs no latch and no permission",
    );
  });

  test("a predicate that throws is not evidence of typing", () => {
    installFakes("1");
    const typing = createTypingChannel({
      contentSignalsLive: () => {
        throw new Error("the tab went away mid-keystroke");
      },
    });
    assert.equal(typing.focusedIsTyping(bare()), false);
  });
});
