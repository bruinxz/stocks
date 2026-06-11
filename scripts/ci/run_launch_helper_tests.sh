#!/usr/bin/env bash
# 跑本轮新增模块的所有单测。
#   bash scripts/ci/run_launch_helper_tests.sh
#
# 不依赖 jest/pytest；只用 ts-node + python3。

set -uo pipefail
cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"

fail=0
section() { echo ""; echo "=========== $* ==========="; }
done_step() {
  if [[ $1 -eq 0 ]]; then
    echo "[ok] $2"
  else
    echo "[FAIL] $2"
    fail=1
  fi
}

# ---- TS 单测：node 通过 ts-node 跑（--transpile-only 跳过类型检查；tsc --noEmit 已另行覆盖） ----
section "TS: productionPreflight"
( cd "$REPO_ROOT/backend" && npx ts-node --transpile-only src/utils/productionPreflight.test.ts )
done_step $? "productionPreflight"

section "TS: liveTradingRateLimit"
( cd "$REPO_ROOT/backend" && npx ts-node --transpile-only src/live-trading/middlewares/liveTradingRateLimit.test.ts )
done_step $? "liveTradingRateLimit"

section "TS: LiveAuditAlertService"
( cd "$REPO_ROOT/backend" && npx ts-node --transpile-only src/live-trading/services/LiveAuditAlertService.test.ts )
done_step $? "LiveAuditAlertService"

# ---- Python 单测 ----
section "Python: QmtAdapter"
( cd "$REPO_ROOT/integrations/broker-bridge" && python3 -m qmt_bridge.test_qmt_adapter )
done_step $? "QmtAdapter"

if [[ $fail -eq 0 ]]; then
  echo ""
  echo "✅ launch-helper 单测全部通过"
  exit 0
fi
echo ""
echo "❌ launch-helper 单测有失败，详见上方"
exit 1
