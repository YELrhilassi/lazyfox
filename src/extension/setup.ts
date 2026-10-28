// The "setup" page: finish the installation, then (once it is really done)
// help remove it again.
//
// A WebExtension cannot write into the profile or the Firefox install dir, so
// Lazyfox ships one small native installer binary. This page does two jobs and
// never guesses which one it is doing — the chrome layer announces itself alive
// on window startup, and until that confirmed announce lands the page stays in
// the "finish the install" state.
//
// The important honesty rule: an extension CANNOT enumerate profiles (Firefox
// blocks about:profiles and every profile API from extensions). So when the
// chrome layer is absent this page does not invent a profile name — it says so,
// and points at the installer, which lists them for real.

import { isTypingTarget } from "../shared/dom";
import { createGgArm } from "../shared/gg";
import { send } from "../shared/protocol";
import { checkForUpdate, installerCheckUsable, installerNotice, type ReleaseChannel } from "../shared/updates";
import { compareVersions, installedHeadline } from "../shared/versions";
import { readKey, vBoolean, vInstallerCheck, vString, writeKey } from "./store";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const osName = (os: string): string => {
  if (os === "win") return "Windows";
  if (os === "mac") return "macOS";
  if (os === "linux") return "Linux";
  return os;
};

// Asset name of the standalone installer on GitHub Releases, per platform, per
// channel. Stable Firefox gets the signed build from `releases/latest`;
// Developer Edition / Nightly gets the unsigned dev build from `nightly`.
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
  nightly ? REPO_URL + "download/nightly/" + asset : REPO_URL + "latest/download/" + asset;

// Read the running Firefox's channel from its version: Developer Edition carries
// a `b` (117.0b3), Nightly an `a1` (118.0a1), stable/ESR neither. This decides
// which installer the user needs.
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
let assetName = "lazyfox-install-linux";
let nightly = false;
let os = "linux";
/** Where the download links point; the notice reuses it. */
let assetUrl = "";
/** The window-chrome version the finished card last showed. */
let shownChrome: string | null = null;
/** The newest published installer for this channel, once known. */
let installerVersion: string | null = null;

/* ------------------------------------------------------------- rendering */

function setState(installed: boolean): void {
  ($("doneCard") as HTMLElement).hidden = !installed;
  ($("todoCard") as HTMLElement).hidden = installed;
  ($("installCard") as HTMLElement).hidden = installed;
  ($("uninstallCard") as HTMLElement).hidden = !installed;
  $("pageTitle").textContent = installed ? "Lazyfox is set up" : "Finish setting up Lazyfox";
  $("pageTagline").textContent = installed
    ? "The full Lazyfox is running — the toolbar-free window, the status line and the ; keys everywhere. This page now helps you remove it if you ever want to."
    : "The add-on already runs on web pages. One small installer unlocks the full experience — the toolbar-free window, the status line, and the ; keys everywhere.";

  if (!installed) {
    $("statusText").textContent =
      "The add-on is running, but Lazyfox's window chrome is not installed yet. Follow the three steps below — that is what removes the toolbar and puts the status line on every page.";
  }
}

async function renderDone(): Promise<void> {
  let ext = "unknown";
  let chromeV = "running (version unknown)";
  let chrome: string | null = null;
  try {
    const c = await send("components");
    if (c) {
      ext = c.extension || "unknown";
      chrome = c.chromeHelper || null;
      chromeV = chrome || chromeV;
    }
  } catch (e) {
    // ignore — the summary degrades to placeholders
  }
  $("doneExt").textContent = ext;
  $("doneChrome").textContent = chromeV;
  // A live announce means the chrome layer loaded; it does NOT mean it is the
  // same build as the add-on. Compare them, or the page congratulates a profile
  // whose window chrome is three releases behind (the add-on auto-updates from
  // AMO, the chrome files only change when the installer runs).
  const verdict = installedHeadline(ext, chrome);
  const card = $("doneCard");
  card.classList.toggle("ok", verdict.ok);
  card.classList.toggle("warn", !verdict.ok);
  $("doneDot").classList.toggle("on", verdict.ok);
  $("doneHeadline").textContent = verdict.headline;
  const note = $("doneNote");
  note.textContent = verdict.note;
  note.hidden = verdict.ok;
  const prof = await readProfile();
  $("doneProfile").textContent = prof.name || "the profile this window is using";
  shownChrome = chrome;
  renderInstallerNotice(chrome);
}

/* ------------------------------------------------- published installer */

// How long a GitHub answer is trusted. The page is opened a few times per
// install, not per session, and the answer changes only when a release is cut —
// so re-asking on every open (and on every "Check again" click) would spend a
// rate limit to learn the same number.
const INSTALLER_CHECK_TTL = 6 * 60 * 60 * 1000;

const channelNow = (): ReleaseChannel => (nightly ? "nightly" : "stable");

/**
 * renderInstallerNotice is the whole "a newer installer exists" UI: one quiet
 * line in the finished card, shown only when the published build is strictly
 * newer than the window chrome on disk. Everything else — current, a dev build
 * ahead of the release, an unknown version, or the check having failed — is
 * silence. There is no banner, no repetition and no dismissal to manage.
 */
