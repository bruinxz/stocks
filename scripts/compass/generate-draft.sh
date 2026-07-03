#!/usr/bin/env bash
#
# scripts/compass/generate-draft.sh — 战略镜子月度 draft 生成器 (§8 战略镜子 "UI")
#
# 大白话: 这就是战略镜子的 "UI" —— 不是一个花哨的网页, 而是一个每月跑一次的生成器。
#   §8.1 铁律: **AI 只填客观数据 (层 1/2), 主观归因 (层 3) 与决定 (层 4) 必须人手写签字**。
#   所以本脚本做且只做一件事: 跑 monthly_metrics.sql 取当月客观数据, 把数据快照嵌进
#   docs/compass/YYYY-MM.md 的顶部, 模板正文 (6 题 4 层) 原样拷下来留白给人手填。
#   人打开这个文件, 对着数据快照填层 3/4 即可 —— 数据不用手抄, 归因不能偷懒。
#
# 用途:
#   bash scripts/compass/generate-draft.sh              # 生成当前自然月 draft
#   bash scripts/compass/generate-draft.sh 2026-07      # 生成指定月 draft
#
# 环境变量 (缺失回退 backend/.env 默认):
#   DB_HOST 默认 127.0.0.1 · DB_PORT 默认 5432
#   DB_NAME 默认 stock_backtest · DB_USER 默认 stock_admin · DB_PASSWORD (PGPASSWORD 传入)
#
# 产物: docs/compass/YYYY-MM.md
#   - 已存在则不覆盖 (保护已手填的归因/签字), 提示用 --force 覆盖数据快照段。
#
# 注意: 生成的文件只是 draft —— 层 3 归因至少手写 1 条 + 层 4 决定签字, 否则 §8.3 判定机制退化。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ---------- 参数 ----------
FORCE=0
MONTH=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]) MONTH="$arg" ;;
    *) echo "未知参数: $arg (用法: generate-draft.sh [YYYY-MM] [--force])" >&2; exit 2 ;;
  esac
done
[ -z "$MONTH" ] && MONTH="$(date +%Y-%m)"

# ---------- DB 配置 ----------
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-stock_backtest}"
DB_USER="${DB_USER:-stock_admin}"
export PGPASSWORD="${DB_PASSWORD:-${PGPASSWORD:-}}"

SQL_FILE="$SCRIPT_DIR/monthly_metrics.sql"
TEMPLATE="$REPO_ROOT/docs/PROJECT_COMPASS.md"
OUT_DIR="$REPO_ROOT/docs/compass"
OUT_FILE="$OUT_DIR/$MONTH.md"

[ -f "$SQL_FILE" ] || { echo "缺少 SQL: $SQL_FILE" >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "缺少模板: $TEMPLATE" >&2; exit 1; }

mkdir -p "$OUT_DIR"

if [ -f "$OUT_FILE" ] && [ "$FORCE" -ne 1 ]; then
  echo "已存在 $OUT_FILE — 保护已手填内容, 不覆盖。" >&2
  echo "如需刷新数据快照, 加 --force (会重写整个文件, 覆盖手填部分, 请先备份)。" >&2
  exit 3
fi

# ---------- 跑 SQL 取客观数据 ----------
echo "→ 跑 monthly_metrics.sql (月=$MONTH, db=$DB_NAME@$DB_HOST:$DB_PORT) ..." >&2
METRICS="$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -v month="'$MONTH'" -f "$SQL_FILE" 2>&1)" || {
  echo "psql 取数失败 —— 检查 DB 连接 / 环境变量。原始输出:" >&2
  echo "$METRICS" >&2
  exit 1
}

GENERATED_AT="$(date '+%Y-%m-%d %H:%M:%S %z')"

# ---------- 写 draft (数据快照段 + 模板正文) ----------
{
  echo "# 战略镜子 · $MONTH"
  echo
  echo "> **本文件是自动生成的 draft** (由 \`scripts/compass/generate-draft.sh\` 生成于 $GENERATED_AT)。"
  echo "> §8.1 铁律: 下面的\"客观数据快照\"是 AI 填的层 1/2 素材; **层 3 归因至少手写 1 条 + 层 4 决定签字必须人手填**,"
  echo "> 否则 §8.3 判定机制退化 (你在应付)。填完把 draft 提醒去掉即可。"
  echo
  echo "---"
  echo
  echo "## 客观数据快照 (层 1/2 素材 · 目标月 $MONTH)"
  echo
  echo '```text'
  echo "$METRICS"
  echo '```'
  echo
  echo "> 对着上面数据填下面 6 题的层 1 现状 / 层 2 评估; 层 3/4 手写。"
  echo
  echo "---"
  echo
  awk 'f{print} /^## 每题固定 4 层/{f=1; print}' "$TEMPLATE"
} > "$OUT_FILE"

echo "✅ 已生成 draft: $OUT_FILE" >&2
echo "   下一步: 打开填层 3 归因 (至少手写 1 条) + 层 4 决定签字。" >&2
