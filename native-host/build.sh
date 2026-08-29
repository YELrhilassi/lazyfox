#!/usr/bin/env bash
# Build script for lazyfox-host native messaging host

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_DIR="${ROOT_DIR}/native-host"
BUILD_DIR="${ROOT_DIR}/build/native-host"

echo "Building lazyfox-host..."

cd "${HOST_DIR}"

# Download dependencies
echo "Downloading Go dependencies..."
go mod tidy

# Build
echo "Compiling..."
mkdir -p "${BUILD_DIR}"
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "${BUILD_DIR}/lazyfox-host" .

# Copy manifest
mkdir -p "${BUILD_DIR}"
cp lazyfox.json "${BUILD_DIR}/"

echo "Build complete: ${BUILD_DIR}/lazyfox-host"
echo "Manifest: ${BUILD_DIR}/lazyfox.json"

# Show binary info
ls -lh "${BUILD_DIR}/lazyfox-host"