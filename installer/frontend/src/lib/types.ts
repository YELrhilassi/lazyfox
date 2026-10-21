// The wire types, mirroring installer/internal/app/dto.go. They are written by
// hand rather than generated because they are the contract, not a by-product:
// changing one is changing the installer's UI, and it should be deliberate.

export type ActionId = "install" | "update" | "uninstall" | "loader-only" | "loader-remove";

/** The installer's measurement of one profile, from ops.InstallStatus. */
export type LazyfoxState = "not-installed" | "current" | "outdated" | "newer" | "incomplete";

export type LoaderState = "current" | "outdated" | "missing";

/** The optional native messaging host, as the installer measures it. */
export type HostState = "missing" | "ok" | "unregistered" | "stale";

export interface InstallInfo {
  label: string;
  exec: string;
  dir: string;
  flavor: string;
  loader: LoaderState;
}

export interface ProfileInfo {
  name: string;
  dir: string;
  label: string;
  edition: string;
  version: string;
  flavor: string;
  locked: boolean;
  hasLazyfox: boolean;
  isDefault: boolean;
  owned: boolean;
  recommended: boolean;
  /** Version of the Lazyfox add-on installed in this profile, read from its own
   *  xpi. Empty when it is not installed. */
  lazyfoxVersion: string;
  /** What this profile holds relative to the installer binary: current,
   *  outdated, newer, incomplete or not-installed. */
  lazyfoxState: LazyfoxState;
  /** The optional native messaging host: absent (normal for a store install),
   *  installed and registered, or installed but not registered — the state in
   *  which the add-on cannot reach it and an update is the fix. */
  hostState: HostState;
}

export interface ActionInfo {
  id: ActionId;
  label: string;
  desc: string;
}

export interface State {
  channel: string;
  channelShort: string;
  channelLabel: string;
  profilePolicy: string;
  devChannel: boolean;
  platform: string;
  payloadOrigin: string;
  hasDist: boolean;
  addonAvailable: boolean;
  /** Version of the add-on this installer binary carries, read from its own xpi
   *  manifest. Empty string when it could not be read. */
  addonVersion: string;
  installs: InstallInfo[];
  profiles: ProfileInfo[];
  actions: ActionInfo[];
  defaultInstall: number;
  defaultProfile: number;
  defaultUninstallProfile: number;
  /** True when some profile holds an older or partial install — the state an
   *  update fixes. */
  updateAvailable: boolean;
  /** Profile pre-selected for an update: the one that needs it, else ours. */
  defaultUpdateProfile: number;
}

/** Selection is everything the user has chosen, before it becomes a Request. */
export interface Selection {
  action: ActionId;
  installDir: string;
  profileDir: string;
  newProfile: boolean;
  newProfileName: string;
  useExtension: boolean;
  useLaunch: boolean;
  /** keepLoader leaves the chrome loader installed on an uninstall; removing it
   *  is the default. */
  keepLoader: boolean;
  deleteProfile: boolean;
}

export interface Request {
  action: ActionId;
  installDir: string;
  profileDir: string;
  newProfile: boolean;
  newProfileName: string;
  useExtension: boolean;
  useLaunch: boolean;
  keepLoader: boolean;
  deleteProfile: boolean;
}

export interface ChangeInfo {
  path: string;
  kind: "file" | "prefs" | "json" | "profile" | "registry" | "loader";
  detail: string;
  elevated: boolean;
  profileSide: boolean;
  optional: boolean;
}

export interface RemovalInfo {
  path: string;
  kind: ChangeInfo["kind"];
  detail: string;
  exists: boolean;
  owned: boolean;
  restorable: boolean;
}

export interface Preview {
  action: ActionId;
  install: InstallInfo;
  profile: ProfileInfo;
  createsProfile: boolean;
  deletesProfile: boolean;
  changes: ChangeInfo[] | null;
  removals: RemovalInfo[] | null;
  unchanged: RemovalInfo[] | null;
  summary: string;
  needsAdmin: boolean;
  warnings: string[] | null;
}

export interface Result {
  ok: boolean;
  state: "installed" | "updated" | "removed" | "failed";
  text: string;
  failures: string[] | null;
  pendingEnable: boolean;
}

export interface Step {
  kind: "step" | "warn" | "note";
  text: string;
}

/** A profile name is a directory name, so it may not contain a path separator. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
