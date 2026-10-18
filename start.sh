#!/usr/bin/env bash
# Quick start. It checks Node.js, installs the dependencies, and starts the server.
set -euo pipefail

echo "Shooting Scoring System - quick start"
echo "====================================="

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is not installed. Install Node.js 24 or later from https://nodejs.org" >&2
    exit 1
fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 24 ]; then
    echo "Node.js $(node -v) is too old. Install Node.js 24 or later." >&2
    exit 1
fi

exec "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/start_node.sh"
