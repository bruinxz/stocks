#!/bin/bash
# 看门狗的看门狗 - 检查 ralph-watchdog.heartbeat 文件，若超过 5 分钟没更新就重启看门狗
# Usage: nohup ./ralph-meta-watchdog.sh > ralph-meta-watchdog.log 2>&1 &

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HEARTBEAT_FILE="$SCRIPT_DIR/ralph-watchdog.heartbeat"
WATCHDOG_SCRIPT="$SCRIPT_DIR/ralph-watchdog.sh"
WATCHDOG_LOG="$SCRIPT_DIR/ralph-watchdog.log"
CHECK_INTERVAL=180  # 每 3 分钟检查一次

echo "[$(date)] Meta-watchdog started (PID $$)"

while true; do
  sleep $CHECK_INTERVAL

  # 看 ralph 是否还在跑，如果 ralph 都不在了，meta-watchdog 也无需运行
  if ! pgrep -f "ralph.sh --tool claude" > /dev/null 2>&1; then
    echo "[$(date)] Ralph not running, meta-watchdog idle (will check again in ${CHECK_INTERVAL}s)."
    continue
  fi

  # 看 heartbeat 文件
  STARTUP_NEEDED=""
  if [ ! -f "$HEARTBEAT_FILE" ]; then
    STARTUP_NEEDED="no heartbeat file"
  else
    HEARTBEAT_AGE=$(($(date +%s) - $(stat -f %m "$HEARTBEAT_FILE" 2>/dev/null || echo 0)))
    if [ $HEARTBEAT_AGE -gt 300 ]; then
      STARTUP_NEEDED="heartbeat stale ${HEARTBEAT_AGE}s"
    fi
  fi

  if [ -n "$STARTUP_NEEDED" ]; then
    # 检查看门狗进程是否真的不在
    if pgrep -f "ralph-watchdog.sh" > /dev/null 2>&1; then
      echo "[$(date)] Heartbeat issue ($STARTUP_NEEDED) but watchdog process still alive, skip."
    else
      echo "[$(date)] ⚠ Watchdog dead ($STARTUP_NEEDED). Restarting..."
      nohup "$WATCHDOG_SCRIPT" >> "$WATCHDOG_LOG" 2>&1 &
      sleep 3
      NEW_PID=$(pgrep -f "ralph-watchdog.sh" | head -1)
      echo "[$(date)] Watchdog restarted as PID $NEW_PID"
    fi
  fi
done
