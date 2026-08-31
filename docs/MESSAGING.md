# Lazyfox messaging: persistent relay + native host — plan & design

Status: **implemented on `feat/native-host-relay`** (off `dev-nightly`).
Stages 1–3 below are done and verified with the BiDi suite; this document
records the design for anyone touching the channel.

## The problem

Every `#lfc=` message between the chrome helper and the extension background
used to open a **throwaway tab** (`commandcenter.html#lfc=req.<action>…`),
hold it under a 3–5 s safety timeout, then delete it. Users saw empty tabs
popping up and auto-closing, and the hash handshake was timing-sensitive (a
reply raced the removal, a safety timeout dropped a request that landed late,
a fresh clone's first launch churned tab counts). That was the reported
unreliability.

## The constraint (why native messaging alone can't fix it)

`browser.runtime.sendNativeMessage` connects the **extension** to an external
**Go host** over stdio. It is the sanctioned channel for *extension ↔ external
process*. It is NOT a channel the **chrome helper** can use: the helper runs in
the privileged browser-chrome document and has no `browser.runtime`, so it
cannot send a native message, and there is no sanctioned API for a
chrome-privileged script to message an extension except the URL/hash/tab
mechanism.

So messaging is really **two separate channels**, with two separate fixes:

| Channel | Direction | Today | Fix |
|---------|-----------|-------|-----|
| Helper ↔ background | both | throwaway `#lfc=` tabs | **persistent relay tab** (no tab churn, no create/remove race) — DONE |
| Extension ↔ Go host | extension → host | scaffold stubs, not built, not wired | **built, installed with a native-messaging manifest, used via `host.ts`** — DONE |

## Stage 1 — persistent relay (replaces throwaway `#lfc=` tabs) — DONE

Goal: **zero tab churn**. One dedicated, hidden relay tab carries every
helper↔background message; nothing is created or removed per message.

### Design

- **The relay tab**: `relay.html` (a hidden extension page, marker by page
  name — its URL never changes). Owned lazily: the chrome helper creates it on
  first need; the background's `ensureRelayTab()` recreates it if it dies. It
  is registered in `transientTabIds` and hidden via `browser.tabs.hide` the
  moment it appears, so it never counts as a user tab or shows in the strip.
- **The relay page** (`src/extension/relay.ts`) is the bridge between two
  worlds: the background's `runtime` Port (`lazyfox-relay[:<windowId>]`) and
  the chrome helper's direct `postMessage` into the page's window. Protocol
  (all messages `{ lfx: <msg> }`):
  - helper → page: `{ type: "req", id, action, arg }` (chrome → background)
  - page → helper: `{ type: "resp", id, result|error }` (background reply)
  - page → helper: `{ type: "cmd", action, arg }` (background → chrome push)
  - helper → page: `{ type: "hello" }` (helper's listener is attached)
  - page → helper: `{ type: "ready" }` (port connected)
- **Round-trips keep their nonces.** The helper keys reply waiters by request
  id and resolves them on the `resp` message; the relay page shuttles
  structured-cloneable payloads both ways, so objects arrive as objects (no
  base64 of the old hash channel).
- **Robust delivery**:
  - The helper's `startRelay()` re-resolves the relay window on every call
    (the `<browser>`'s contentWindow is REPLACED when the page commits) and
    reads the page's `__lfxReady` flag through `wrappedJSObject` (Xray
    wrappers hide content-set expandos).
  - The background's `requestChrome()` verifies the port is live before
    posting — a session restore removes the relay tab (it is unpinned), so the
    map can hold a DEAD port whose disconnect hasn't fired yet; posting into
    it silently dropped commands (the `restoreSplits` bug). It falls through
    to ensure+queue and retries until the port delivers or the command ages
    out (TTL), so a command is never lost to a half-torn-down relay.
  - The relay page buffers background→chrome commands until the helper's
    `hello` arrives (the helper re-attaches its listener a beat after a
    recreation), then flushes in order — a command posted into an unlistened
    window was lost before this handshake existed.
- **Recovery:** if the relay tab dies, the next request recreates it lazily —
  both sides already tolerate "tab not found".

### Files

- `src/chrome/channel.ts` — the helper side: relay resolution/creation, the
  req/resp/cmd bridge, reply waiters, and the real-tab `#lfc=` channels that
  deliberately ride REAL tabs (`keys` test synthesizer, `state`/`cfg`/`open`
  debug/UI hashes).
- `src/extension/background.ts` — `requestChrome` (robust delivery above), the
  relay port handling (`onConnect` drain + `relayCmdQueues`), `ensureRelayTab`.
- `src/extension/relay.ts` — the tiny relay page: port connect/reconnect,
  message shuttle, the command buffer + hello handshake.
- `src/shared/transient.ts` — `isRelayTabUrl` (relay.html + the leftover
  `#lfc=req.*` markers never shift user numbering).
- `src/extension/tabs.ts` / `src/chrome/splitview.ts` / `statusbar.ts` —
  real-tab predicates skip the relay so numbering never shifts.

## Stage 2 — native messaging host (extension ↔ Go) — DONE

The Go host is **built, installed to the right place, and actually used** from
the extension — while degrading gracefully when it's absent (store/standalone
installs).

### What the host owns

The old scaffold's stub list (tabs/history/sessions/…) was **wrong** — those
are the extension's `browser.*` APIs and the host can't reach them. The host
owns what only an external process can:

- `host.info` / `host.ping` / `host.diag` — health + diagnostics.
- System-level operations the extension cannot do (synthetic input,
  window management beyond `browser.windows`, file/path helpers outside the
  profile) — the router is ready; nothing is stubbed.
- Future: anything that must survive the browser dying.

### Build & install

- `native-host/main.go` — a real JSON-RPC 2.0 host over stdio: synchronous
  request handling (a reply is always flushed before the next line is read, so
  a piped EOF can't race a reply out of existence), `host.info`/`ping`/`diag`
  only. Unknown methods return a proper JSON-RPC error.
- `build.ts` and `scripts/build-dev-installers.ts` build `lazyfox-host` for
  each installer target into `installer/payload/native-host/<goos>/`, embedded
  into the installer binary (bare downloaded installers can install the full
  stack). The current-platform host also goes to `build/native-host/`.
- `installer/host_install.go` — during install: writes the host binary to a
  user-writable path (`~/.local/bin` on Unix, `%LOCALAPPDATA%\Lazyfox` on
  Windows) and the native-messaging manifest into the OS-native location
  (Linux `~/.mozilla/native-messaging-hosts/`, macOS
  `~/Library/Application Support/Mozilla/NativeMessagingHosts/`, Windows
  registry `HKCU\Software\Mozilla\NativeMessagingHosts\lazyfox`). Best-effort:
  a missing host never fails the install.
- Permission: `nativeMessaging` added to `dist/extension/manifest.json`.

### Extension usage

- `src/extension/host.ts` — a thin `browser.runtime.connectNative("lazyfox")`
  wrapper: `hostCall()` JSON-RPC round-trips, `hostInfo()` / `hostPing()` /
  `hostDiag()`, an automatic reconnect, and a `hostAvailable` flag so callers
  fall back cleanly when the host is missing (normal for AMO/store installs).
  Never throws — absence is a normal condition.
- Wired in: `background.ts` runs `probeHostOnce()` (a dev-only `host.diag`
  console line when the host is present; silence when it isn't).

## Stage 3 — remove the throwaway-tab machinery — DONE

- The per-message tab creation/removal paths in `channel.ts`, `background.ts`
  and `main.ts` (safety timeouts, `removeReqTab`, the old `#lfc=req` tab
  handler) are gone. The progress listener routes `#lfc=` payloads without
  removing anything.
- `#lfc=keys` (the test-harness key synthesizer driving a real tab) and the
  `open.` popup-open hash (a real user tab carrying a momentary hash) remain —
  deliberate real-tab channels, not throwaway churn.
- `docs/ARCHITECTURE.md` + `README.md` describe the persistent relay + native
  host picture (no more "throwaway relay tabs").

## Out of scope (explicitly)

- Replacing the helper↔background bridge with native messaging — impossible,
  the helper has no `browser.runtime` (see constraint above). The persistent
  relay is the correct fix for that direction.
- The `#lfc=` URL-hash mechanism itself (it is the sanctioned channel); only
  its throwaway-tab *implementation* went away.
