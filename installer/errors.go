package main

import "errors"

// errNoProfile is returned when no usable profile could be resolved.
var errNoProfile = errors.New("could not find a Firefox profile automatically.\n" +
	"Open Firefox, go to about:support and copy the 'Profile Folder' path, then run with:\n" +
	"  lazyfox-install --profile \"/path/to/profile\"")
