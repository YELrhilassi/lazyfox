// Hand-rolled text editing for popups whose window-capture keydown handler
// preventDefaults every key before the input sees it (the content-script
// "manual text" model). Native paste, undo and character insertion never run
// in that model, so this module provides them.
//
// Kept separate from overlay.ts (whose RectOverlay class uses TypeScript
// parameter properties that Node's strip-only loader cannot parse) so the
// pure editing logic stays unit-testable with plain node --experimental-strip-types.

// Paste the clipboard into an input at the cursor, mirroring what the browser's
// native Ctrl+V would do. Needed for content-script popups, whose window-level
// capture listener prevents default on every keydown (the manualText model), so
// the native paste action never runs. Reads text over the async clipboard API;
// the extension holds the clipboardRead permission.
function pasteClipboard(input: HTMLInputElement): void {
  try {
    const read =
      (navigator.clipboard && typeof navigator.clipboard.readText === "function")
        ? navigator.clipboard.readText()
        : Promise.resolve("");
    void read
      .then((txt) => {
        if (!txt) return;
        const s = input.selectionStart == null ? input.value.length : input.selectionStart;
        const en = input.selectionEnd == null ? input.value.length : input.selectionEnd;
        input.value = input.value.slice(0, s) + txt + input.value.slice(en);
        try {
          input.setSelectionRange(s + txt.length, s + txt.length);
        } catch (err) { /* ignore */ }
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })
      .catch(() => { /* clipboard denied — swallow */ });
  } catch (e) {
    // ignore
  }
}

// Manual text insertion for popups where the window-capture keydown handler
// preventDefaults every key before the input sees it (the content-script
// model). Handles Backspace/Delete, printable characters, Ctrl+V (native
// paste never runs, so read the clipboard and insert at the cursor) and
// Ctrl+Z / Ctrl+Shift+Z (a hand-rolled undo stack — the input's native undo
// also never runs in this model). Returns true when the key was consumed.
const undoStacks = new WeakMap<HTMLInputElement, { stack: string[]; pos: number }>();

function snapshotUndo(input: HTMLInputElement): void {
  let u = undoStacks.get(input);
  if (!u) {
    u = { stack: [input.value], pos: 0 };
    undoStacks.set(input, u);
  }
  if (u.stack[u.pos] !== input.value) {
    u.stack = u.stack.slice(0, u.pos + 1);
    u.stack.push(input.value);
    if (u.stack.length > 100) u.stack.shift();
    u.pos = u.stack.length - 1;
  }
}

function undo(input: HTMLInputElement, redo: boolean): boolean {
  const u = undoStacks.get(input);
  if (!u) return false;
  // The stack holds PRE-edit snapshots; the current value is only in it once
  // something was undone or another snapshot was taken. Record the present
  // first so the first undo steps back to the state before the last edit.
  if (u.stack[u.pos] !== input.value) {
    u.stack = u.stack.slice(0, u.pos + 1);
    u.stack.push(input.value);
    u.pos = u.stack.length - 1;
  }
  const next = redo ? Math.min(u.stack.length - 1, u.pos + 1) : Math.max(0, u.pos - 1);
  if (next === u.pos) return true; // at the edge — consumed, nothing to do
  u.pos = next;
  input.value = u.stack[next]!;
  const caret = input.value.length;
  try {
    input.setSelectionRange(caret, caret);
  } catch {
    // ignore
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

export function manualTextKey(e: KeyboardEvent, input: HTMLInputElement): boolean {
  const k = e.key;
  const s = input.selectionStart == null ? input.value.length : input.selectionStart;
  const en = input.selectionEnd == null ? input.value.length : input.selectionEnd;
  const sel = s !== en;
  const atEnd = s >= input.value.length;
  const atStart = s <= 0;
  if (e.ctrlKey && !e.altKey && !e.metaKey && (k === "v" || k === "V")) {
    snapshotUndo(input);
    pasteClipboard(input);
    return true;
  }
  if (e.ctrlKey && !e.altKey && !e.metaKey && (k === "z" || k === "Z")) {
    return undo(input, e.shiftKey);
  }
  if (k === "Backspace" || k === "Delete") {
    snapshotUndo(input);
    if (sel) {
      input.value = input.value.slice(0, s) + input.value.slice(en);
      try {
        input.setSelectionRange(s, s);
      } catch (err) {
              // setSelectionRange throws on input types that do not support a
              // text selection (number, email). The edit is already applied; only
              // the caret ends up in the wrong place, which is recoverable by the
              // next keystroke.
      }
    } else if (k === "Backspace" && !atStart) {
      input.value = input.value.slice(0, s - 1) + input.value.slice(en);
      try {
        input.setSelectionRange(s - 1, s - 1);
      } catch (err) {
              // setSelectionRange throws on input types that do not support a
              // text selection (number, email). The edit is already applied; only
              // the caret ends up in the wrong place, which is recoverable by the
              // next keystroke.
      }
    } else if (k === "Delete" && !atEnd) {
      input.value = input.value.slice(0, s) + input.value.slice(en + 1);
      try {
        input.setSelectionRange(s, s);
      } catch (err) {
              // setSelectionRange throws on input types that do not support a
              // text selection (number, email). The edit is already applied; only
              // the caret ends up in the wrong place, which is recoverable by the
              // next keystroke.
      }
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  if (k && k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    snapshotUndo(input);
    input.value = input.value.slice(0, s) + k + input.value.slice(en);
    try {
      input.setSelectionRange(s + 1, s + 1);
    } catch (err) {
            // setSelectionRange throws on input types that do not support a
            // text selection (number, email). The edit is already applied; only
            // the caret ends up in the wrong place, which is recoverable by the
            // next keystroke.
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  return false;
}
