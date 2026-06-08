#!/usr/bin/env bash
#
# scripts/restore-db.sh — US-071 数据库恢复脚本
#
# 功能:
#   1. 根据 --date=YYYY-MM-DD (或 --file=<path>) 找到 backups/ 下的 .sql.gz
#   2. gunzip 解压后用 psql 灌回 PostgreSQL
#   3. 默认要求二次确认 (--yes 可跳过), 因为 restore 会覆盖目标库内容
#
# 环境变量 (优先读取, 缺失时回退默认值):
#   DB_HOST     默认 localhost
#   DB_PORT     默认 5432
#   DB_NAME     默认 stock_backtest
#   DB_USER     默认 postgres
#   DB_PASSWORD 默认 postgres  (通过 PGPASSWORD 传给 psql)
#   BACKUP_DIR  默认 <repo-root>/backups
#
# 参数 (互斥):
#   --date=YYYY-MM-DD   从 backups/YYYY-MM-DD.sql.gz 恢复
#   --file=<abs-path>   从指定路径恢复 (跳过 BACKUP_DIR 查找)
#
# 选项:
#   --yes               跳过 "are you sure?" 二次确认 (用于自动化)
#   --target-db=<name>  覆盖 DB_NAME (一次性, 不污染 env)
#   --drop-create       restore 前先 DROP DATABASE + CREATE DATABASE (清空再恢复)
#                       默认 false (恢复到现有库, 表数据由 dump 内的 DROP/CREATE 处理)
#
# 使用:
#   bash scripts/restore-db.sh --date=2026-06-06
#   bash scripts/restore-db.sh --date=2026-06-06 --yes
#   bash scripts/restore-db.sh --file=/tmp/snapshot.sql.gz --target-db=stock_backtest_test --yes
#   npm run db:restore -- --date=2026-06-06

set -euo pipefail

# ---------- 默认配置 ----------
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-stock_backtest}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"

# ---------- 解析参数 ----------
RESTORE_DATE=""
RESTORE_FILE=""
SKIP_CONFIRM="false"
TARGET_DB=""
DROP_CREATE="false"

print_usage() {
  cat <<EOF
Usage: $0 [--date=YYYY-MM-DD | --file=<path>] [--yes] [--target-db=<name>] [--drop-create]

Examples:
  $0 --date=2026-06-06
  $0 --date=2026-06-06 --yes
  $0 --file=/tmp/snapshot.sql.gz --target-db=stock_backtest_test --yes
  npm run db:restore -- --date=2026-06-06
EOF
}

for arg in "$@"; do
  case "$arg" in
    --date=*)        RESTORE_DATE="${arg#--date=}" ;;
    --file=*)        RESTORE_FILE="${arg#--file=}" ;;
    --target-db=*)   TARGET_DB="${arg#--target-db=}" ;;
    --yes|-y)        SKIP_CONFIRM="true" ;;
    --drop-create)   DROP_CREATE="true" ;;
    -h|--help)       print_usage; exit 0 ;;
    *)
      echo "[restore-db] ERROR: unknown argument: $arg" >&2
      print_usage >&2
      exit 2
      ;;
  esac
done

if [ -n "$RESTORE_DATE" ] && [ -n "$RESTORE_FILE" ]; then
  echo "[restore-db] ERROR: --date and --file are mutually exclusive." >&2
  exit 2
fi

if [ -z "$RESTORE_DATE" ] && [ -z "$RESTORE_FILE" ]; then
  echo "[restore-db] ERROR: must provide --date=YYYY-MM-DD or --file=<path>." >&2
  print_usage >&2
  exit 2
fi

# YYYY-MM-DD 格式校验 (避免 --date=2026/06/06 这种 silently 找不到文件)
if [ -n "$RESTORE_DATE" ]; then
  if ! echo "$RESTORE_DATE" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
    echo "[restore-db] ERROR: --date must be YYYY-MM-DD (got: $RESTORE_DATE)" >&2
    exit 2
  fi
  RESTORE_FILE="$BACKUP_DIR/${RESTORE_DATE}.sql.gz"
fi

if [ ! -f "$RESTORE_FILE" ]; then
  echo "[restore-db] ERROR: backup file not found: $RESTORE_FILE" >&2
  echo "[restore-db] available backups under $BACKUP_DIR:" >&2
  ls -1 "$BACKUP_DIR" 2>/dev/null | grep -E '\.sql\.gz$' >&2 || echo "  (none)" >&2
  exit 1
fi

if [ -n "$TARGET_DB" ]; then
  DB_NAME="$TARGET_DB"
fi

# ---------- 工具检查 ----------
if ! command -v psql >/dev/null 2>&1; then
  echo "[restore-db] ERROR: psql not found. Install postgresql-client first." >&2
  exit 1
fi
if ! command -v gunzip >/dev/null 2>&1; then
  echo "[restore-db] ERROR: gunzip not found." >&2
  exit 1
fi

# ---------- 二次确认 ----------
echo "[restore-db] target=${DB_HOST}:${DB_PORT}/${DB_NAME}  source=${RESTORE_FILE}  drop_create=${DROP_CREATE}"
if [ "$SKIP_CONFIRM" != "true" ]; then
  echo -n "[restore-db] this will overwrite database '${DB_NAME}'. type YES to continue: "
  read -r CONFIRM
  if [ "$CONFIRM" != "YES" ]; then
    echo "[restore-db] aborted by user." >&2
    exit 1
  fi
fi

# ---------- 执行恢复 ----------
START_TS="$(date +%s)"
echo "[restore-db] $(date -u '+%Y-%m-%dT%H:%M:%SZ') restore start"

export PGPASSWORD="$DB_PASSWORD"

# 可选: 先 DROP / CREATE database (clean restore)
# 注意: 连 'postgres' 管理库执行 DROP, 否则不能 DROP 当前连接所在库
if [ "$DROP_CREATE" = "true" ]; then
  echo "[restore-db] dropping + creating database '$DB_NAME'..."
  psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" \
       --dbname=postgres -v ON_ERROR_STOP=1 \
       -c "DROP DATABASE IF EXISTS \"$DB_NAME\";"
  psql --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" \
       --dbname=postgres -v ON_ERROR_STOP=1 \
       -c "CREATE DATABASE \"$DB_NAME\";"
fi

# gunzip → psql, ON_ERROR_STOP=1 让任一 SQL 失败立刻退出
gunzip -c "$RESTORE_FILE" | \
  psql --host="$DB_HOST" --port="$DB_PORT" \
       --username="$DB_USER" --dbname="$DB_NAME" \
       -v ON_ERROR_STOP=1 \
       --quiet

END_TS="$(date +%s)"
ELAPSED=$((END_TS - START_TS))
echo "[restore-db] restore ok (${ELAPSED}s elapsed). database='${DB_NAME}' restored from $(basename "$RESTORE_FILE")"
