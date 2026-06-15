#!/usr/bin/env bash
#
# scripts/ops/pg_backup_daily.sh — 服务端每日全量备份 (R71+, 保留 7 天).
#
# 部署: /opt/stocks/scripts/pg_backup_daily.sh
# Cron: /etc/cron.d/stocks-backup  →  25 3 * * * root /opt/stocks/scripts/pg_backup_daily.sh
#
# vs 老版本改动:
#   1. 保留窗口 14 天 → 7 天 (减磁盘占用 + 跟 crp 对齐)
#   2. 额外备份 backend.env → /backup/stocks/secrets/backend.env.<ts>.bak
#      (重装时不重新申请 AI key / 券商 token, 直接 cp 回 shared/)
#   3. 失败 exit 1 让 cron 邮件告警生效
#
set -euo pipefail
IFS=$'\n\t'

ENV=/opt/stocks/shared/backend.env
BACKUP_DIR=/backup/stocks/postgres
SECRETS_DIR=/backup/stocks/secrets
LOG=/var/log/stocks/pg_backup_daily.log
KEEP_DAYS=7

mkdir -p "$BACKUP_DIR" "$SECRETS_DIR" /var/log/stocks
exec >>"$LOG" 2>&1

stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
echo "[$(stamp)] start stocks pg backup (keep ${KEEP_DAYS} days)"

if [ ! -f "$ENV" ]; then
  echo "[$(stamp)] ERROR missing env $ENV"; exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV"
set +a
: "${DB_NAME:?DB_NAME missing}"
: "${DB_USER:?DB_USER missing}"
: "${DB_PASSWORD:?DB_PASSWORD missing}"

ts=$(date +%Y%m%d%H%M%S)
out="$BACKUP_DIR/${DB_NAME}_${ts}.dump"
tmp="$out.tmp"

# 1. pg_dump → 临时文件 (容器 stocks-postgres 是 timescaledb pg14)
docker exec -e PGPASSWORD="$DB_PASSWORD" stocks-postgres \
  pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$tmp"

# 2. 校验 dump 完整性 (pg_restore -l 列出 catalog), 失败立刻 abort
docker run --rm -i docker.m.daocloud.io/timescale/timescaledb:latest-pg14 \
  pg_restore -l < "$tmp" >/tmp/stocks_pg_restore_list.txt || {
    echo "[$(stamp)] ERROR pg_restore catalog validation failed"
    rm -f "$tmp"
    exit 1
  }

# 3. 原子 rename + sha256 (Sprint 38: 用 cd + basename 写相对路径, 异机/异 mount 校验稳)
mv "$tmp" "$out"
( cd "$(dirname "$out")" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256" )
chown stocks_app:stocks "$out" "$out.sha256" || true
chmod 640 "$out" "$out.sha256" || true

# 4. latest symlink (restore 一键引用)
ln -sfn "$(basename "$out")" "$BACKUP_DIR/latest.dump"
ln -sfn "$(basename "$out.sha256")" "$BACKUP_DIR/latest.dump.sha256"

# 5. 备份 backend.env (R71 新增)
env_bak="$SECRETS_DIR/backend.env.${ts}.bak"
cp "$ENV" "$env_bak"
chown stocks_app:stocks "$env_bak" || true
# 640: owner + group 可读. ops 在 stocks 组所以 backup-pull 能拉
chmod 640 "$env_bak"
ln -sfn "$(basename "$env_bak")" "$SECRETS_DIR/latest.env.bak"

# 6. 清理超 KEEP_DAYS 的, 但永远保留 latest.* symlinks
find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}_*.dump" -mtime +${KEEP_DAYS} -print -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}_*.dump.sha256" -mtime +${KEEP_DAYS} -print -delete
find "$SECRETS_DIR" -maxdepth 1 -type f -name "backend.env.*.bak" -mtime +${KEEP_DAYS} -print -delete

echo "[$(stamp)] done $out $(du -h "$out" | awk '{print $1}'), env=${env_bak}"
