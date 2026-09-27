// A stand-in for the Go application layer, used only by `vite dev`
// (import.meta.env.DEV). It exists so the window can be built and inspected
// without launching the native one — the layout, the empty states and the
// uninstall review are all reachable from a browser tab.
//
// It is never part of a production build, and it deliberately answers from a
// fixed machine rather than from the real one: nothing here may be mistaken for
// real detection.

import type { ChangeInfo, Preview, RemovalInfo, Request, Result, State } from "./types";

const STABLE_PROFILE = "C:\\Users\\you\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\a1b2c3d4.default-release";
const WORK_PROFILE = "C:\\Users\\you\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\e5f6a7b8.work";
const OWNED_PROFILE = "C:\\Users\\you\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\lazyfox-4f2a91cd";
const FF_DIR = "C:\\Program Files\\Mozilla Firefox";

const MACHINE: State = {
  channel: "stable",
  channelShort: "Stable Firefox",
  channelLabel: "stable Firefox (signed)",
  profilePolicy: "Installs into the profile stable Firefox uses.",
  devChannel: false,
  platform: "windows",
  payloadOrigin: "embedded standalone payload",
  hasDist: false,
  addonAvailable: true,
  installs: [{ label: "Stable", exec: `${FF_DIR}\\firefox.exe`, dir: FF_DIR, flavor: "stable", loader: "missing" }],
  profiles: [
    {
      name: "default-release",
      dir: STABLE_PROFILE,
      label: "default-release  Firefox Stable  v132.0.2  • default",
      edition: "Stable",
      version: "132.0.2",
      flavor: "stable",
      locked: false,
      hasLazyfox: false,
      isDefault: true,
      owned: false,
      recommended: true,
    },
    {
      name: "work",
      dir: WORK_PROFILE,
      label: "work  Firefox Stable  v132.0.2",
      edition: "Stable",
      version: "132.0.2",
      flavor: "stable",
      locked: true,
      hasLazyfox: false,
      isDefault: false,
      owned: false,
      recommended: false,
    },
    {
      name: "lazyfox-4f2a91cd",
      dir: OWNED_PROFILE,
      label: "lazyfox-4f2a91cd  Firefox Stable",
      edition: "Stable",
      version: "",
      flavor: "stable",
      locked: false,
      hasLazyfox: true,
      isDefault: false,
      owned: true,
      recommended: false,
    },
  ],
  actions: [
    { id: "install", label: "Install Lazyfox", desc: "Add-on and chrome loader" },
    { id: "uninstall", label: "Remove Lazyfox", desc: "Reverses an install, back to plain Firefox" },
    { id: "loader-only", label: "Install chrome loader only", desc: "config.js in the Firefox folder · admin" },
    { id: "loader-remove", label: "Remove chrome loader only", desc: "Deletes config.js · admin" },
  ],
  defaultInstall: 0,
  defaultProfile: 0,
  defaultUninstallProfile: 2,
};

function profileFor(req: Request) {
  if (req.newProfile) {
    return {
      ...MACHINE.profiles[2]!,
      name: req.newProfileName || "lazyfox-9c31be07",
      dir: `C:\\Users\\you\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\${req.newProfileName || "lazyfox-9c31be07"}`,
      owned: true,
      hasLazyfox: false,
    };
  }
  return MACHINE.profiles.find((p) => p.dir === req.profileDir) ?? MACHINE.profiles[0]!;
}

// The profile-side chrome files, mirroring the installer's payload registry
// (installer/internal/payload/registry.go).
const CHROME_FILES = [
  "chrome/userChrome.css",
  "chrome/userChrome.uc.js",
  "chrome/frame.js",
  "chrome/corebootstrap.js",
  "chrome/actor-boot.js",
  "chrome/lazyfox-child.sys.mjs",
  "chrome/lazyfox-parent.sys.mjs",
];

