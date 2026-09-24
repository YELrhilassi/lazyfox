// The store extension's "complete the installation" page.
//
// A WebExtension cannot write files into the profile or the Firefox install
// dir, so Lazyfox ships a single native, self-contained installer binary (pure
// Go, no shell/PowerShell). This page points the user to the GitHub Releases
// download for their OS and walks them through it. It deliberately stays
// low-tech: a clear status, the active profile to target, and one obvious
// download button. The chrome layer announces itself alive on window startup;
// until then chromeAlive is false and this page shows what is missing.
const $ = (id: string): HTMLElement => document.getElementById(id)!;

const osName = (os: string): string => {
  if (os === "win") return "Windows";
  if (os === "mac") return "macOS";
  if (os === "linux") return "Linux";
  return os;
};

// Asset name of the standalone installer on GitHub Releases, per platform, for
// each channel. Stable Firefox gets the AMO-signed build from `releases/latest`;
// Developer Edition / Nightly gets the unsigned dev build from the rolling
// `nightly` prerelease (which embeds the unsigned xpi and targets dev Firefox).
const ASSET_STABLE: Record<string, string> = {
  win: "lazyfox-install-windows.exe",
  mac: "lazyfox-install-darwin",
  linux: "lazyfox-install-linux",
};
const ASSET_NIGHTLY: Record<string, string> = {
  win: "lazyfox-install-dev-windows.exe",
  mac: "lazyfox-install-dev-darwin",
  linux: "lazyfox-install-dev-linux",
};

const REPO_URL = "https://github.com/YELrhilassi/lazyfox/releases/";
const releaseUrl = (asset: string, nightly: boolean): string =>
  nightly
    ? REPO_URL + "download/nightly/" + asset
    : REPO_URL + "latest/download/" + asset;

// detectChannel reads the running Firefox's version: Developer Edition builds
// carry a `b` (e.g. 117.0b3), Nightly carries `a1` (e.g. 118.0a1), stable/ESR
// carry neither. A WebExtension cannot otherwise tell the channel apart, and
// this is exactly what decides which installer the user needs.
type FirefoxChannel = "stable" | "nightly";
const detectChannel = async (): Promise<{ channel: FirefoxChannel; label: string }> => {
  try {
    const info = await browser.runtime.getBrowserInfo();
    const v = String(info.version || "");
    if (/a\d+$/.test(v)) return { channel: "nightly", label: "Nightly" };
    if (/b\d+$/.test(v)) return { channel: "nightly", label: "Developer Edition" };
    return { channel: "stable", label: "stable Firefox" };
  } catch (e) {
    return { channel: "stable", label: "stable Firefox" };
  }
};

let alive = false;

const renderStatus = (): void => {
  const dot = $("dot");
  const txt = $("statusText");
  const card = $("statusCard");
  if (alive) {
    dot.className = "dot on";
    card.className = "card status ok";
    txt.textContent = "The full Lazyfox UI is installed and running. Nothing left to do here.";
  } else {
    dot.className = "dot";
    card.className = "card status warn";
    // Name exactly what is missing. The add-on half is running (leader key on
    // web pages, find/yank, popups), so "half-installed" alone reads as if
    // nothing works — the real gap is the toolbar-free window chrome.
    txt.textContent =
      "The add-on is running, but Lazyfox's window chrome is not installed yet. " +
      "Follow the three steps below to add it — that is what removes the toolbar " +
      "and puts the status bar on every page — then come back and check again.";
  }
};

const renderProfile = (): void => {
  void browser.storage.local.get(["lfProfileName", "lfProfileDir"]).then((r: any) => {
    const prof = (r && r.lfProfileName) || "";
    const dir = (r && r.lfProfileDir) || "";
    const el = $("profileName");
    const dirEl = $("profileDir");
    if (prof) {
      // The chrome helper announced the active profile (site of the alive
      // ping) — show the exact name the installer's picker will list.
      el.textContent = prof;
      el.setAttribute("title", "the Firefox profile this window is running on");
      dirEl.textContent = dir
        ? dir + " \u2014 the installer detects this profile automatically."
        : "the installer detects this profile automatically.";
    } else {
      // Pre-install / no chrome layer: no WebExtension API can read the
      // active profile's name (Firefox blocks extensions from about:profiles
      // and from every profile API — verified), so instead of inventing a
      // name, tell the user how to see the real one themselves.
      el.textContent = "detected automatically";
      dirEl.textContent =
        "You do not need to know or pick your profile \u2014 the installer finds the " +
        "profile Firefox is using and installs there, with no prompting.";
    }
  }).catch(() => {});
};

