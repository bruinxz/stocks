#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ROOT"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" && -x /opt/homebrew/bin/node ]]; then
  NODE_BIN=/opt/homebrew/bin/node
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "[secret-lint] node runtime is required; refusing a false-green scan" >&2
  exit 2
fi

exec "$NODE_BIN" scripts/ci/check_weak_secrets.js
