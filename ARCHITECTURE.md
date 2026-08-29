# Lazyfox Architecture Analysis & Anti-patterns Audit

## Executive Summary

The current codebase has **fundamental architectural flaws** that make it fragile, hard to maintain, and incompatible with proper Firefox extension practices. The core issue is a **hacked communication layer** between the chrome-privileged helper and the WebExtension that should be replaced with proper APIs.

---

## 1. Critical Anti-pattern: `#lfc=` URL Hash Channel

### Location
- `src/chrome/channel.ts` (725 lines) — the central router
- `src/chrome/main.ts` — progress listener, alive announcer
- `src/chrome/ops.ts` — all chrome operations relayed through it
- `src/chrome/splitview.ts` — split/unsplit/moveTab relays
- `src/chrome/debug.ts` — dev commands
- `src/chrome/config.ts` — config sync
- Extension side: `background.ts`, `commandcenter.ts`, `content/main.ts`, `sessions.ts`

### How It Works (The Hack)
```
Chrome Helper (privileged)                    WebExtension (background)
     │                                           │
     ├── Creates transient tab:                  │
     │   gBrowser.addTab(                        │
     │     "moz-extension://.../commandcenter.html#lfc=req.action.arg"
     │   )                                       │
     │                                           ├── Detects #lfc= hash on load
     │                                           ├── Parses action + arg
     │                                           ├── Executes logic
     │                                           ├── Navigates tab to #lfc=reply.ok.nonce
     │                                           │
     │   Progress listener catches reply         │
     │   Resolves promise / dispatches callback  │
```

### Why It's Broken
1. **Tab flashing** — Even "background" tabs flash visibly (fixed partially with persistent tab, but still creates tab objects)
2. **Timing-dependent** — Race conditions between tab creation, load, hash parsing, reply
3. **Fragile** — Firefox updates break it (Beta vs Nightly context ID churn)
4. **Not testable** — Requires full Firefox instance, can't unit test
5. **Wrong API** — WebExtensions provide `browser.runtime.sendMessage` / `onMessage` for exactly this
6. **Security** — Uses `triggeringPrincipal: SystemPrincipal` to bypass CSP

### Files to Remove/Replace
- `src/chrome/channel.ts` — ENTIRE FILE (725 lines)
- `src/chrome/debug.ts` — Most of it (lfc= handlers)
- `src/chrome/main.ts` — Progress listener, alive announcer
- `src/chrome/ops.ts` — All `requestBg`, `requestSessionState` calls
- `src/chrome/splitview.ts` — `#lfc=` relay handlers
- `src/chrome/config.ts` — `#lfc=cfg` handler
- Extension: `background.ts` message listener for `lfc=` actions

---

## 2. Chrome Helper Architecture (Wrong Privilege Model)

### Current Structure
```
fx-autoconfig loader (userChrome.uc.js)
    │
    ├── Loads `userChrome.uc.js` (4000+ lines)
    │   ├── Key capture (capture-phase keydown listener)
    │   ├── Leader key dispatch
    │   ├── Popup rendering (DOM in chrome document)
    │   ├── Split view management
    │   ├── Status bar rendering
    │   ├── Session management
    │   └── #lfc= channel router
    │
    └── Uses privileged APIs:
        ├── Services.scriptSecurityManager.getSystemPrincipal()
        ├── Services.prefs.* (string/bool prefs)
        ├── Services.console.logStringMessage()
        ├── Cu.Sandbox (for WASM core)
        ├── gBrowser (tab management)
        └── window (chrome window)
```

### Problems
1. **Monolithic** — 4000+ lines in one file, no separation of concerns
2. **Over-privileged** — Everything runs with SystemPrincipal
3. **Can't use WebExtension APIs** — Not a WebExtension context
4. **Not portable** — Firefox-specific chrome APIs
5. **Hard to test** — Requires full Firefox chrome process

