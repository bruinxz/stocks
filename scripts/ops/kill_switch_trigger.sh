#!/usr/bin/env bash
# 一键触发服务端 kill switch。
# 上线 launch-helper §4.1 立即止血选项 A 的脚本化实现：前端 admin 来不及登录时直接在服务器上调 API。
#
# 用法：
#   KILL_SWITCH_TOKEN=<admin-jwt> ./scripts/ops/kill_switch_trigger.sh \
#     [reason_detail] [reason_code] [base_url]
#
# 环境变量：
#   KILL_SWITCH_TOKEN   admin 用户 JWT（必填；从 admin 浏览器 cookie 或 /api/auth/login 取）
#   KILL_SWITCH_URL     可覆盖 base_url，默认 http://127.0.0.1:3000
#
# 参数：
#   $1 reason_detail   触发原因详细说明（必填）
#   $2 reason_code     原因码（默认 manual）
#   $3 base_url        显式覆盖 base url
#
# 退出码：0 成功 / 1 参数错 / 2 API 错

set -euo pipefail

REASON_DETAIL="${1:-}"
REASON_CODE="${2:-manual}"
BASE_URL="${3:-${KILL_SWITCH_URL:-http://127.0.0.1:3000}}"

if [[ -z "$REASON_DETAIL" ]]; then
  echo "usage: KILL_SWITCH_TOKEN=<jwt> $0 <reason_detail> [reason_code] [base_url]" >&2
  exit 1
fi

if [[ -z "${KILL_SWITCH_TOKEN:-}" ]]; then
  echo "error: KILL_SWITCH_TOKEN env var required (admin JWT)" >&2
  exit 1
fi

echo "[kill-switch] base=$BASE_URL code=$REASON_CODE"
echo "[kill-switch] detail=$REASON_DETAIL"

response=$(curl --silent --show-error --fail-with-body \
  --max-time 10 \
  -X POST "${BASE_URL}/api/live-trading/kill-switch/trigger" \
  -H "Authorization: Bearer ${KILL_SWITCH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(cat <<JSON
{
  "reason_code": "$REASON_CODE",
  "reason_detail": "$REASON_DETAIL"
}
JSON
)") || {
  echo "[kill-switch] HTTP 调用失败: $response" >&2
  exit 2
}

echo "[kill-switch] response: $response"
echo "[kill-switch] 已触发。bridge 长轮询会立即收到 204/SSE 'kill_switch' 事件断连。"
echo "[kill-switch] 同时建议在 bridge 机执行：touch <local_kill_switch_file>"
