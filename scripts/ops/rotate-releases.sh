#!/usr/bin/env bash
#
# scripts/ops/rotate-releases.sh — 服务端 /opt/stocks/releases 轮转, 保留最新 7 份.
#
# 部署: /opt/stocks/scripts/rotate-releases.sh
# Cron: /etc/cron.d/stocks-backup  →  45 3 * * * root /opt/stocks/scripts/rotate-releases.sh
#
# 实测前: 70 份 release × ~160MB = 11GB
# 实测后: 7 份  × ~160MB = ~1.1GB, 省 ~10GB
#
# 永远保留 current symlink 指向的 release, 即使它不在最新 7 个内 (防误删生产)
#
set -euo pipefail
IFS=$'\n\t'

RELEASES_DIR=/opt/stocks/releases
CURRENT_LINK=/opt/stocks/current
KEEP=7
LOG=/var/log/stocks/rotate-releases.log

mkdir -p /var/log/stocks
exec >>"$LOG" 2>&1

stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

if [ ! -d "$RELEASES_DIR" ]; then
  echo "[$(stamp)] ERROR $RELEASES_DIR not found"; exit 1
fi

# 当前 active release (current symlink 指向的目录名)
ACTIVE=""
if [ -L "$CURRENT_LINK" ]; then
  ACTIVE=$(basename "$(readlink "$CURRENT_LINK")")
fi

echo "[$(stamp)] start rotation (keep $KEEP newest + active=$ACTIVE)"

# 按 mtime 倒序, 留最新 $KEEP 个, 其余删 (但跳过 active)
to_delete=$(ls -1t "$RELEASES_DIR" | tail -n +$((KEEP + 1)) || true)

deleted=0
kept_active=0
for r in $to_delete; do
  if [ "$r" = "$ACTIVE" ]; then
    echo "[$(stamp)] SKIP $r (active, current → here)"
    kept_active=1
    continue
  fi
  rm -rf "$RELEASES_DIR/$r"
  echo "[$(stamp)] DELETED $r"
  deleted=$((deleted + 1))
done

remaining=$(ls "$RELEASES_DIR" | wc -l)
size_after=$(du -sh "$RELEASES_DIR" 2>/dev/null | awk '{print $1}')
echo "[$(stamp)] done: deleted=$deleted, kept_active=$kept_active, remaining=$remaining, size=$size_after"