### Proper Model: Native Messaging Host
```
┌─────────────────────────────────────────────────────────────┐
│  WebExtension (content script, background, popups)         │
│  - Pure JS/TS, standard WebExtension APIs                  │
│  - Communicates via: browser.runtime.sendNativeMessage()   │
└──────────────────────────┬──────────────────────────────────┘
                           │ stdio JSON-RPC
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Native Host (Go binary)                                    │
│  - Runs with user permissions (not SystemPrincipal)        │
│  - Talks to Firefox via:                                   │
│     ├── Native messaging (already allowed)                 │
│     ├── Firefox DevTools Protocol (CDP) for key capture    │
│     ├── xdotool/ydotool for synthetic input (Linux)        │
│     ├── dbus for system integration                        │
│  - Manages: sessions, prefs, key state, UI injection       │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Other Anti-patterns

### Global State Mutations
- `ops.ts` — `chromeOps` singleton with 50+ methods mutating shared state
- `statusbar.ts` — Global status bar controller
- `splitview.ts` — Global split view manager
- `popup.ts` — Global `currentPopup` slot

### Direct DOM Manipulation in Privileged Context
- `popup.ts` — Creates DOM in chrome document via `document.implementation.createHTMLDocument`
- `channel.ts` — Direct `contentWindow.location.href` manipulation
- `main.ts` — Direct `gBrowser` manipulation

### No Separation of Concerns
- Key handling, popups, splits, sessions, status bar all intertwined
- No clear boundaries between "chrome-privileged" and "extension logic"

---

## 4. Workflow Anti-patterns

### Version Management
- Manual version bumping in 4 files (`package.json`, `package-lock.json`, `manifest.json`, `dist/extension/manifest.json`)
- No automated version derivation from git tags

### Signed XPI Handling
- AMO signing is manual (`npm run build` submits to AMO)
- Test fails when AMO hasn't signed yet (current state: 0.5.3 pending review)
- No fallback strategy in CI

### Branch Strategy
- No protected branches
- No dev/stable separation
- Feature work on `feat/*` branches directly
- No PR → review → merge to master pipeline

---

## 5. Proposed Fixes

### Phase 1: Architecture Redesign (High Priority)
1. **Design native messaging host** (Go) to replace `#lfc=` channel
2. **Implement native host** with:
   - `key_capture` — global key listener via `ydotool`/`xdotool` or CDP
   - `ui_inject` — inject popups, status bar, split views via content scripts
   - `prefs` — manage user preferences
   - `sessions` — session persistence
   - `keys` — leader key state machine
3. **Migrate extension** to use `browser.runtime.sendNativeMessage`
4. **Remove all `#lfc=` code** (channel.ts, debug.ts, main.ts progress listener, ops.ts relays)

### Phase 2: Chrome Helper Slim-down
1. Keep only UI injection (userChrome.css, userChrome.uc.js minimal)
2. Move all logic to native host or extension
2. Eventually: eliminate chrome helper entirely, use content script injection

### Phase 3: Proper Release Workflow
1. **Git branches**:
   - `master` — stable, signed xpi only, protected
   - `dev-*` — feature branches, unsigned xpi, test on Nightly
2. **CI/CD** (GitHub Actions):
   - Dev branches: build unsigned, test on Firefox Nightly
   - Master: build → submit to AMO → wait for sign → download signed → rebuild → GitHub Release
3. **Version automation**: Derive from git tags, single source of truth
4. **Automated AMO signing**: CI handles submission, polling, download, re-embed

---

## 5. Implementation Order

| Priority | Task | Effort | Risk |
|----------|------|--------|------|
| 1 | Document current message protocol (all `#lfc=` actions) | 1 day | Low |
| 2 | Design native host JSON-RPC protocol | 1 day | Low |
| 3 | Implement native host skeleton (Go) | 2 days | Medium |
| 3 | Implement `key_capture` module | 3 days | High |
| 3 | Implement `ui_inject` module | 2 days | Medium |
| 4 | Migrate extension background to native messaging | 2 days | Medium |
| 5 | Remove all `#lfc=` channel code | 2 days | Medium |
| 6 | Set up GitHub Actions CI/CD | 1 day | Low |
| 7 | Configure branch protection + workflow | 1 day | Low |

**Total: ~14 days for proper rewrite**

---

## 6. Quick Wins (Can Do Now)

1. **Add `.github/workflows/`** for CI
2. **Branch protection rules** on master
3. **Version derivation** from git tags in `build.mjs`
4. **Automate AMO submission** in CI (already have `amo-sign.mjs`)
5. **Test matrix**: Nightly for dev, Release for master

---

## Conclusion

The `#lfc=` channel is the **root cause** of most bugs (tab flashing, Beta vs Nightly failures, untestability). The chrome helper's monolithic privileged architecture is the **second root cause**. 

**Recommendation**: Invest 2-3 weeks in a proper native messaging host rewrite. This will:
- Eliminate the entire class of communication bugs
- Make the codebase testable and maintainable
- Enable proper CI/CD with automated signing
- Work on stable Firefox without hacks

The current "fixes" (persistent tab, probe refresh) are band-aids on a broken architecture.
---

## 8. Development Workflow: From Feature to Production

### Branch Strategy

This project uses a **two-branch strategy** to separate development from production:

```
master                          dev-nightly
  │                                   │
  │   ✅ Signed releases only         │   ✅ Dev builds for Nightly testing
  │   ✅ AMO-reviewed & signed        │   ✅ Unsigned, feature-complete
  │   ✅ Production-ready code        │   ✅ All fixes merged from features
  │   ✅ Git tag v0.5.3 etc.          │   ✅ CI runs BiDi tests on Nightly
  │   ✅ Installer binaries + signed  │
  │     xpi                          │
  └─────────────────────────────────┘  └─────────────────────────────────┘
         ▲                                   ▲
         │                                   │
         └────── feature/* branches ──────┘
                (merged into dev-nightly)
```

### Workflow Steps

#### 1. Development (Feature Branch)
```bash
# Start on master, create feature branch
git checkout master
git pull origin master
git checkout -b feat/some-feature

# Make changes, test locally
npm run build:dev    # Dev build
npm test             # Core tests

# Commit and push
git commit -m "feat: add some feature"
git push origin feat/some-feature

# Merge to dev-nightly for testing
git checkout dev-nightly
git merge --no-ff feat/some-feature
git push origin dev-nightly
# CI automatically runs BiDi tests on Firefox Nightly
```

#### 2. Promotion to Production
```bash
# Ensure dev-nightly is stable
git checkout dev-nightly
npm test             # All tests pass

# Promote to master
git checkout master
git merge --no-ff dev-nightly
git push origin master
# CI triggers:
#   - Prod build (npm run build)
#   - npm test (core + installer + check-dist)
#   - AMO submission (requires AMO_API_TOKEN)
#   - GitHub Release creation
```

#### 3. Release
- GitHub Release v0.x.x published
- 3 platform installers + signed xpi + source zip
- Marked as "Latest"
- Users on stable Firefox upgrade automatically

### Branch Lifecycle

| Branch | Purpose | Who Works On It | What It Contains |
|--------|---------|-----------------|------------------|
| `master` | Production releases | Maintainers/CI | Signed, AMO-reviewed code + installer binaries |
| `dev-nightly` | Development testing | All developers | Unsigned builds, all features merged, CI-tests |
| `feat/*` | Feature development | Individual developers | Work-in-progress, not yet tested on Nightly |

### Removing Old Branches

After merging, remove feature branches to keep the repo clean:
```bash
# After merging feat/* to dev-nightly
git branch -d feat/some-feature

# Remove remote tracking
git push origin --delete feat/some-feature
```

### Current Branch State

After this session, the repo should have ONLY:
- `master` - signed releases
- `dev-nightly` - development code (merged from all features)

All other feature branches should be deleted.

### CI/CD Pipelines

**.github/workflows/dev-nightly.yml**
- Triggers on `push`/`pull_request` to `dev-nightly`
- Builds dev extension (`npm run build:dev`)
- Auto-detects Firefox Nightly/Developer Edition
- Installs extension on test profile
- Runs BiDi test suite (`scripts/bidi/test.mjs`)
- Uploads test results artifact

**.github/workflows/master.yml**
- Triggers on `push`/`pull_request` to `master`
- Builds prod extension (`npm run build`)
- Runs `npm test` (core + installer + check-dist)
- Submits to AMO (requires `AMO_API_TOKEN` secret)
- Waits for AMO review (external process)
- Creates GitHub Release v0.x.x
- Uploads 3 platform installers + signed xpi + source zip

### Quick Reference Commands

```bash
# Start new feature
git checkout master
git pull origin master
git checkout -b feat/awesome-feature

# Develop locally
npm run build:dev
npm test              # Core tests only
# ... make changes ...
git add .
git commit -m "feat: add awesome feature"
git push origin feat/awesome-feature

# Merge to dev-nightly for testing
git checkout dev-nightly
git merge --no-ff feat/awesome-feature
git push origin dev-nightly
# CI runs automatically - check results

# Promote to production
git checkout master
git merge --no-ff dev-nightly
git push origin master
# CI triggers - builds, signs, releases

# Clean up feature branch
git branch -d feat/awesome-feature
git push origin --delete feat/awesome-feature
```
