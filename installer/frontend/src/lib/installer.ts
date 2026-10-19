// The bridge to the Go application layer.
//
// Wails injects two objects into the page: `window.go.<pkg>.<Type>.<Method>` for
// the bound methods in internal/app, and `window.runtime` for events. This
// module is the only place that knows their shape, so the rest of the UI works
// with plain typed functions.

import type { Preview, Request, Result, State, Step } from "./types";

interface Bindings {
  State(): Promise<State>;
  Preview(req: Request): Promise<Preview>;
  Run(req: Request): Promise<Result>;
  BrowseFirefoxDir(): Promise<string>;
  BrowseProfileDir(): Promise<string>;
}

declare global {
  interface Window {
    go?: { app?: { App?: Bindings } };
    runtime?: {
      EventsOn(name: string, cb: (data: unknown) => void): () => void;
      Quit(): void;
    };
  }
}

/** How long to wait for Wails to inject the bridge before giving up. */
const BRIDGE_TIMEOUT_MS = 8000;

/**
 * realBridge is Wails' injection point.
 *
 * In a dev build (`npm run dev`) a fixture stands in for it instead, so the
 * window's layout, empty states and reviews can be checked in an ordinary
 * browser tab without touching a real Firefox. That is the only difference: a
 * shipped build always talks to internal/app.
 */
function realBridge(): Bindings | undefined {
  return window.go?.app?.App;
}

/** waitForBridge resolves once Wails has injected the bindings. */
export async function waitForBridge(): Promise<Bindings> {
  const deadline = Date.now() + BRIDGE_TIMEOUT_MS;
  for (;;) {
    const b = realBridge();
    if (b) return b;
    if (Date.now() > deadline) {
      throw new Error(
        "the installer's application layer did not attach (this window must be opened by the installer binary)",
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function toError(err: unknown): Error {
  // Wails rejects with the Go error's message as a bare string.
  if (typeof err === "string") return new Error(err);
  if (err instanceof Error) return err;
  return new Error(String(err));
}

async function call<T>(fn: (b: Bindings) => Promise<T>): Promise<T> {
  const b = await waitForBridge();
  try {
    return await fn(b);
  } catch (err) {
    throw toError(err);
  }
}

export const installer = {
  state: () => call((b) => b.State()),
  preview: (req: Request) => call((b) => b.Preview(req)),
  run: (req: Request) => call((b) => b.Run(req)),
  browseFirefoxDir: () => call((b) => b.BrowseFirefoxDir()),
  browseProfileDir: () => call((b) => b.BrowseProfileDir()),
  /** quit closes the window and ends the installer process. */
  quit: () => window.runtime?.Quit(),
};

/**
 * onStep subscribes to the progress stream; the returned function unsubscribes.
 *
 * The subscription waits for the bridge: the window renders before Wails has
 * necessarily injected its runtime, and subscribing "whenever it shows up" is the
 * difference between a live log and an empty one.
 */
export function onStep(cb: (step: Step) => void): () => void {
  let off: () => void = () => {};
  let cancelled = false;
  void waitForBridge()
    .then(() => {
      if (cancelled) return;
      const runtime = window.runtime;
      if (runtime) off = runtime.EventsOn("installer:step", (data) => cb(data as Step));
    })
    .catch(() => {
      // No bridge and no events: the run will still report its outcome.
    });
  return () => {
    cancelled = true;
    off();
  };
}

// The dev-mode fixture. `import.meta.env.DEV` is replaced with `false` in a
// production build, so this branch (and the fixture) is dropped from the binary.
if (import.meta.env.DEV) {
  void import("./mock").then(({ mockBridge }) => {
    const mock = mockBridge();
    const go = (window.go ??= {}) as { app?: { App?: Bindings } };
    go.app ??= {};
    go.app.App = mock.bindings;
    window.runtime ??= {
      EventsOn: (_name, cb) => mock.onStep(cb as (s: { kind: string; text: string }) => void),
      Quit: () => {
        // Nothing to quit in a browser tab.
      },
    };
  });
}
