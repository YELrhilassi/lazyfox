# AMO store listing

The listing text lives in two places so the API and this page agree:

- `scripts/amo-listing.ts` pushes the summary, description, links, categories
  and tags through the addons.mozilla.org v5 API (`npm run listing`).
- This page is the same copy, plus the parts the API cannot set: screenshots
  and the curated tag pick.

Dashboard: https://addons.mozilla.org/developers/addon/lazyfox2/edit/

## Icon

The package icon comes from `manifest.json`. The source is
`docs/img/lazyfox-mark.svg`; the horizontal logo is only for headers.
`npm run gen:icons` rebuilds the PNG set.

## Listing copy

**Name:** Lazyfox

**Summary** (250 characters or fewer):

> Firefox with the toolbar and tab strip removed. Press `;` for tabs, sessions,
> hints, find and search. Keyboard-first, no telemetry.

**Description:**

```
Lazyfox removes Firefox's toolbar and tab strip. Pages fill the window, and a
slim bar at the bottom shows the session, tab position and downloads.

Press ; to see the keys for tabs, sessions, link hints, find and search, then
press the one you want.

The home page is a command center over open tabs, history, bookmarks and
downloads, with quick-launch tiles for the sites you use.

Split view, named sessions, isolated tabs, reader mode and dark mode are one key
away. Nothing is sent anywhere: no account, no telemetry.

Install the add-on, open the home page and choose Complete the install to remove
the browser chrome. Your bookmarks, passwords and other add-ons are not touched.
```

## Tags and category

Tags come from AMO's curated list, so the API rejects anything else:

```
container, privacy, search
```

Category: `tabs`.

## Screenshots

All ten are captured by `node scripts/e2e/screenshots.ts` into `docs/img/`.
Each one is a full-window shot: the chrome layer is installed, the popups are
opened with the product's own keys, and the tabs, sessions, downloads and
history are real state in a throwaway profile.

| # | File | Caption |
|---|---|---|
| 1 | `command-center.png` | The command center: search tabs, history, bookmarks and downloads. |
| 2 | `tabs.png` | The tab switcher, with the number that jumps to each tab. |
| 3 | `sessions.png` | Named sessions, with the selected session's tabs. |
| 4 | `downloads.png` | Downloads, with state and file size. |
| 5 | `history.png` | History grouped by day, with a details pane. |
| 6 | `which-key.png` | Press `;` for every binding on this page. |
| 7 | `hints.png` | Link hints put a key on every visible control. |
| 8 | `find.png` | Find in page, with a live count and yank. |
| 9 | `options.png` | Settings for keys, sessions, dark mode and reader. |
| 10 | `statusbar.png` | The status bar: session, tab position and downloads. |

AMO caps screenshots at ten. To replace the set, delete the old previews in the
dashboard, then run `npm run screenshots`. Uploads are rate-limited, so a full
set takes a while; the uploader skips positions that already exist.

## Links

- Homepage: https://github.com/YELrhilassi/lazyfox
- Support: https://github.com/YELrhilassi/lazyfox/issues
- License: MIT
- Privacy: "No data is collected, stored on or sent to any server."

## Commands

```
npm run gen:icons     # rebuild the PNG icon set from the mark
npm run screenshots   # capture docs/img/*.png and upload them
npm run listing       # push summary, description, links, categories and tags
npm run submit        # upload a listed version for review
```
