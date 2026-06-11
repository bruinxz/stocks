#!/usr/bin/env bash
# 一键 preflight：上线前必跑。
# 任一步失败即 exit 1，绝不放行。
#
# 使用：
#   # 在已设好 .env 的服务器上：
#   set -a; source /opt/stocks/shared/backend.env; set +a
#   bash scripts/preflight/run_all.sh
#
# 检查项：
#   1. weak-secret lint（源码层）
#   2. production env 校验（运行时层）
#   3. DB unique 重复 key 检查（数据库层）
#
# 任意一项失败即非 0 退出；输出明确指引。

set -uo pipefail

cd "$(dirname "$0")/../.."

step=0
fail=0

run_step() {
  step=$((step + 1))
  local title="$1"
  shift
  echo ""
  echo "=========== [$step] $title ==========="
  if "$@"; then
    echo "[$step] ✅ $title 通过"
  else
    echo "[$step] ❌ $title 失败"
    fail=1
  fi
}

# --- 1. weak-secret lint ---
run_step "弱密钥 / 弱密码 lint" bash scripts/ci/check_weak_secrets.sh

# --- 2. production env 校验 ---
if [[ ! -f backend/dist/utils/productionPreflight.js ]]; then
  echo "==========="
  echo "[$((step + 1))] ⚠️  跳过 production env 校验：backend/dist 未编译"
  echo "    先 \`cd backend && npm run build\`，再回来跑本脚本"
  echo "==========="
  fail=1
else
  run_step "production env 校验" node scripts/preflight/check_production_env.js
fi

# --- 3. DB unique 重复 key 检查 ---
if [[ -z "${DB_HOST:-}" ]]; then
  echo "==========="
  echo "[$((step + 1))] ⚠️  跳过 DB 预检：DB_HOST 未设置"
  echo "    设置 DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD 后再跑"
  echo "==========="
  fail=1
else
  run_step "DB unique 重复 key 检查" node scripts/preflight/db_unique_dup_check.js
fi

echo ""
echo "==================================================="
if [[ $fail -eq 0 ]]; then
  echo "✅ 全部 preflight 通过；可以进入上线流程 §2"
  exit 0
else
  echo "❌ preflight 失败；先修复上面的问题再上线"
  echo "   详见 docs/live_trading_launch_checklist.md"
  exit 1
fi
