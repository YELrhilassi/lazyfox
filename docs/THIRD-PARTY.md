# Third-party notices

This project ships code and data written by other people. This file says what,
where, and under which licence — read it before editing anything it names.

## Dark Reader — the fix corpus

`src/shared/dark-fixes.ts` ships a curated copy of Dark Reader's per-site fix
lists. It is the default value of the dark mode **fix corpus** setting
(`config.dark.fixes`), i.e. user-editable text, and it is the only reason the
engine works on the sites that need a hand-written rule.

| | |
| --- | --- |
| Source | https://github.com/darkreader/darkreader |
| Files copied from | `src/config/dynamic-theme-fixes.config`, `src/config/inversion-fixes.config` |
| Taken | `main`, 2026-10-15 |
| Licence | MIT |
| Copyright | Copyright (c) 2026 Dark Reader Ltd. |

What was changed, stated exactly:

* **Blocks were trimmed** to the directives this engine implements. Upstream's
  `--darkreader-bg--*` inline-analysis variables and its stylesheet-rewriting
  machinery have no counterpart in `shared/dark-rules.ts`, so rules that depend
  on them were dropped rather than shipped as decoration. A trimmed block is
  still an upstream block.
* A provenance **header** was prepended to the text (`#` comment lines — our
  parser skips them; upstream's format has no comment convention).
* Nothing was retyped and no selector was invented.

**Not tested here.** These are the community's claims about the community's
sites, and this project has no harness that visits them. Treat every entry as a
starting point to edit.

The MIT licence, as it appears in the source repository:

```
MIT License

Copyright (c) 2026 Dark Reader Ltd.

All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### What "Dark Reader's format" means in this tree

The **format** is adopted deliberately, so that a file written for that project
can be pasted into Lazyfox's settings and work (see
[docs/DARK-MODE.md](DARK-MODE.md)):

* the directive names are copied exactly, including `IGNORE INLINE STYLE`;
* `${white}` / `${black}` keep upstream's meaning (the theme's text colour and
  canvas, not the colours white and black); every other `${…}` template means
  "this exact colour, do not transform it", which is also upstream's meaning;
* the `--darkreader-*` custom properties are defined by our sheet, because
  upstream rules are written against them;
* `[data-darkreader-scheme="…"]` is re-pointed at our `data-lf-scheme`.

The parser, the engine and the settings UI are this project's own work.