function renderInstallerNotice(chromeVersion: string | null): void {
  const el = $("updateAvailable") as HTMLAnchorElement;
  const text = alive ? installerNotice(installerVersion || "", chromeVersion, channelNow()) : null;
  el.hidden = !text;
  if (!text) {
    el.textContent = "";
    el.removeAttribute("href");
    return;
  }
  el.textContent = text;
  el.href = assetUrl;
}

/** The version next to each download link; the CSS hides an empty span. */
function applyInstallerVersion(): void {
  $("dlVer").textContent = installerVersion || "";
  $("dl2Ver").textContent = installerVersion || "";
  renderInstallerNotice(shownChrome);
}

/**
 * refreshInstallerVersion asks which installer the channel publishes today.
 *
 * The request never blocks the page and never surfaces an error: a failed or
 * rate-limited check leaves the links exactly as they were, because "could not
 * ask GitHub" is not something the user needs to fix on a setup page.
 */
async function refreshInstallerVersion(force = false): Promise<void> {
  const now = Date.now();
  const cached = await readKey("lfInstallerCheck", vInstallerCheck, { channel: "", version: "", at: 0 });
  // The chrome layer is what the installer writes, so it is the version the
  // answer is about; before it has announced itself the add-on is the only
  // installed piece this page can compare against.
  const installed = shownChrome || browser.runtime.getManifest().version;
  const usable = installerCheckUsable({
    cachedChannel: cached.channel,
    channel: channelNow(),
    cachedVersion: cached.version,
    cachedAt: cached.at,
    now,
    installed,
    ttlMs: INSTALLER_CHECK_TTL,
    force,
  });
  if (usable) {
    installerVersion = cached.version;
    applyInstallerVersion();
    return;
  }
  // An answer that is still ahead of the install reports a pending update, so
  // it can stand while the fresh request is in flight.
  const stillAhead = cached.version !== "" && compareVersions(installed, cached.version) < 0;
  if (stillAhead) {
    installerVersion = cached.version;
    applyInstallerVersion();
  }
  const startedAt = now;
  const check = await checkForUpdate(browser.runtime.getManifest().version, undefined, 7000, {
    channel: channelNow(),
  });
  if (!check.latest) {
    // Could not ask. A number that is no longer ahead of the install is worse
    // than no number: the Download link serves the newest file either way, so a
    // stale label would tell the user they are getting an older build.
    if (!stillAhead) {
      installerVersion = null;
      applyInstallerVersion();
    }
    return;
  }
  installerVersion = check.latest;
  // A response that STARTED before a newer answer was stored must not replace
  // it — this page can be reopened while an older request is still in flight.
  const current = await readKey("lfInstallerCheck", vInstallerCheck, { channel: "", version: "", at: 0 });
  if (current.at < startedAt) {
    await writeKey("lfInstallerCheck", { channel: channelNow(), version: check.latest, at: Date.now() });
  }
  applyInstallerVersion();
}

async function readProfile(): Promise<{ name: string; dir: string }> {
  try {
    const [name, dir] = await Promise.all([
      readKey("lfProfileName", vString, ""),
      readKey("lfProfileDir", vString, ""),
    ]);
    return { name, dir };
  } catch (e) {
    return { name: "", dir: "" };
  }
}

async function renderProfile(): Promise<void> {
  const prof = await readProfile();
  const el = $("profileName");
  const dirEl = $("profileDir");
  const noteEl = $("profileNote");
  if (prof.name) {
    // The chrome helper announced the active profile (site of the alive ping).
    el.textContent = prof.name;
    el.setAttribute("title", "the Firefox profile this window is running on");
    dirEl.textContent = prof.dir || "";
    if (noteEl) noteEl.textContent = "This is the profile the installer lists and marks for you.";
  } else {
    // No chrome layer yet: the extension genuinely cannot read the active
    // profile's name (Firefox blocks extensions from every profile API), so say
    // that plainly instead of showing a made-up name.
    el.textContent = "detected by the installer, not by this page";
    el.removeAttribute("title");
    dirEl.textContent = "the installer finds and lists it automatically — nothing to look up here.";
    if (noteEl)
      noteEl.textContent =
        "Firefox does not let an add-on list profiles. The installer does it for real: it shows every profile it finds and marks the one this window is using, so there is nothing to look up here.";
  }
}

async function readAlive(): Promise<boolean> {
  try {
    return readKey("chromeAlive", vBoolean, false);
  } catch (e) {
    return false;
  }
}

async function render(): Promise<void> {
  alive = await readAlive();
  setState(alive);
  await renderProfile();
  if (alive) await renderDone();
}

/* ------------------------------------------------------------------- init */

