#!/usr/bin/env bash
#
# scripts/ops/redis_backup_daily.sh — Redis 每日快照 (R71+, 保留 7 天).
#
# 部署: /opt/stocks/scripts/redis_backup_daily.sh
# Cron: /etc/cron.d/stocks-backup  →  35 3 * * * root /opt/stocks/scripts/redis_backup_daily.sh
#
# vs 老版本改动:
#   1. 保留窗口 14 天 → 7 天
#   2. BGSAVE 失败时 exit 1 (而不是 || true 静默)
#
set -euo pipefail
IFS=$'\n\t'

BACKUP_DIR=/backup/stocks/redis
LOG=/var/log/stocks/redis_backup_daily.log
KEEP_DAYS=7

mkdir -p "$BACKUP_DIR" /var/log/stocks
exec >>"$LOG" 2>&1

stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
echo "[$(stamp)] start stocks redis backup (keep ${KEEP_DAYS} days)"

# 1. 触发 BGSAVE (持久化到 RDB)
if ! docker exec stocks-redis redis-cli BGSAVE >/dev/null; then
  echo "[$(stamp)] ERROR BGSAVE failed"; exit 1
fi

# 2. 等 BGSAVE 完成 (最多 30s, paper trading 状态量小一般 <2s)
for _ in $(seq 1 30); do
  status=$(docker exec stocks-redis redis-cli INFO persistence 2>/dev/null | tr -d '\r' | awk -F: '/rdb_bgsave_in_progress/{print $2}')
  [ "${status:-0}" = "0" ] && break
  sleep 1
done

# 3. 打包 /data/stocks/redis 整个目录 (RDB + appendonly)
ts=$(date +%Y%m%d%H%M%S)
out="$BACKUP_DIR/redis_${ts}.tgz"
tmp="$out.tmp"
tar -czf "$tmp" -C /data/stocks redis
mv "$tmp" "$out"

# 4. sha256 + latest symlink
sha256sum "$out" > "$out.sha256"
chown stocks_app:stocks "$out" "$out.sha256" || true
chmod 640 "$out" "$out.sha256" || true
ln -sfn "$(basename "$out")" "$BACKUP_DIR/latest.tgz"
ln -sfn "$(basename "$out.sha256")" "$BACKUP_DIR/latest.tgz.sha256"

# 5. 清理超 KEEP_DAYS, 保留 latest.* symlinks
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'redis_*.tgz' -mtime +${KEEP_DAYS} -print -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'redis_*.tgz.sha256' -mtime +${KEEP_DAYS} -print -delete

echo "[$(stamp)] done $out $(du -h "$out" | awk '{print $1}')"
