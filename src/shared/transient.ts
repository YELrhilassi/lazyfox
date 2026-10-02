// What counts as a "real" tab for Lazyfox numbering. A tab keeps a stable
// position identity as long as it is not internal plumbing:
//
//   - the persistent relay tab (relay.html): the ONE hidden carrier for every
//     chrome<->background message (see docs/MESSAGING.md);
//   - a tab carrying an `#lfc=` fragment that is INTERNAL: the per-message
//     request/reply carriers are tabs we open ourselves and close again;
//   - the split-panel companion pane (splitpanel.html), pure UI that exists
//     only while a split is being set up.
//
// Everything else is a real user tab and must NEVER drop out of the numbering
// mid-operation. The default is deliberately namespace-based rather than a list
// of prefixes: an allow-list of `#lfc=` prefixes went stale the moment a
// channel was added, and a stale list is not a cosmetic problem — a session
// restore that treats one of these throwaway tabs as a real one can reuse it
// as the host for the first saved tab, and its own handler then closes it a
// moment later, taking a real tab with it. So a channel nobody has heard of is
// INTERNAL until proven otherwise; only the channels named below are exempt.
//
// Both the chrome helper and the extension consult this one predicate so the
// two can never disagree about a tab's number.

/**
 * The `#lfc=` channels that BORROW a tab the user already has.
 *
 * These do not own their carrier. The key synthesizer, the state/cfg queries
 * and the open command are delivered by navigating some existing tab to a hash
 * and reading the answer back out of it, because a WebExtension message cannot
 * reach the chrome helper and a second tab would sit in the strip for the
 * duration. That tab is the user's: it has their history, their scroll position
 * and their place in the numbering, and it is still there when the message is
 * done.
 *
 * Treating a borrowed tab as plumbing is not a cosmetic error. The moment such
 * a tab left the numbering, every tab after it shifted up by one for as long as
 * the borrow lasted — which is the whole duration of the keystroke being
 * synthesized. So `;4` and `;W m 4` then resolved against a list one short and
 * moved the tab before the one that was asked for, and the symptom was a split
 * that "did not form" rather than a wrong target.
 *
 * Keep in sync with the command names handled in chrome/channel.ts#handleLfc.
 * A channel added there and not here is treated as internal, which is the safe
 * direction to be wrong in: an unlisted carrier is plumbing we opened, and
 * mistaking plumbing for a user tab is what broke session restore.
 */
const BORROWED_CHANNELS = [
  "keys", // the synthetic key path
  "state", // the #lfc=state debug query
  "cfg", // live config/hotkey push
  "open", // open a URL or command
  "reveal", // toolbar reveal (test hook)
  "console", // internal-console dump (test hook)
  "diag", // diagnostics (test hook)
];

/**
 * True when this URL is a real user tab that is only BORROWING itself to carry
 * a message — so it keeps its number while it does.
 */
export function isBorrowedTabUrl(url: string | null | undefined): boolean {
  const u = url || "";
  const h = u.indexOf("#lfc=");
  if (h === -1) return false;
  const rest = u.slice(h + 5);
  const dot = rest.indexOf(".");
  const cmd = (dot === -1 ? rest : rest.slice(0, dot)).trim();
  return BORROWED_CHANNELS.indexOf(cmd) !== -1;
}

/**
 * True when a tab with this URL is Lazyfox's own plumbing and must stay out of
 * the user-visible tab numbering.
 */
export function isRelayTabUrl(url: string | null | undefined): boolean {
  const u = url || "";
  // The persistent relay tab (relay.html) is internal plumbing: its URL never
  // changes, so it is identified by page name rather than hash fragment.
  if (u.indexOf("relay.html") !== -1) return true;
  // A borrowed tab is the USER's tab for the length of the message, so it is
  // not plumbing — see BORROWED_CHANNELS for why getting this wrong shifts
  // every number after it.
  if (isBorrowedTabUrl(u)) return false;
  // Every other `#lfc=` tab is ours. It used to be an allow-list of prefixes —
  // req., open., leaderState., … — and the list was wrong in both directions,
  // which is how a session restore could pick one of these tabs as the host it
  // reuses for the first saved tab: the tab's own handler then closed it a
  // moment later and took a real tab with it, so the restored window came back
  // one tab short and every position after it shifted.
  if (u.indexOf("#lfc=") !== -1) return true;
  return u.indexOf("splitpanel.html") !== -1;
}