(async () => {
  try {
    ($("logoImg") as HTMLImageElement).src = browser.runtime.getURL("lazyfox-logo.svg");
  } catch (e) {
    // header works without the logo
  }

  try {
    const info = await browser.runtime.getPlatformInfo();
    os = info.os;
  } catch (e) {
    // keep the linux default
  }
  const { channel, label } = await detectChannel();
  nightly = channel === "nightly";
  assetName = (nightly ? ASSET_NIGHTLY : ASSET_STABLE)[os] || "lazyfox-install-linux";

  $("osName").textContent = osName(os);
  $("osName2").textContent = osName(os);

  const url = releaseUrl(assetName, nightly);
  assetUrl = url;
  ($("dl") as HTMLAnchorElement).href = url;
  ($("dl2") as HTMLAnchorElement).href = url;
  $("channelNote").textContent = nightly
    ? "Detected " + label + " — this is the unsigned dev installer that targets Developer Edition / Nightly."
    : "Detected stable Firefox — this is the signed installer for stable releases.";

  // The exact commands to run. macOS needs a Gatekeeper bypass on first launch
  // because the binary is unsigned.
  const bin = "lazyfox-install" + (nightly ? "-dev" : "") + (
    os === "win" ? "-windows.exe" : os === "mac" ? "-darwin" : "-linux"
  );
  const runCmd: Record<string, string> = {
    linux: "chmod +x " + bin + "\n./" + bin,
    mac: "chmod +x " + bin + "\nxattr -d com.apple.quarantine " + bin + " 2>/dev/null || true\n./" + bin,
    win: bin,
  };
  $("runCmd").textContent = runCmd[os] || runCmd.linux || "";

  // Uninstall: the same binary, choosing Remove Lazyfox. On the CLI that is the
  // `uninstall` subcommand.
  const unCmd = os === "win" ? bin + " uninstall" : "./" + bin + " uninstall";
  $("uninstallCmd").textContent = unCmd;
  $("uninstallNote").textContent = nightly
    ? "The installer lists every Lazyfox install it can find and only removes the files it added."
    : "The installer removes only Lazyfox's own files; your bookmarks, history, passwords and other add-ons are untouched.";

  await render();
  // Not awaited: the page is fully usable before GitHub answers, and a slow or
  // blocked request must not delay the install steps.
  void refreshInstallerVersion();

  browser.storage.onChanged.addListener(
    (changes: { [key: string]: { oldValue?: unknown; newValue?: unknown } }, area: string) => {
      if (area !== "local") return;
      if (changes.chromeAlive) {
        alive = !!changes.chromeAlive.newValue;
        void render();
      } else if (changes.lfProfileName) {
        void renderProfile();
      }
    }
  );

  const verify = async (btn: HTMLElement, was: string): Promise<void> => {
    btn.textContent = "checking…";
    await render();
    // The chrome version is the local half. The published half is asked again
    // too, and FORCED: this button is the user asking whether they are current,
    // so a cached answer must not be able to answer for GitHub.
    void refreshInstallerVersion(true);
    btn.textContent = was;
  };
  $("verify").addEventListener("click", () => void verify($("verify"), "Check again"));
  $("verify2").addEventListener("click", () => void verify($("verify2"), "Check again"));

  // The chrome helper cannot see keys typed into this page (extension pages run
  // out of process), so the page provides the vim scroll keys, Esc-to-blur/back
  // and a minimal `;` leader (;g back) itself.
  let leaderPending = false;
  // The shared `gg` arm (shared/gg.ts): the arming press is never consumed.
  const gg = createGgArm();
  const pageScroll = (dy: number): void => window.scrollBy(0, dy);
  const typingNow = (): boolean => isTypingTarget(document.activeElement);
  // A stale `;` capture must not eat the first character typed after clicking
  // into a field — the same rule the content script applies on focusin.
  document.addEventListener("focusin", () => {
    if (typingNow()) {
      leaderPending = false;
      gg.reset();
    }
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;
      if (leaderPending) {
        leaderPending = false;
        if (typingNow()) return;
        e.preventDefault();
        if (e.key === "g" || e.key === "G") {
          if (window.history.length > 1) window.history.back();
        }
        return;
      }
      const ae = document.activeElement as HTMLElement | null;
      const inField = typingNow();
      if (e.key === "Escape") {
        if (inField && ae) {
          e.preventDefault();
          ae.blur();
        } else if (window.history.length > 1) {
          e.preventDefault();
          window.history.back();
        }
        return;
      }
      if (inField || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === ";") { e.preventDefault(); leaderPending = true; return; }
      if (e.key === "j") { e.preventDefault(); pageScroll(60); return; }
      if (e.key === "k") { e.preventDefault(); pageScroll(-60); return; }
      if (e.key === "d") { e.preventDefault(); pageScroll(Math.max(120, window.innerHeight * 0.5)); return; }
      if (e.key === "u") { e.preventDefault(); pageScroll(-Math.max(120, window.innerHeight * 0.5)); return; }
      if (e.key === "G") { e.preventDefault(); window.scrollTo(0, document.documentElement.scrollHeight || 0); return; }
      if (e.key === "g") {
        if (gg.press()) {
          e.preventDefault();
          window.scrollTo(0, 0);
        }
      }
    },
    true
  );
})();
