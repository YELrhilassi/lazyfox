// Download actions: list them, open, remove, reveal and retry.
//
// Their whole implementation is downloads.ts; this module exists so the message
// switch does not have to, and so the request/response contract for each is
// checked in one place instead of being re-derived at each `case`.
import {
  downloadsList,
  openDownload,
  openDownloadLocation,
  removeDownload,
  retryDownload,
} from "../downloads";
import { pushDismissDownloadsToChrome } from "../bgpushes";
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly, so a new
// action cannot be declared without someone deciding which domain answers it.
type Owns =
  | "downloads"
  | "openDownload"
  | "removeDownload"
  | "openDownloadLocation"
  | "retryDownload"
  | "dismissDownload";

export function createDownloadHandlers(): Domain<Owns> {
  return {
    downloads: () => downloadsList(),
    openDownload: (data) => openDownload(data.id),
    removeDownload: (data) => removeDownload(data.id),
    openDownloadLocation: (data) => openDownloadLocation(data.id),
    retryDownload: (data) => retryDownload(data.id),
    // The bar lives in the chrome helper, so the dismissal is a PUSH, not a
    // local write: the answer here only means "the helper has been asked".
    dismissDownload: () => {
      pushDismissDownloadsToChrome();
      return { ok: true };
    },
  };
}
