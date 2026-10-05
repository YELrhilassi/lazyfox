// The fixture's shared vocabulary.
//
// Deliberately tiny: the helpers themselves live in the per-concern modules
// (pages, tabs, numbering, keys, waits, probe, chromestate, config,
// lifecycle) and are attached to one `ctx` bag by fixture.ts.

// Modifier keys a press may carry. Named once so every helper that forwards
// opts to keyTap/sendKeys agrees on the shape.
export interface KeyOpts {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}