(async () => {
  // Horizontal logo (icon + wordmark) in the header.
  try {
    const img = document.getElementById("logoImg") as HTMLImageElement;
    img.src = browser.runtime.getURL("lazyfox-logo.svg");
  } catch (e) {
    // ignore — the header works without the logo
  }

  const info = await browser.runtime.getPlatformInfo();
  const os = info.os;
  const { channel, label } = await detectChannel();
  const nightly = channel === "nightly";
  const suffix = nightly ? "-dev" : "";
  const asset: string = (nightly ? ASSET_NIGHTLY : ASSET_STABLE)[os] || "lazyfox-install" + suffix + "-linux";
  $("osName").textContent = osName(os);
  $("osName2").textContent = osName(os);

  const dl = $("dl") as HTMLAnchorElement;
  dl.href = releaseUrl(asset, nightly);
  dl.textContent = "Download the installer for " + osName(os);

  // Tell the user which channel we matched, so a Nightly user is never puzzled
  // about why they got the dev build (and vice versa).
  const chNote = $("channelNote");
  if (chNote) {
    chNote.textContent = nightly
      ? "Detected " + label + " — this is the unsigned dev installer that targets Developer Edition / Nightly."
      : "Detected stable Firefox — this is the AMO-signed installer for stable releases.";
  }

  // The actual command to run the self-contained installer, per OS. macOS
  // needs a Gatekeeper bypass on first launch because the binary is unsigned.
  const bin = (p: string): string => "lazyfox-install" + suffix + p;
  const runCmd: Record<string, string> = {
    linux: "chmod +x " + bin("-linux") + "\n./" + bin("-linux"),
    mac: "chmod +x " + bin("-darwin") + "\nxattr -d com.apple.quarantine " + bin("-darwin") + " 2>/dev/null || true\n./" + bin("-darwin"),
    win: bin("-windows.exe"),
  };
  $("runCmd").textContent = runCmd[os] || runCmd.linux || "";

  renderProfile();

  const readAlive = async (): Promise<boolean> => {
    try {
      const r = await browser.storage.local.get("chromeAlive");
      return r && r.chromeAlive === true;
    } catch (e) {
      return false;
    }
  };
  alive = await readAlive();
  renderStatus();

  browser.storage.onChanged.addListener(
    (changes: { [key: string]: { oldValue?: unknown; newValue?: unknown } }, area: string) => {
      if (area !== "local") return;
      if (changes.chromeAlive) {
        alive = !!changes.chromeAlive.newValue;
        renderStatus();
      }
      if (changes.lfProfileName) renderProfile();
    }
  );

  $("verify").addEventListener("click", async () => {
    const st = $("statusText");
    st.textContent = "checking\u2026";
    alive = await readAlive();
    renderStatus();
    if (alive) {
      st.textContent = "Ready to go \u2014 enjoy the full Lazyfox!";
    } else {
      st.textContent = "Still not detected \u2014 did you restart Firefox after running the installer?";
    }
    renderProfile();
  });

  // The chrome helper cannot see keys typed into this page (extension pages
  // run out of process), so the page provides the vim scroll keys, Esc-to-
  // blur/back and a minimal `;` leader (;g back) itself — the same keys the
  // chrome helper gives about: pages. Keeps j/k/gg/G and `;g` working here.
  let leaderPending = false;
  let gArmed = false;
  const pageScroll = (dy: number): void => window.scrollBy(0, dy);
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;
      if (leaderPending) {
        e.preventDefault();
        leaderPending = false;
        if (e.key === "Escape") return;
        if (e.key === "g" || e.key === "G") {
          if (window.history.length > 1) window.history.back();
        }
        return;
      }
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae ? String(ae.tagName).toUpperCase() : "";
      const inField =
        !!ae &&
        (tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          ae.isContentEditable ||
          ae.getAttribute("contenteditable") === "true");
      if (e.key === "Escape") {
        if (inField) {
          e.preventDefault();
          ae.blur();
        } else if (window.history.length > 1) {
          e.preventDefault();
          window.history.back();
        }
        return;
      }
      if (inField || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === ";") {
        e.preventDefault();
        leaderPending = true;
        return;
      }
      if (e.key === "j") { e.preventDefault(); pageScroll(60); return; }
      if (e.key === "k") { e.preventDefault(); pageScroll(-60); return; }
      if (e.key === "d") { e.preventDefault(); pageScroll(Math.max(120, window.innerHeight * 0.5)); return; }
      if (e.key === "u") { e.preventDefault(); pageScroll(-Math.max(120, window.innerHeight * 0.5)); return; }
      if (e.key === "G") {
        e.preventDefault();
        window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight || 0);
        return;
      }
      if (e.key === "g") {
        e.preventDefault();
        if (gArmed) {
          gArmed = false;
          window.scrollTo(0, 0);
        } else {
          gArmed = true;
          setTimeout(() => {
            gArmed = false;
          }, 600);
        }
      }
    },
    true
  );
})();