#!/usr/bin/env bash
# 一键解除服务端 kill switch。
#
# 用法：
#   KILL_SWITCH_TOKEN=<admin-jwt> ./scripts/ops/kill_switch_resolve.sh [note] [base_url]
#
# 环境变量：
#   KILL_SWITCH_TOKEN   admin JWT（必填）
#   KILL_SWITCH_URL     可覆盖 base_url，默认 http://127.0.0.1:3000

set -euo pipefail

NOTE="${1:-resolved via ops script}"
BASE_URL="${2:-${KILL_SWITCH_URL:-http://127.0.0.1:3000}}"

if [[ -z "${KILL_SWITCH_TOKEN:-}" ]]; then
  echo "error: KILL_SWITCH_TOKEN env var required (admin JWT)" >&2
  exit 1
fi

echo "[kill-switch] resolving via $BASE_URL"

response=$(curl --silent --show-error --fail-with-body \
  --max-time 10 \
  -X POST "${BASE_URL}/api/live-trading/kill-switch/resolve" \
  -H "Authorization: Bearer ${KILL_SWITCH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(cat <<JSON
{ "note": "$NOTE" }
JSON
)") || {
  echo "[kill-switch] HTTP 调用失败: $response" >&2
  exit 2
}

echo "[kill-switch] response: $response"
echo "[kill-switch] 已解除。如 bridge 机仍有 local KILL_SWITCH_ON 文件，请同步删除。"
