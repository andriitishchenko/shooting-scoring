#!/bin/bash
# Production start script. It runs the Node.js server as one process.
# The environment sets IP (listen address), PORT, and optionally DATA_DIR.

# Strict mode
set -e

BASE_DIR="/home/workouts/archery/www"
APP_DIR="$BASE_DIR/backend-node"

cd "$APP_DIR" || exit 1

# Install the dependencies when they are missing.
if [ ! -d node_modules/ws ]; then
    npm ci --omit=dev --no-fund --no-audit
fi

export HOST="${IP:-0.0.0.0}"
export PORT="${PORT:-8000}"
export DATA_DIR="${DATA_DIR:-$BASE_DIR/data}"

# One process only. The server refuses a second process on the same data directory.
exec node src/server.js
