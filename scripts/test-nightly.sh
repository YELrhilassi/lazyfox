#!/bin/bash
# Automatic Firefox test runner
# Finds available Firefox and runs the BiDi test suite

set -e

# Find available Firefox (priority: Nightly > Developer Edition > regular)
Nightly_PATHs=(
  "/opt/firefox-nightly/firefox"
  "/opt/firefox-dev/firefox"
  "/usr/bin/firefox-nightly"
  "/usr/bin/firefox-dev"
)

Nightly_PATH=""
for path in "${Nightly_PATHs[@]}"; do
  if [ -x "$path" ]; then
    Nightly_PATH="$path"
    echo "Found Firefox at: $path"
    # Check if it's Nightly or Dev Edition
  fi
done

if [ -z "$Nightly_PATH" ]; then
  # Try to find via which if in PATH
  if command -v firefox &>/dev/null; then
    Nightly_PATH=$(which firefox)
    echo "Found Firefox via PATH: $Nightly_PATH"
  else
    echo "ERROR: Firefox not found"
    exit 1
  fi
fi

# Determine if this is a dev/nightly version based on version string
IS_NIGHTLY=false
if echo "$Nightly_PATH" | grep -q "nightly\|Nightly\|dev\|Dev"; then
  IS_NIGHTLY=true
fi

# Build the unsigned dev extension (fast; no AMO).
echo "Building extension..."
cd /home/bliss/Projects/lazyfox
npm run build > /dev/null 2>&1

# Derive the version from the manifest (never hardcode it here).
VERSION=$(node -p "require('./dist/extension/manifest.json').version")
XPI="dist/lazyfox2-${VERSION}.xpi"

echo "Installing extension (${XPI})..."
rm -rf "$HOME/.lazyfox-test-profile"
# Install the unsigned xpi into a scratch profile.
"$Nightly_PATH" -P "lazyfox-test" --profilemanager > /dev/null 2>&1 || true
"$Nightly_PATH" -P "lazyfox-test" -no-remote -installAddon "$XPI" &>/dev/null &
sleep 3

# Run the BiDi test suite
echo "Running BiDi test suite..."
export FIREFOX_BIN="$Nightly_PATH"
export GECKODRIVER=".tools/geckodriver"
timeout 300 node scripts/bidi/test.mjs

TEST_EXIT=$?

# Cleanup and report
if [ $TEST_EXIT -ne 0 ]; then
  echo "Some tests failed - exit code: $TEST_EXIT"
  exit 1
fi

echo "Tests completed successfully!"
exit 0