function installChanges(profileDir: string, req: Request): ChangeInfo[] {
  const changes: ChangeInfo[] = [];
  if (req.newProfile) {
    changes.push({ path: profileDir, kind: "profile", detail: "a new profile Lazyfox owns — your own profile is not touched", elevated: false, profileSide: false, optional: false });
  }
  for (const n of CHROME_FILES) {
    changes.push({ path: `${profileDir}\\${n.replace("/", "\\")}`, kind: "file", detail: "Lazyfox UI file", elevated: false, profileSide: true, optional: false });
  }
  changes.push({ path: `${profileDir}\\user.js`, kind: "prefs", detail: "Lazyfox's preferences merged in — every other pref you set is kept", elevated: false, profileSide: true, optional: false });
  if (req.useExtension) {
    changes.push({ path: `${profileDir}\\extensions\\lazyfox@lazyfox.dev.xpi`, kind: "file", detail: "the Lazyfox add-on (signed build)", elevated: false, profileSide: true, optional: false });
    changes.push({ path: `${profileDir}\\extensions.json`, kind: "json", detail: "Lazyfox registered as enabled", elevated: false, profileSide: true, optional: false });
  }
  changes.push({ path: `${FF_DIR}\\config.js`, kind: "loader", detail: "keyboard loader, so the leader key works on internal pages", elevated: true, profileSide: false, optional: false });
  changes.push({ path: `${FF_DIR}\\defaults\\pref\\config-prefs.js`, kind: "loader", detail: "keyboard loader, so the leader key works on internal pages", elevated: true, profileSide: false, optional: false });
  changes.push({ path: "C:\\Users\\you\\AppData\\Local\\Lazyfox\\lazyfox-host.exe", kind: "file", detail: "native messaging host (optional; the add-on works without it)", elevated: false, profileSide: false, optional: true });
  return changes;
}

function uninstallInventory(profileDir: string, req: Request): { removals: RemovalInfo[]; unchanged: RemovalInfo[] } {
  const removals: RemovalInfo[] = [];
  for (const n of CHROME_FILES) {
    removals.push({ path: `${profileDir}\\${n.replace("/", "\\")}`, kind: "file", detail: "Lazyfox UI file", exists: true, owned: false, restorable: true });
  }
  removals.push({ path: `${profileDir}\\user.js`, kind: "prefs", detail: "Lazyfox's preferences taken back out — every other pref you set stays", exists: true, owned: false, restorable: true });
  removals.push({ path: `${profileDir}\\extensions\\lazyfox@lazyfox.dev.xpi`, kind: "file", detail: "the Lazyfox add-on", exists: true, owned: false, restorable: true });
  removals.push({ path: `${profileDir}\\addonStartup.json.lz4`, kind: "file", detail: "Firefox's add-on import cache (rebuilt on the next start)", exists: true, owned: false, restorable: true });
  removals.push({ path: `${profileDir}\\extensions.json`, kind: "json", detail: "Lazyfox's entry removed; your other add-ons stay", exists: true, owned: false, restorable: true });
  if (req.removeLoader) {
    removals.push({ path: `${FF_DIR}\\config.js`, kind: "loader", detail: "keyboard loader (needs admin)", exists: true, owned: false, restorable: false });
    removals.push({ path: `${FF_DIR}\\defaults\\pref\\config-prefs.js`, kind: "loader", detail: "keyboard loader (needs admin)", exists: true, owned: false, restorable: false });
  }
  const unchanged: RemovalInfo[] = [
    { path: "C:\\Users\\you\\AppData\\Local\\Lazyfox\\lazyfox-host.exe", kind: "file", detail: "native messaging host left in place", exists: true, owned: false, restorable: false },
  ];
  if (!req.removeLoader) {
    unchanged.unshift({ path: `${FF_DIR}`, kind: "loader", detail: "chrome loader left in place (removing it needs admin)", exists: true, owned: false, restorable: false });
  }
  const owned = profileDir === OWNED_PROFILE || req.profileDir === OWNED_PROFILE;
  if (req.deleteProfile && owned) {
    removals.push({ path: profileDir, kind: "profile", detail: "the whole profile — Lazyfox created it, so removing it is safe", exists: true, owned: true, restorable: false });
  } else if (owned) {
    unchanged.push({ path: profileDir, kind: "profile", detail: "the Lazyfox profile Lazyfox created (you can ask for it to be deleted)", exists: true, owned: true, restorable: false });
  } else {
    unchanged.push({ path: profileDir, kind: "profile", detail: "your own profile — bookmarks, history, passwords, cookies and your other add-ons", exists: true, owned: false, restorable: false });
  }
  return { removals, unchanged };
}

