#!/usr/bin/env bash
#
# scripts/backup-db.sh — US-071 定时全量备份脚本
#
# 功能:
#   1. 用 pg_dump 把当前 PostgreSQL 数据库导出
#   2. gzip 压缩后写入 backups/YYYY-MM-DD.sql.gz
#   3. 自动清理 30 天前的旧备份 (RETENTION_DAYS 可覆盖)
#
# 环境变量 (优先读取, 缺失时回退默认值):
#   DB_HOST     默认 localhost
#   DB_PORT     默认 5432
#   DB_NAME     默认 stock_backtest
#   DB_USER     默认 postgres
#   DB_PASSWORD 默认 postgres  (通过 PGPASSWORD 传给 pg_dump)
#   BACKUP_DIR  默认 <repo-root>/backups
#   RETENTION_DAYS 默认 30
#
# 使用:
#   bash scripts/backup-db.sh                    # 默认配置
#   DB_HOST=db.prod ./scripts/backup-db.sh       # 远端备份
#   npm run db:backup                            # 通过 backend 的 npm script
#
# Cron 示例 (每日凌晨 03:15 备份):
#   15 3 * * * cd /opt/stocks && ./scripts/backup-db.sh >> /var/log/stocks-backup.log 2>&1

set -euo pipefail

# ---------- 配置 ----------
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-stock_backtest}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

DATE_TAG="$(date '+%Y-%m-%d')"
BACKUP_FILE="$BACKUP_DIR/${DATE_TAG}.sql.gz"

# ---------- 校验 ----------
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "[backup-db] ERROR: pg_dump not found. Install postgresql-client first." >&2
  exit 1
fi

if ! command -v gzip >/dev/null 2>&1; then
  echo "[backup-db] ERROR: gzip not found." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# ---------- 执行备份 ----------
echo "[backup-db] $(date -u '+%Y-%m-%dT%H:%M:%SZ') target=${DB_HOST}:${DB_PORT}/${DB_NAME} -> ${BACKUP_FILE}"

# 临时文件 → gzip → 原子 rename, 避免备份中途被 cron / restore 读到半成品
TMP_FILE="${BACKUP_FILE}.tmp.$$"
trap 'rm -f "$TMP_FILE"' EXIT

PGPASSWORD="$DB_PASSWORD" pg_dump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --no-owner \
  --no-privileges \
  --format=plain \
  | gzip -c -9 > "$TMP_FILE"

mv "$TMP_FILE" "$BACKUP_FILE"
trap - EXIT

BACKUP_SIZE="$(du -h "$BACKUP_FILE" | awk '{print $1}')"
echo "[backup-db] backup ok: ${BACKUP_FILE} (${BACKUP_SIZE})"

# ---------- 清理超过 RETENTION_DAYS 天的旧备份 ----------
# 仅清理形如 YYYY-MM-DD.sql.gz 的文件, 不动其他文件
if [ "$RETENTION_DAYS" -gt 0 ]; then
  PURGED=0
  while IFS= read -r -d '' old_file; do
    rm -f "$old_file"
    echo "[backup-db] purged old backup: $old_file"
    PURGED=$((PURGED + 1))
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f \
    -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].sql.gz' \
    -mtime "+${RETENTION_DAYS}" -print0 2>/dev/null)
  echo "[backup-db] retention=${RETENTION_DAYS}d purged_count=${PURGED}"
fi

echo "[backup-db] done."
