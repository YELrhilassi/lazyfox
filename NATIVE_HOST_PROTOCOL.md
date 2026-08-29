# Lazyfox Native Messaging Host Protocol

## Overview

Replace the `#lfc=` URL hash channel with a proper native messaging host using `browser.runtime.sendNativeMessage()`.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  WebExtension (Firefox)                                         │
│  ┌─────────────┐    sendNativeMessage()    ┌─────────────────┐  │
│  │ background  │ ◄────────────────────────► │ Native Host     │  │
│  │ content     │    JSON-RPC 2.0 over      │ (Go binary)     │  │
│  │ popups      │    stdio (newline-delim)  │                 │  │
│  └─────────────┘                           └─────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Manifest Entry

```json
// In extension manifest.json
"browser_specific_settings": {
  "gecko": {
    "id": "lazyfox@lazyfox.dev",
    "strict_min_version": "109.0"
  }
},
"permissions": ["nativeMessaging"],
"browser_specific_settings": {
  "gecko": {
    "id": "lazyfox@lazyfox.dev"
  }
}
```

```json
// /usr/lib/mozilla/native-messaging-hosts/lazyfox.json (Linux)
{
  "name": "lazyfox",
  "description": "Lazyfox native messaging host",
  "path": "/usr/local/bin/lazyfox-host",
  "type": "stdio",
  "allowed_extensions": ["lazyfox@lazyfox.dev"]
}
```

## JSON-RPC 2.0 Protocol

All messages are newline-delimited JSON over stdio.

### Request (Extension → Host)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "method.name",
  "params": { ... }
}
```

### Response (Host → Extension)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { ... }
}
```

### Error Response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32600,
    "message": "Invalid Request",
    "data": { ... }
  }
}
```

### Notification (Host → Extension, no response expected)

```json
{
  "jsonrpc": "2.0",
  "method": "event.name",
  "params": { ... }
}
```

---

## Methods (Extension → Host)

### Session Management

#### `session.list`
List all saved sessions.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 1, "method": "session.list", "params": {} }
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessions": [
      { "name": "work", "tabs": [...], "marker": 1, "updated": 1234567890 },
      { "name": "personal", "tabs": [...], "marker": 2, "updated": 1234567891 }
    ]
  }
}
```

#### `session.save`
Save current tabs as a session.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session.save",
  "params": { "name": "work", "marker": 1 }
}
```

#### `session.load`
Load a session (restore tabs).

**Request:**
```json
{ "jsonrpc": "2.0", "id": 3, "method": "session.load", "params": { "name": "work" } }
```

#### `session.delete`
Delete a session.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 4, "method": "session.delete", "params": { "name": "work" } }
```

#### `session.marker`
Assign/remove marker (1-9) for quick switching.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 5, "method": "session.marker", "params": { "name": "work", "marker": 1 } }
```

#### `session.switch_marker`
Hot-swap to marked session.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 6, "method": "session.switch_marker", "params": { "marker": 1 } }
```

---

### Tab Operations

#### `tabs.list`
List all tabs in current window.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 10, "method": "tabs.list", "params": { "filter": "" } }
```

#### `tabs.activate`
Activate a tab by ID.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 11, "method": "tabs.activate", "params": { "tabId": 123 } }
```

#### `tabs.close`
Close a tab.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 12, "method": "tabs.close", "params": { "tabId": 123 } }
```

#### `tabs.move`
Move tab position.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 13, "method": "tabs.move", "params": { "tabId": 123, "delta": 1 } }
```

#### `tabs.pin`
Pin/unpin tab.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 14, "method": "tabs.pin", "params": { "tabId": 123, "pinned": true } }
```

#### `tabs.mute`
Mute/unmute tab.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 15, "method": "tabs.mute", "params": { "tabId": 123, "muted": true } }
```

#### `tabs.duplicate`
Duplicate a tab.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 16, "method": "tabs.duplicate", "params": { "tabId": 123 } }
```

#### `tabs.new`
Create new tab.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 17, "method": "tabs.new", "params": { "url": "https://example.com", "active": true } }
```

---

### Split View

