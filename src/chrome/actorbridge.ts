// The content-process actor bridge.
//
// Split out of main.ts. Keys forwarded by the "Lazyfox" JS window actor (see
// actor-parent.ts / actor-child.ts) arrive here. They run through the very same
// dispatcher as keys typed into the browser window, so the leader, its popups,
// find and Esc behave identically on pages the extension's content script
// cannot reach.
//
// The one decision this module makes is what to tell the child when the
// dispatcher DECLINES the key: nothing, or a scroll the child performs itself.
// That decision lives in actorscroll.ts as a pure function — everything here is
// plumbing around it, which is the reason it is a module of its own rather than
// a dozen lines in the composition root.

import { actorScroll } from "./actorscroll";
import type { ChromeEnv } from "./env";

export interface ActorBridgeDeps {
  // The chrome environment; the bridge writes one property onto its window, so
  // that is all it needs - and taking the env rather than a bare `window`
  // keeps this module under the same audit rule as every other seamed one.
  env: ChromeEnv;
  // The chrome keydown dispatcher, called with fromActor=true (nobody else can
  // own this key — see the note in main.ts on how that is decided per tab).
  chromeKeyDown(e: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
    isComposing: boolean;
  }, fromActor: boolean, fromChannel?: boolean): boolean;
  // The user's scroll-keys setting; false means the bridge never scrolls.
  scrollKeysEnabled(): boolean | undefined;
  now(): number;
}

export function installActorBridge(deps: ActorBridgeDeps): void {
  // When the dispatcher declines the key and it is a vim scroll key, the return
  // value tells the content process to scroll itself — the browser process
  // cannot reach into a remote page's DOM, so the child has to do it.
  let lastG = 0;
  deps.env.window.__lazyfoxActorKey = (data: any) => {
    if (!data || typeof data.key !== "string") return null;
    const handled = deps.chromeKeyDown(
      {
        key: data.key,
        ctrlKey: false,
        altKey: false,
        shiftKey: !!data.shift,
        metaKey: false,
        isComposing: false,
      },
      true,
      true
    );
    if (handled) return null;
    const r = actorScroll({
      key: data.key,
      vh: data.vh,
      lastG,
      now: deps.now(),
      scrollKeys: deps.scrollKeysEnabled(),
    });
    lastG = r.lastG;
    return r.intent;
  };
}