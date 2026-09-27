// The wire types, mirroring installer/internal/app/dto.go. They are written by
// hand rather than generated because they are the contract, not a by-product:
// changing one is changing the installer's UI, and it should be deliberate.

export type ActionId = "install" | "uninstall" | "loader-only" | "loader-remove";

export type LoaderState = "current" | "outdated" | "missing";

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
  installs: InstallInfo[];
  profiles: ProfileInfo[];
  actions: ActionInfo[];
  defaultInstall: number;
  defaultProfile: number;
  defaultUninstallProfile: number;
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
  removeLoader: boolean;
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
  removeLoader: boolean;
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
  state: "installed" | "removed" | "failed";
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
