#!/usr/bin/env bash
# Deploy only the xz sandbox (3020/3021). Does not touch main or lym.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export DEPLOY_TARGETS=xz
export RELEASE_TARGETS=xz
exec node "$ROOT/scripts/deployment/deploy_release_package.js" "$@"
