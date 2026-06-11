#!/usr/bin/env bash
# 查询 kill switch 当前状态（任何登录用户都能查；admin 与普通用户都行）。
#
# 用法：
#   KILL_SWITCH_TOKEN=<jwt> ./scripts/ops/kill_switch_status.sh [base_url]

set -euo pipefail

BASE_URL="${1:-${KILL_SWITCH_URL:-http://127.0.0.1:3000}}"

if [[ -z "${KILL_SWITCH_TOKEN:-}" ]]; then
  echo "error: KILL_SWITCH_TOKEN env var required (any logged-in user JWT)" >&2
  exit 1
fi

curl --silent --show-error --fail-with-body \
  --max-time 10 \
  -X GET "${BASE_URL}/api/live-trading/kill-switch" \
  -H "Authorization: Bearer ${KILL_SWITCH_TOKEN}" | tee /dev/stderr | python3 -m json.tool 2>/dev/null || true
