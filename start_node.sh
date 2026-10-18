#!/usr/bin/env bash
# Start the Node.js server. Use `./start_node.sh`. Set HOST, PORT, and DATA_DIR
# in the environment or in backend-node/.env to change the defaults.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR/backend-node"
if [ ! -d node_modules/ws ]; then
    npm ci --no-fund --no-audit
fi
exec node src/server.js
