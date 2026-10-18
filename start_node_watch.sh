#!/usr/bin/env bash
# Start the Node.js server for development. The server restarts when a file in
# backend-node/src changes. The server reads the files in frontend again within
# one second, so reload the browser page to see a change there.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR/backend-node"
if [ ! -d node_modules/ws ]; then
    npm ci --no-fund --no-audit
fi
exec npm run dev --silent
