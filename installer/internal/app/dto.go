package app

// The wire types the window sees. They are plain JSON shapes on purpose: the Go
// side stays free to grow fields without the front-end having to be rebuilt
// against generated bindings.

// InstallInfo is one Firefox installation this build can target.
type InstallInfo struct {
	Label string `json:"label"`
	Exec  string `json:"exec"`
	Dir   string `json:"dir"`
	// Flavor is the edition (stable / esr / developer / nightly).
	Flavor string `json:"flavor"`
	// Loader is "current", "outdated" or "missing" — computed from the same
	// payload registry the installer writes from, so the window can never
	// promise a loader state the install would not produce.
	Loader string `json:"loader"`
}

// ProfileInfo is one Firefox profile this build can write to.
type ProfileInfo struct {
	Name       string `json:"name"`
	Dir        string `json:"dir"`
	Label      string `json:"label"`
	Edition    string `json:"edition"`
	Version    string `json:"version"`
	Flavor     string `json:"flavor"`
	Locked     bool   `json:"locked"`
	HasLazyfox bool   `json:"hasLazyfox"`
	IsDefault  bool   `json:"isDefault"`
	// Owned marks a profile the installer created; only those may ever be
	// deleted, and only when the user asks.
	Owned bool `json:"owned"`
	// Recommended marks the profile the installer would choose on its own.
	Recommended bool `json:"recommended"`
}

// ActionInfo describes one thing the user can ask for, so the window's first
// step is data rather than duplicated copy.
type ActionInfo struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Desc  string `json:"desc"`
}

// State is everything the window needs before the user chooses anything.
type State struct {
	Channel      string `json:"channel"`
	ChannelShort string `json:"channelShort"`
	ChannelLabel string `json:"channelLabel"`
	// ProfilePolicy is the fixed per-channel rule for where an install goes.
	ProfilePolicy  string `json:"profilePolicy"`
	DevChannel     bool   `json:"devChannel"`
	Platform       string `json:"platform"`
	PayloadOrigin  string `json:"payloadOrigin"`
	HasDist        bool   `json:"hasDist"`
	AddonAvailable bool   `json:"addonAvailable"`

	Installs []InstallInfo `json:"installs"`
	Profiles []ProfileInfo `json:"profiles"`
	Actions  []ActionInfo  `json:"actions"`

	// DefaultInstall / DefaultProfile are indices, or -1 for "none".
	DefaultInstall int `json:"defaultInstall"`
	DefaultProfile int `json:"defaultProfile"`
	// DefaultUninstallProfile pre-selects, for an uninstall, the profile Lazyfox
	// created for this channel — since that is what an installer-managed install
	// used. It equals DefaultProfile when this channel has no profile of its own.
	DefaultUninstallProfile int `json:"defaultUninstallProfile"`
}

// Request is one operation the window asks for, already narrowed to a choice.
type Request struct {
	// Action is install | uninstall | loader-only | loader-remove.
	Action string `json:"action"`
	// InstallDir is the chosen Firefox, by directory; empty means "yours".
	InstallDir string `json:"installDir"`
	// ProfileDir is the chosen profile, by directory.
	ProfileDir string `json:"profileDir"`
	// NewProfile asks for a fresh Lazyfox-owned profile instead of ProfileDir,
	// and NewProfileName is the exact name that profile will get — decided
	// before the run so the preview and the run cannot name different folders.
	NewProfile     bool   `json:"newProfile"`
	NewProfileName string `json:"newProfileName"`

	UseExtension bool `json:"useExtension"`
	UseLaunch    bool `json:"useLaunch"`
	RemoveLoader bool `json:"removeLoader"`
	// DeleteProfile (uninstall) also removes the Lazyfox-owned profile. It is
	// only ever honoured for a profile carrying the Lazyfox marker.
	DeleteProfile bool `json:"deleteProfile"`
}

// ChangeInfo is one thing an install will write. Kinds: file, prefs, json,
// profile, registry, loader.
type ChangeInfo struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
	// Elevated marks a change that needs administrator rights.
	Elevated bool `json:"elevated"`
	// ProfileSide marks a change inside a Firefox profile (as opposed to the
	// Firefox installation folder or the user's home).
	ProfileSide bool `json:"profileSide"`
	// Optional marks a step that is skipped when it is unavailable (the native
	// messaging host).
	Optional bool `json:"optional"`
}

// RemovalInfo is one thing an uninstall will delete — or deliberately leave
// alone. Exists reports whether it is actually on disk right now, so a review
// screen never lists a file that is not there.
type RemovalInfo struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
	Exists bool   `json:"exists"`
	// Owned marks a directory Lazyfox created and therefore may delete.
	Owned bool `json:"owned"`
	// Restorable marks a file that is backed up before removal, so it can be
	// brought back afterwards.
	Restorable bool `json:"restorable"`
}

// Preview is the answer to "what exactly is about to happen?", rendered before
// anything is touched. For an uninstall it is the review the user is owed: the
// complete list of files that go, and the complete list of things that stay.
type Preview struct {
	Action  string      `json:"action"`
	Install InstallInfo `json:"install"`
	Profile ProfileInfo `json:"profile"`

	// CreatesProfile / DeletesProfile describe the profile itself.
	CreatesProfile bool `json:"createsProfile"`
	DeletesProfile bool `json:"deletesProfile"`

	// Changes is what an install will write (empty for an uninstall).
	Changes []ChangeInfo `json:"changes"`
	// Removals is what an uninstall will delete.
	Removals []RemovalInfo `json:"removals"`
	// Unchanged is what the operation deliberately leaves alone — the direct
	// answer to "will this eat my stuff?".
	Unchanged []RemovalInfo `json:"unchanged"`

	// Summary is a one-line description of the operation.
	Summary string `json:"summary"`
	// NeedsAdmin is true when one step needs administrator rights.
	NeedsAdmin bool `json:"needsAdmin"`
	// Warnings are things worth knowing before running.
	Warnings []string `json:"warnings"`
}

// Result is the outcome of a run.
type Result struct {
	OK bool `json:"ok"`
	// State is "installed", "removed" or "failed".
	State string `json:"state"`
	Text  string `json:"text"`
	// Failures lists the verification checks that did not pass, when the run
	// otherwise completed.
	Failures []string `json:"failures"`
	// PendingEnable is true when Firefox has to be started once before the
	// add-on appears — reported rather than silently claimed as done.
	PendingEnable bool `json:"pendingEnable"`
}

// Step is one progress line streamed to the window while a run is in flight.
type Step struct {
	// Kind is step | warn | note.
	Kind string `json:"kind"`
	Text string `json:"text"`
}
