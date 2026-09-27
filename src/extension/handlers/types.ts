// The shape of a background message handler, and the rule the handlers follow.
//
// The background used to answer every message from one 290-line switch with 70
// `case` labels. Two things were wrong with that:
//
//   - It was exhaustive by nothing. Add an action to BgApi, forget the case,
//     and the message falls through to `default` and comes back
//     `{ ok: false, error: "unknown action" }` at runtime. Nothing says so until
//     a user presses a key. (This is exactly how `openDiagnostics` shipped dead
//     on the relay side — see docs/MESSAGING.md.)
//   - It was one scope. Every handler could see every other handler's helpers,
//     so the search actions, the session actions and the diagnostics actions
//     were all in the same room even though they share nothing.
//
// A handler table fixes both. Keyed on BgAction, the compiler knows the exact
// request type of every key and the exact response type it must return, so a
// mistyped field or a mismatched reply is a build failure. And because the
// handlers live in per-domain modules, each one only sees what it needs.
//
// `sender` is passed to every handler because three actions (syncTyping,
// syncLeader, syncFind) need the sending tab. The rest ignore it.
import type { BgAction, BgApi } from "../../shared/protocol";

// The action NAMES (the keys of BgApi), which is what a handler table is keyed
// on. BgAction is the whole message union, not the name union, so the bound here
// has to be keyof BgApi.
export type BgActionName = keyof BgApi;

export type BgHandler<K extends BgActionName> = (
  data: BgApi[K]["req"],
  sender: unknown,
) => BgApi[K]["res"] | Promise<BgApi[K]["res"]>;

// Every domain's table. Keys are optional so the domains can be composed; the
// completeness check in background.ts is what guarantees that between them they
// cover every action.
export type BgHandlers = { [K in BgActionName]?: BgHandler<K> };

// What each domain factory actually returns: `Pick` over the actions it owns.
//
// `Pick` rather than the whole `BgHandlers` for a specific reason. If a factory
// returned `BgHandlers`, its keys would be every action (optionally), so
// `keyof` the composed table in background.ts would be the FULL action union no
// matter which handlers existed — and the "is every action handled?" check would
// be vacuously true forever. `Pick` keeps the same per-handler request/response
// types while making the key set exactly what the domain really implements, so
// the union of all domains' keys is what the check actually tests.
export type Domain<Owns extends BgActionName> = Pick<BgHandlers, Owns>;

// The message the runtime dispatcher actually receives, re-exported so
// background.ts can type its onMessage listener against the same union the
// handlers are checked against.
export type IncomingMessage = BgAction;
