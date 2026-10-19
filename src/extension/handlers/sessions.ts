// Session actions: list, save, create, restore, delete, mark and shuffle tabs
// between saved sessions.
//
// The biggest single domain, and the one that most needed reading on its own: it
// is a dozen actions over one data structure (the sessions map in storage), and
// as `case` labels scattered through a switch it was impossible to see the shape
// of the feature without reading the whole file.
import {
  assignSessionMarker,
  deleteSession,
  moveTabBetweenSessions,
  newSession,
  restoreSession,
  sessionList,
  sessionState,
  sessionTabs,
  switchSessionByMarker,
} from "../sessions";
import type { Session } from "../../shared/types";
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly, so a new
// action cannot be declared without someone deciding which domain answers it.
type Owns = "sessionList" | "listSessionTabs" | "sessionSave" | "sessionNew" | "sessionRestore" | "sessionDelete" | "sessionSwitchByMarker" | "sessionAssignMarker" | "sessionTabCopy" | "sessionTabMove" | "sessionState";

// `sessionSave` is a background-local wrapper rather than a sessions.ts export:
// it also refreshes the chrome helper's status bar afterwards, so it needs the
// push that only background.ts can make.
export interface SessionDeps {
  saveSession(name: string): Promise<{ ok: boolean; session?: Session }>;
}

export function createSessionHandlers(deps: SessionDeps): Domain<Owns> {
  return {
    sessionList: () => sessionList(),
    listSessionTabs: async (data) => ({ items: await sessionTabs(data.name || "") }),
    sessionSave: (data) => deps.saveSession(data.name),
    sessionNew: (data) => newSession(data.name),
    sessionRestore: (data) => restoreSession(data.name),
    sessionDelete: (data) => deleteSession(data.name),
    sessionSwitchByMarker: (data) => switchSessionByMarker(data.marker),
    sessionAssignMarker: (data) => assignSessionMarker(data.name, data.marker),
    sessionTabCopy: (data) => moveTabBetweenSessions(data.from, data.index, data.to, "copy"),
    sessionTabMove: (data) => moveTabBetweenSessions(data.from, data.index, data.to, "move"),
    sessionState: () => sessionState(),
  };
}
