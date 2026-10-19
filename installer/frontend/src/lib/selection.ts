import type { ActionId, Request, Selection, State } from "./types";

/** initialSelection is the state the window opens on, per action. */
export function initialSelection(state: State, action: ActionId): Selection {
  return {
    action,
    installDir: pickInstall(state),
    profileDir: action === "uninstall" ? pickUninstallProfile(state) : pickInstallProfile(state),
    // A channel-managed profile is the installer's own to create, so the user
    // starts with the recommendation rather than with "make me a new one".
    newProfile: false,
    newProfileName: "",
    useExtension: true,
    useLaunch: true,
    removeLoader: false,
    deleteProfile: false,
  };
}

/**
 * resetForAction carries the machine-level choices (which Firefox) across, and
 * drops the ones that belonged to the previous action: the profile worth
 * recommending for an install is not the one worth offering for an uninstall.
 */
export function resetForAction(state: State, sel: Selection, action: ActionId): Selection {
  return {
    ...initialSelection(state, action),
    installDir: sel.installDir || pickInstall(state),
  };
}

function pickInstall(state: State): string {
  const i = state.defaultInstall >= 0 ? state.defaultInstall : 0;
  return state.installs[i]?.dir ?? "";
}

function pickInstallProfile(state: State): string {
  const i = state.defaultProfile;
  return (i >= 0 ? state.profiles[i]?.dir : undefined) ?? "";
}

function pickUninstallProfile(state: State): string {
  const i = state.defaultUninstallProfile >= 0 ? state.defaultUninstallProfile : state.defaultProfile;
  return (i >= 0 ? state.profiles[i]?.dir : undefined) ?? "";
}

/**
 * toRequest turns a selection into the Go layer's request.
 *
 * `pinProfileName` is the profile name a previous Preview showed for a profile
 * that is about to be created. Sending it back means the folder the user
 * reviewed is the folder that gets created, rather than a fresh random one.
 */
export function toRequest(sel: Selection, pinProfileName?: string): Request {
  const newProfileName = pinProfileName || sel.newProfileName;
  return {
    action: sel.action,
    installDir: sel.installDir,
    profileDir: sel.newProfile ? "" : sel.profileDir,
    newProfile: sel.newProfile,
    newProfileName,
    useExtension: sel.useExtension,
    useLaunch: sel.useLaunch,
    removeLoader: sel.removeLoader,
    deleteProfile: sel.deleteProfile,
  };
}

/** needsProfile reports whether an action targets a Firefox profile. */
export function needsProfile(action: ActionId): boolean {
  return action === "install" || action === "uninstall";
}

/**
 * targetSummary is the "where does this land" line the footer shows. It names
 * the destination rather than restating the channel's policy, which the first
 * step already carries.
 */
export function targetSummary(state: State, sel: Selection): string {
  if (!needsProfile(sel.action)) {
    const install = state.installs.find((fi) => fi.dir === sel.installDir) ?? state.installs[0];
    return install ? `Chrome loader in ${install.dir}` : "";
  }
  if (sel.newProfile) {
    return sel.newProfileName ? `New profile: ${sel.newProfileName}` : "New profile, named by Lazyfox";
  }
  if (state.devChannel && sel.action === "install") {
    const owned = state.profiles.find((p) => p.owned);
    return owned ? `Its own profile: ${owned.name}` : "Its own new profile";
  }
  const profile = state.profiles.find((p) => p.dir === sel.profileDir);
  return profile ? `Profile: ${profile.name}` : "Choose a profile";
}

/** actionVerb is the primary button's word for an action. */
export function actionVerb(action: ActionId): string {
  switch (action) {
    case "install":
      return "Install";
    case "uninstall":
      return "Remove";
    case "loader-only":
      return "Install loader";
    case "loader-remove":
      return "Remove loader";
  }
}