function preview(req: Request): Preview {
  const profile = profileFor(req);
  const install = MACHINE.installs[0]!;
  const isUninstall = req.action === "uninstall";
  const inv = uninstallInventory(profile.dir, req);
  return {
    action: req.action,
    install,
    profile,
    createsProfile: req.action === "install" && req.newProfile,
    deletesProfile: isUninstall && req.deleteProfile,
    changes: req.action === "install" ? installChanges(profile.dir, req) : null,
    removals: isUninstall ? inv.removals : null,
    unchanged: isUninstall ? inv.unchanged : null,
    summary: isUninstall
      ? `Remove Lazyfox from ${profile.name}`
      : `Install Lazyfox into ${req.newProfile ? `a new Lazyfox profile (${profile.name})` : profile.name} in ${install.label}`,
    needsAdmin: !isUninstall || req.removeLoader,
    warnings: [
      ...(profile.locked ? ["Firefox is using this profile right now; the installer closes it first and can reopen it afterwards."] : []),
      ...(isUninstall && !profile.owned
        ? ["This is your own profile. Only Lazyfox's own files go — your bookmarks, history, saved logins and other add-ons stay."]
        : []),
    ],
  };
}

const STEP_LINES: { kind: "step" | "warn" | "note"; text: string }[] = [
  { kind: "note", text: "using your profile default-release" },
  { kind: "step", text: "Checking if this profile is in use…" },
  { kind: "step", text: "Chrome files installed (payload: embedded standalone payload)" },
  { kind: "step", text: "Prefs written to user.js (yours kept)" },
  { kind: "note", text: "Installing the chrome loader into C:\\Program Files\\Mozilla Firefox needs administrator rights." },
  { kind: "note", text: "Approve the system prompt…" },
  { kind: "step", text: "Loader verified in C:\\Program Files\\Mozilla Firefox" },
  { kind: "step", text: "Installed the signed extension: …\\extensions\\lazyfox@lazyfox.dev.xpi" },
  { kind: "step", text: "Installed native messaging host: C:\\Users\\you\\AppData\\Local\\Lazyfox\\lazyfox-host.exe" },
  { kind: "note", text: "Restart Firefox to activate Lazyfox." },
];

/** mockBridge returns a bridge that answers from the fixture above. */
export function mockBridge() {
  const listeners: ((s: { kind: string; text: string }) => void)[] = [];
  return {
    bindings: {
      State: async () => MACHINE,
      Preview: async (req: Request) => preview(req),
      Run: async (req: Request): Promise<Result> => {
        for (const line of STEP_LINES) {
          await new Promise((r) => setTimeout(r, 320));
          listeners.forEach((cb) => cb(line));
        }
        if (req.action === "uninstall") {
          return { ok: true, state: "removed", text: "Lazyfox is removed. Firefox is back to normal.", failures: null, pendingEnable: false };
        }
        return { ok: true, state: "installed", text: "Lazyfox is installed.", failures: null, pendingEnable: true };
      },
      BrowseFirefoxDir: async () => FF_DIR,
      BrowseProfileDir: async () => STABLE_PROFILE,
    },
    onStep: (cb: (s: { kind: string; text: string }) => void) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
}
