// What counts as a "real" tab for Lazyfox numbering. A tab keeps a stable 1-9
// identity as long as it is not internal plumbing:
//
//   - the split-panel companion pane (splitpanel.html), pure UI that exists
//     only while a split is being set up, and
//   - the persistent relay tab (relay.html), the ONE hidden carrier for every
//     chrome<->background message (see docs/MESSAGING.md), and
//   - the split-panel companion pane (splitpanel.html), pure UI that exists
//     only while a split is being set up.
//
// Everything else is a real user tab and must NEVER drop out of the numbering
// mid-operation — including a real tab that momentarily carries a #lfc=keys or
// #lfc=state request hash. Treating those as transient is what shifted
// ;+N targets mid-request and mis-resolved restored split pairs.
//
// Both the chrome helper and the extension consult this one predicate so the
// two can never disagree about a tab's number.
export function isRelayTabUrl(url: string | null | undefined): boolean {
  const u = url || "";
  // The persistent relay tab (relay.html) is internal plumbing: its URL never
  // changes, so it is identified by page name rather than hash fragment.
  if (u.indexOf("relay.html") !== -1) return true;
  const i = u.indexOf("#lfc=");
  if (i >= 0) {
    const frag = u.slice(i + 5);
    if (frag.startsWith("req.")) return true;
    if (frag.startsWith("reqResult.")) return true;
    if (frag.startsWith("sessionState.")) return true;
    if (frag.startsWith("sessionTabs.")) return true;
    if (frag.startsWith("open.")) return true;
    // Content-leader arm/disarm relay (syncLeader -> leaderState): a
    // throwaway tab like the others — it must never shift ;1-9 numbering.
    if (frag.startsWith("leaderState.")) return true;
  }
  return u.indexOf("splitpanel.html") !== -1;
}