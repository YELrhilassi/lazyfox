package fx

// Firefox artifact names. These live with the domain model because they are
// what Firefox itself expects in a profile — the installer's payload layer
// ships exactly these names, and the operations layer edits exactly these
// files, so nobody gets to invent a variant.
const (
	// AddonID is the WebExtension id (also the native-messaging allow-list
	// entry and the id looked up in extensions.json).
	AddonID = "lazyfox@lazyfox.dev"
	// ExtensionXpiName is the on-disk add-on file in a profile's extensions/.
	ExtensionXpiName = "lazyfox@lazyfox.dev.xpi"
	// ExtensionsJSONName is Firefox's add-on registry inside a profile.
	ExtensionsJSONName = "extensions.json"
	// AddonStartupName is the startup cache Firefox rebuilds when it is dropped;
	// removing it forces a re-import of a freshly written xpi.
	AddonStartupName = "addonStartup.json.lz4"
)
