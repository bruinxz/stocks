#!/usr/bin/env bash
# 实盘 audit event_type 枚举化 lint。
#
# 上线 launch-helper：所有 LiveExecutionAuditLog.create 的 event_type 必须引枚举，
# 禁止散落字面量 'live_xxx'，避免 typo 让监控/告警/对账规则失效。
#
# 命中即 exit 1。运行：
#   bash scripts/ci/check_audit_events.sh

set -uo pipefail
cd "$(dirname "$0")/../.."

PATTERN='event_type:\s*['"'"'"]live_[a-z_]+['"'"'"]'

# 允许的引用位置：枚举文件本身 + 各种 test 文件
hits=$(grep -rEn "$PATTERN" backend/src --include="*.ts" 2>/dev/null \
  | grep -v 'auditEvents\.ts' \
  | grep -v '\.test\.ts')

if [[ -n "$hits" ]]; then
  echo "==========================================="
  echo "❌ live audit event_type 应改用枚举"
  echo "==========================================="
  echo "$hits"
  echo ""
  echo "fix：把硬编码字面量改成 LIVE_AUDIT_EVENT_TYPES.XXX；"
  echo "      枚举定义在 backend/src/live-trading/auditEvents.ts"
  exit 1
fi
echo "✅ live audit event_type 已全部枚举化"
