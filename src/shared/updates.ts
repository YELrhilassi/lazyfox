// "Is there a newer Lazyfox?" — the one question that needs the network.
//
// DESIGN RULE: NO POLLING. Nothing here runs on a timer, on navigation, or on
// focus. The check is either the settings panel's button or ONE attempt at the
// start of a browser session (extension/services/updates.ts, which owns the
// once-per-session guard and the notification). A background poll of a GitHub
// API from a keyboard-first browser tool is a privacy decision the user did not
// make; a single launch-time question, answered once, is the compromise the
// product asks for — and the notification it produces is silent unless a newer
// release actually exists.
//
// The panel also answers the local half of the question without any network at
// all (shared/versions.ts: are the installed pieces from the same build?), so
// the common failure — an add-on that updated while the chrome layer did not —
// is diagnosed offline.
//
// The release page is the update mechanism on purpose. The chrome layer and the
// native host cannot be replaced by the add-on itself; the installer can, and
// its `--mode update` path refreshes an existing install in place without an
// uninstall. So the honest thing to offer here is "a newer build exists, here is
// the installer", not a download-and-run the extension is not allowed to do.

import { compareVersions, isKnownVersion } from "./versions";

/** The repository every release is published from. */
export const LAZYFOX_REPO = "YELrhilassi/lazyfox";

/** Stable, human-facing release page (GitHub resolves "latest"). */
export const RELEASE_URL = `https://github.com/${LAZYFOX_REPO}/releases/latest`;

/** The API endpoint the check reads; the newest non-prerelease release. */
export const RELEASE_API_URL = `https://api.github.com/repos/${LAZYFOX_REPO}/releases/latest`;

/**
 * The dev-channel release. It is one rolling prerelease at the fixed tag
 * `nightly`, which is why it is addressed by tag rather than by "latest":
 * `releases/latest` deliberately skips prereleases, and a dev user must not be
 * compared against the stable channel they are ahead of.
 */
export const NIGHTLY_API_URL = `https://api.github.com/repos/${LAZYFOX_REPO}/releases/tags/nightly`;

export type ReleaseChannel = "stable" | "nightly";

/** The endpoint a channel's newest build is published under. */
export function releaseApiUrl(channel: ReleaseChannel): string {
  return channel === "nightly" ? NIGHTLY_API_URL : RELEASE_API_URL;
}

export interface ReleaseCheck {
  /** "update-available" | "current" — what this build should do about it. */
  state: "update-available" | "current" | "unknown";
  /** Version the release names, with any leading "v" removed. */
  latest: string;
  /** Where to send the user; the release page even when the API answered. */
  url: string;
  /** Why the check could not answer, when state is "unknown". */
  error?: string;
}

/** Strips "v" and whitespace so "v0.5.11" and "0.5.11" compare equal. */
export function normalizeTag(tag: string | null | undefined): string {
  return String(tag == null ? "" : tag)
    .trim()
    .replace(/^v/i, "");
}

