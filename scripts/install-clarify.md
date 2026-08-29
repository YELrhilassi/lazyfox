# Lazyfox Install Clarification

## Two Installation Methods

### 1. Sideload Install (Recommended for Developers)
- **What**: Install the extension by loading the .xpi file directly
- **How**: Run `./scripts/install-dev.sh` or use Firefox's about:addons → "Install Add-on From File"
- **Requirements**: 
  - Firefox browser (Nightly/Developer Edition recommended)
  - The .xpi file (built with `npm run build`)
- **When to use**: Development, testing, custom builds

### 2. Add-on Store Install
- **What**: Install from Mozilla Add-on Store (AMO)
- **How**: Search for "Lazyfox" in Firefox add-ons page
- **Requirements**: 
  - Extension must be reviewed and signed by Mozilla
  - Currently: 0.5.2 is signed and listed on AMO; 0.5.3 is pending review
- **When to use**: Stable production use, when you want officially reviewed extension

## Current Status (v0.5.3)

| Method | Status | Version |
|--------|--------|---------|
| Sideload (this method) | ✅ Working | 0.5.3 (unsigned, pending AMO review) |
| Add-on Store | 🟡 Pending review | 0.5.2 (signed), 0.5.3 (unsigned) |

## Recommendation

**For developers/testing**: Use sideload method (this is the default with `npm run build`)

**For production/stable use**: Wait for 0.5.3 to be reviewed on AMO, or use 0.5.2 which is already signed

## Quick Start - easiest path

1. Run `./scripts/install-dev.sh` - auto-detects Firefox and installs
2. Or manually: Open Firefox → about:addons → click gear → "Install Add-on From File" → select `dist/lazyfox2-0.5.3.xpi`
3. Verify: Click the Lazyfox icon, try ;I (setup), ;S (search), ;N (leader)

The sideload install gives you the latest features, while the store version gives you officially reviewed software.