#### `split.horizontal`
Split current tab horizontally.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 20, "method": "split.horizontal", "params": {} }
```

#### `split.vertical`
Split current tab vertically (if supported).

**Request:**
```json
{ "jsonrpc": "2.0", "id": 21, "method": "split.vertical", "params": {} }
```

#### `split.unsplit`
Unsplit current pane.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 22, "method": "split.unsplit", "params": {} }
```

#### `split.switch_pane`
Switch to adjacent pane.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 23, "method": "split.switch_pane", "params": { "direction": 1 } }
```

#### `split.swap_panes`
Swap panes.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 24, "method": "split.swap_panes", "params": { "direction": 1 } }
```

#### `split.move_tab_to_split`
Move tab N into active split.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 25, "method": "split.move_tab_to_split", "params": { "index": 1 } }
```

#### `split.restore_splits`
Restore saved split layout.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 26, "method": "split.restore_splits", "params": { "layout": [[0,1],[2]] } }
```

---

### Window Management

#### `window.resize`
Resize window.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 30, "method": "window.resize", "params": { "dx": -20, "dy": 0 } }
```

#### `window.move`
Move window.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 31, "method": "window.move", "params": { "dx": -40, "dy": 0 } }
```

---

### History

#### `history.list`
List history entries.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 40, "method": "history.list", "params": { "filter": "" } }
```

#### `history.remove`
Remove history entry.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 41, "method": "history.remove", "params": { "url": "https://example.com" } }
```

#### `history.clear`
Clear all history.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 42, "method": "history.clear", "params": {} }
```

---

### Recently Closed

#### `recently_closed.list`
List recently closed tabs/windows.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 50, "method": "recently_closed.list", "params": {} }
```

#### `recently_closed.restore`
Restore a recently closed tab.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 51, "method": "recently_closed.restore", "params": { "key": "abc123" } }
```

#### `recently_closed.restore_all`
Restore all recently closed.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 52, "method": "recently_closed.restore_all", "params": {} }
```

---

### Bookmarks

#### `bookmarks.list`
List bookmarks.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 60, "method": "bookmarks.list", "params": { "filter": "" } }
```

---

### Downloads

#### `downloads.list`
List downloads.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 70, "method": "downloads.list", "params": { "filter": "" } }
```

#### `downloads.open`
Open downloaded file.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 71, "method": "downloads.open", "params": { "key": 123 } }
```

#### `downloads.open_location`
Open download folder.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 72, "method": "downloads.open_location", "params": { "key": 123 } }
```

#### `downloads.remove`
Remove download (two-step: arm then confirm).

**Request:**
```json
{ "jsonrpc": "2.0", "id": 73, "method": "downloads.remove", "params": { "key": 123, "confirm": true } }
```

---

### Search / URL

#### `search.suggest`
Get search suggestions.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 80, "method": "search.suggest", "params": { "query": "lazy" } }
```

#### `search.open`
Open search result.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 81, "method": "search.open", "params": { "query": "lazyfox", "newTab": true } }
```

#### `url.suggest`
Get URL suggestions.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 82, "method": "url.suggest", "params": { "query": "github" } }
```

#### `url.open`
Open URL.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 83, "method": "url.open", "params": { "url": "https://github.com", "newTab": true } }
```

---

### Leader Key / Typing

#### `keys.dispatch`
Dispatch a key sequence through the leader/typing pipeline.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 90,
  "method": "keys.dispatch",
  "params": {
    "keys": [
      { "key": ";", "shift": false, "ctrl": false, "alt": false, "meta": false },
      { "key": "f", "shift": false, "ctrl": false, "alt": false, "meta": false }
    ],
    "targetTab": 123
  }
}
```

#### `leader.arm`
Arm the leader key.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 91, "method": "leader.arm", "params": {} }
```

#### `leader.disarm`
Disarm the leader key.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 92, "method": "leader.disarm", "params": {} }
```

---

### Config

#### `config.get`
Get current configuration.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 100, "method": "config.get", "params": {} }
```

#### `config.set`
Set configuration.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "method": "config.set",
  "params": {
    "bindings": { "leader": ";", "search": "s" },
    "config": { "statusBarPosition": "bottom", "hoverReveal": true }
  }
}
```

---

### Find in Page

#### `find.search`
Search in page.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 110, "method": "find.search", "params": { "query": "lazy", "tabId": 123 } }
```