interface FetchLike {
  (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

interface ReleaseBody {
  tag_name?: string;
  name?: string;
  html_url?: string;
  prerelease?: boolean;
  assets?: { name?: string }[];
}

/** Just the numeric form: "nightly" is a known tag, not a version. */
function isVersionText(v: string): boolean {
  return /^\d+(?:\.\d+)+$/.test(v);
}

/**
 * releaseVersion is the version a release states about itself.
 *
 * A stable release has it in the tag (`v0.5.13`). The rolling `nightly`
 * release does not: its tag is literally `nightly`, and the only thing in it
 * that names a version is the xpi it carries (`lazyfox2-0.5.13.xpi`, or the
 * `-signed` variant). Reading the asset name is therefore not a fallback — for
 * the dev channel it is the only truthful answer, and reporting "nightly" as a
 * version would compare as `[0]` and call every build current.
 */
export function releaseVersion(body: ReleaseBody | null | undefined): string {
  const tag = normalizeTag(body?.tag_name || body?.name);
  if (isVersionText(tag)) return tag;
  for (const asset of body?.assets || []) {
    const m = /^lazyfox2-(.+)\.xpi$/i.exec(String(asset?.name || ""));
    if (!m) continue;
    const v = normalizeTag(m[1]!.replace(/-signed$/i, ""));
    if (isVersionText(v)) return v;
  }
  return "";
}

/** The copy a launch-time (or panel) notification shows, when there is one. */
export interface UpdateNotice {
  title: string;
  message: string;
}

/**
 * updateNotice words the one notification a newer release earns, or null when
 * there is nothing to say (current, or the check could not answer).
 *
 * Pure on purpose: the copy is then testable without a browser, and two callers
 * cannot drift into two different descriptions of the same update.
 */
export function updateNotice(check: ReleaseCheck, currentVersion: string): UpdateNotice | null {
  if (!check || check.state !== "update-available" || !isKnownVersion(check.latest)) return null;
  const running = isKnownVersion(currentVersion) ? `You are running ${currentVersion}.` : "";
  return {
    title: `Lazyfox ${check.latest} is available`,
    message: `${running} Run the installer to update in place — your tabs, sessions and settings are kept.`.trim(),
  };
}

/**
 * installerNotice is the setup page's one line about the installer itself, or
 * null when there is nothing worth saying.
 *
 * WHY IT COMPARES WITH THE WINDOW CHROME, NOT THE ADD-ON. The installer is
 * what writes the chrome layer, so "is there a newer installer?" is answered
 * against what the installer last put on disk. The case this exists for: the
 * add-on sat at 0.5.11 and the published installer was also 0.5.11, so the
 * page's own version comparison was happy while a 0.5.12 installer had been
 * published and never run. Comparing against the chrome layer instead is the
 * difference between "the two pieces agree" and "the piece you can update is
 * behind what exists".
 *
 * Silence is the default and stays the default: equal versions say nothing, an
 * installer older than the installed build (a dev build running ahead of the
 * release) says nothing, and an unknown version on either side says nothing.
 */
export function installerNotice(
  latest: string,
  installed: string | null | undefined,
  channel: ReleaseChannel = "stable",
): string | null {
  if (!isVersionText(latest) || !isVersionText(normalizeTag(installed))) return null;
  if (compareVersions(installed, latest) >= 0) return null;
  return `${channel === "nightly" ? "Dev installer" : "Installer"} ${latest} is available — download it`;
}

/**
 * checkForUpdate asks GitHub for the newest release and compares it with the
 * version running here.
 *
 * Every failure mode returns state "unknown" with a reason instead of throwing:
 * offline, rate-limited, blocked by a proxy, or a response that is not the shape
 * expected. A settings panel must not show an exception for "the network is
 * down" — it shows that it could not check, which is a different sentence.
 */
export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 7000,
  opts: { channel?: ReleaseChannel } = {},
): Promise<ReleaseCheck> {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(releaseApiUrl(opts.channel ?? "stable"), {
      headers: { Accept: "application/vnd.github+json" },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) {
      return {
        state: "unknown",
        latest: "",
        url: RELEASE_URL,
        error: res.status === 403 || res.status === 429 ? "GitHub rate limit reached — try again later" : `GitHub answered ${res.status}`,
      };
    }
    const body = (await res.json()) as ReleaseBody;
    const latest = releaseVersion(body);
    if (!latest) {
      return { state: "unknown", latest: "", url: RELEASE_URL, error: "the release does not state a version" };
    }
    return {
      state: compareVersions(currentVersion, latest) < 0 ? "update-available" : "current",
      latest,
      url: body.html_url || RELEASE_URL,
    };
  } catch (e) {
    const msg = e && (e as Error).name === "AbortError" ? "the check timed out" : String((e && (e as Error).message) || e);
    return { state: "unknown", latest: "", url: RELEASE_URL, error: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
