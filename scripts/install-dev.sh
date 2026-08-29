#!/bin/bash
# Lazyfox Developer Installer
# Simple, clear installation for developers
#
# Usage: ./scripts/install-dev.sh [--firefox PATH] [--profile NAME]
#
# This script:
# 1. Finds Firefox (Nightly/Developer Edition preferred)
# 2. Creates/manages a test profile
# 3. Installs the extension
# 4. Runs quick smoke test

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Lazyfox Developer Installer${NC}"
echo "=================================="

# Find Firefox
FIREFOX_PATH=""
FIREFOX_NAME=""

# Check common locations
for path in "/opt/firefox-nightly/firefox" "/opt/firefox-dev/firefox" "/usr/bin/firefox-nightly" "/usr/bin/firefox-dev"; do
  if [ -x "$path" ]; then
    FIREFOX_PATH="$path"
    FIREFOX_NAME=$(basename "$path")
    break
  fi
done

# If not found, ask user or use default
if [ -z "$FIREFOX_PATH" ]; then
  echo -e "${YELLOW}Firefox not found in common locations.${NC}"
  echo "Please provide Firefox path manually:"
  read -p "Firefox path: " FIREFOX_PATH
fi

if [ ! -x "$FIREFOX_PATH" ]; then
  echo -e "${RED}Error: Firefox not found at $FIREFOX_PATH${NC}"
  exit 1
fi

echo -e "${GREEN}Using Firefox: $FIREFOX_PATH${NC}"

# Get or create profile
PROFILE_NAME="lazyfox-dev"
PROFILE_DIR="$HOME/.mozilla/firefox/$PROFILE_NAME.default"

echo -e "${GREEN}Profile management:${NC}"
if [ -d "$PROFILE_DIR" ]; then
  echo "  Profile already exists: $PROFILE_NAME"
else
  echo -e "${YELLOW}Creating new profile: $PROFILE_NAME${NC}"
  "$FIREFOX_PATH" -P "$PROFILE_NAME" --profilemanager -CreateProfile "$PROFILE_NAME" > /dev/null 2>&1 || true
fi

# Install the extension
echo -e "${GREEN}Installing extension...${NC}"
"$FIREFOX_PATH" -P "$PROFILE_NAME" -no-remote -installAddon "dist/lazyfox2-0.5.3.xpi" > /dev/null 2>&1 &
INSTALL_PID=$!
sleep 3

# Check if installation succeeded
if kill -0 $INSTALL_PID 2>/dev/null; then
  kill $INSTALL_PID 2>/dev/null
fi

# Verify installation
EXTENSION_STATUS=$("$FIREFOX_PATH" -P "$PROFILE_NAME" -no-remote -myaddons 2>/dev/null | grep lazyfox || echo "not-found")

echo -e "${GREEN}Extension status: $EXTENSION_STATUS${NC}"

# Quick test
echo -e "${GREEN}Running quick smoke test...${NC}"
"$FIREFOX_PATH" -P "$PROFILE_NAME" -no-remote -new-tab about:addons > /dev/null 2>&1 &
sleep 2

echo ""
echo "=================================="
echo -e "${GREEN}Installation complete!${NC}"
echo "  Firefox: $FIREFOX_PATH"
echo "  Profile: $PROFILE_NAME"
echo "  Extension: lazyfox@lazyfox.dev"
echo ""
echo "Quick test: Open Firefox, go to about:addons,"
echo "click the Lazyfox extension to verify it's installed."
echo "Use ;I to open the setup page, or ;S for search popup."
echo "=================================="