#### `find.next`
Next match.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 111, "method": "find.next", "params": { "tabId": 123 } }
```

#### `find.previous`
Previous match.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 112, "method": "find.previous", "params": { "tabId": 123 } }
```

#### `find.yank`
Yank current match.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 113, "method": "find.yank", "params": { "tabId": 123 } }
```

---

### Debug / Dev

#### `debug.reveal`
Open devtools for extension.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 200, "method": "debug.reveal", "params": {} }
```

#### `debug.console`
Log to browser console.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 201, "method": "debug.console", "params": { "message": "test" } }
```

#### `debug.diag`
Get diagnostic info.

**Request:**
```json
{ "jsonrpc": "2.0", "id": 202, "method": "debug.diag", "params": {} }
```

---

## Events (Host → Extension, no response)

### `session.changed`
Session list changed.

```json
{ "jsonrpc": "2.0", "method": "session.changed", "params": { "sessions": [...] } }
```

### `tabs.changed`
Tab list changed.

```json
{ "jsonrpc": "2.0", "method": "tabs.changed", "params": { "tabs": [...] } }
```

### `split.changed`
Split layout changed.

```json
{ "jsonrpc": "2.0", "method": "split.changed", "params": { "layout": [[0,1],[2]] } }
```

### `leader.arm_changed`
Leader armed/disarmed.

```json
{ "jsonrpc": "2.0", "method": "leader.arm_changed", "params": { "tabId": 123, "armed": true } }
```

### `find.state_changed`
Find state changed.

```json
{ "jsonrpc": "2.0", "method": "find.state_changed", "params": { "tabId": 123, "count": 5, "current": 2 } }
```

### `download.progress`
Download progress update.

```json
{ "jsonrpc": "2.0", "method": "download.progress", "params": { "key": 123, "progress": 0.5, "state": "in_progress" } }
```

### `config.changed`
Configuration changed.

```json
{ "jsonrpc": "2.0", "method": "config.changed", "params": { "bindings": {...}, "config": {...} } }
```

---

## Implementation Notes

### Native Host Binary
- Written in Go
- Installed via `npm run build` to `/usr/local/bin/lazyfox-host` (Linux)
- Manifest installed to `/usr/lib/mozilla/native-messaging-hosts/lazyfox.json`
- Uses stdio for communication (JSON-RPC 2.0, newline-delimited)

### Extension Side
- `browser.runtime.sendNativeMessage('lazyfox', request)` for requests
- `browser.runtime.onMessageExternal.addListener` for events
- Connection management: keep port open, reconnect on crash

### Security
- Manifest `allowed_extensions` restricts to `lazyfox@lazyfox.dev`
- Host runs with user permissions (not SystemPrincipal)
- Input validation on all params

### Error Handling
- Host crashes: extension detects stdin close, shows toast, offers restart
- Timeout: 30s default, configurable per method
- Invalid params: return JSON-RPC error with code -32602

---

## Migration Strategy

### Phase 1: Native Host Skeleton
1. Create Go project with JSON-RPC stdio server
2. Implement `session.list`, `session.save`, `session.load`
3. Test with extension background script

### Phase 2: Tab Operations
- `tabs.list`, `tabs.activate`, `tabs.close`, `tabs.new`, `tabs.move`

### Phase 3: Split View
- `split.horizontal`, `split.unsplit`, `split.switch_pane`, `split.move_tab_to_split`

### Phase 4: Leader Key / Typing
- `keys.dispatch`, `leader.arm`, `leader.disarm`

### Phase 5: Config, History, Downloads, Bookmarks, Search, Find

### Phase 6: Remove All `#lfc=` Code
- Delete `src/chrome/channel.ts`
- Remove all `requestBg`, `requestSessionState`, `handleLfc` calls
- Update `ops.ts`, `main.ts`, `splitview.ts`, `debug.ts`, `config.ts`

### Phase 7: Chrome Helper Slim-down
- Keep only minimal UI injection (userChrome.css, userChrome.uc.js)
- Move all logic to native host or extension content scripts