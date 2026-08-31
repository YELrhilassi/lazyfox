// Public popup API. Each popup + helper lives in its own module under this
// folder; this file re-exports them so callers import from "./shared/popups"
// as before.
export { makeSelector } from "./kit";
export type { PopupCtx } from "./kit";
export { openSearchPopup, openUrlPopup, openTabsPopup } from "./search-url-tabs";
export { openHistoryPopup } from "./history";
export { openRecentlyClosedPopup } from "./recovery";
export { openBookmarksPopup } from "./bookmarks";
export { openDownloadsPopup } from "./downloads";
export { openSessionsPopup } from "./sessions";
export { openHelpPopup } from "./help";
export { runLeaderAction, makeLeaderActions } from "./leader";
