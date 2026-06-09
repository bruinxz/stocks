#!/bin/bash
# Ralph 自动续跑 - 检测 ralph 退出但还有 story 未完成时自动续跑
# Usage: nohup ./ralph-resumer.sh > ralph-resumer.log 2>&1 &
#
# 工作原理：
#   每 5 分钟检查一次
#   1. 看 ralph.sh 是否在跑 → 在跑就 idle
#   2. 不在跑 → 检查 prd.json 还有几个 passes:false 的 story
#   3. 如果 > 0 → 自动启动新的 ralph.sh （20 轮 cap）
#   4. = 0 → 全部完成，自杀退出

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PRD_FILE="$SCRIPT_DIR/prd.json"
LOG_FILE="$SCRIPT_DIR/ralph-run.log"
CHECK_INTERVAL=300  # 5 分钟
RESUMER_HEARTBEAT="$SCRIPT_DIR/ralph-resumer.heartbeat"

echo "[$(date)] Ralph resumer started (PID $$, check every ${CHECK_INTERVAL}s)"

while true; do
  sleep $CHECK_INTERVAL
  date > "$RESUMER_HEARTBEAT" 2>/dev/null

  # 1. ralph 还在跑？
  if pgrep -f "ralph.sh --tool claude" > /dev/null 2>&1; then
    continue  # 还在跑，无需操作
  fi

  # 2. 还有 story 未完成？
  REMAINING=$(jq '[.userStories[] | select(.passes == false)] | length' "$PRD_FILE" 2>/dev/null || echo "unknown")

  if [ "$REMAINING" = "0" ]; then
    echo "[$(date)] All 100 stories complete. Resumer exiting."
    exit 0
  fi

  if [ "$REMAINING" = "unknown" ]; then
    echo "[$(date)] Could not read prd.json, will retry next cycle."
    continue
  fi

  # 3. 自动续跑
  echo "[$(date)] ⚠ Ralph not running, $REMAINING stories remain. Launching new ralph.sh (cap=20)."
  nohup "$SCRIPT_DIR/ralph.sh" --tool claude 20 > "$LOG_FILE" 2>&1 &
  NEW_PID=$!
  sleep 5
  if pgrep -P "$NEW_PID" > /dev/null 2>&1 || kill -0 "$NEW_PID" 2>/dev/null; then
    echo "[$(date)] New ralph launched as PID $NEW_PID. Will check again in ${CHECK_INTERVAL}s."
  else
    echo "[$(date)] ⚠ Launched but PID $NEW_PID is gone — something went wrong."
  fi
done
