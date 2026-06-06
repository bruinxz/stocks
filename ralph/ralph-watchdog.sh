#!/bin/bash
# Ralph 看门狗 - 如果 ralph-run.log 超过 N 分钟没更新就 kill 卡死的 claude 进程
# 让 ralph.sh 主循环自动进入下一轮
# Usage: nohup ./ralph-watchdog.sh > ralph-watchdog.log 2>&1 &

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_FILE="$SCRIPT_DIR/ralph-run.log"
STUCK_MINUTES=20  # 超过这么多分钟没更新就视为卡死
CHECK_INTERVAL=120  # 每 2 分钟检查一次

echo "[$(date)] Ralph watchdog started (stuck threshold: ${STUCK_MINUTES} min)"

while true; do
  sleep $CHECK_INTERVAL

  # 找出当前 worktree 的 ralph 主进程
  RALPH_PID=$(pgrep -f "ralph.sh --tool claude" | head -1 || true)
  if [ -z "$RALPH_PID" ]; then
    # 主 ralph 没了，检查 continue 是否在
    CONT_PID=$(pgrep -f "ralph-continue.sh" || true)
    if [ -z "$CONT_PID" ]; then
      echo "[$(date)] Both ralph and continue gone, watchdog exiting."
      exit 0
    fi
    echo "[$(date)] Main ralph not running, but continue is waiting. Skipping check."
    continue
  fi

  # 看 log 最后修改时间
  if [ ! -f "$LOG_FILE" ]; then
    continue
  fi

  LOG_MTIME=$(stat -f %m "$LOG_FILE")
  NOW=$(date +%s)
  IDLE_SEC=$((NOW - LOG_MTIME))
  IDLE_MIN=$((IDLE_SEC / 60))

  if [ $IDLE_MIN -ge $STUCK_MINUTES ]; then
    # 卡了，找子 claude 杀掉
    CLAUDE_PID=$(pgrep -P "$RALPH_PID" -f "claude --dangerously" || true)
    if [ -n "$CLAUDE_PID" ]; then
      echo "[$(date)] ⚠ Ralph stuck for ${IDLE_MIN} min. Killing child claude PID ${CLAUDE_PID}."
      kill "$CLAUDE_PID" 2>/dev/null || true
      sleep 5
      # 如果还在就 -9
      if kill -0 "$CLAUDE_PID" 2>/dev/null; then
        echo "[$(date)] Forcing kill -9 ${CLAUDE_PID}"
        kill -9 "$CLAUDE_PID" 2>/dev/null || true
      fi
      # 给 ralph 主循环时间进入下一轮
      sleep 10
      echo "[$(date)] Watchdog action complete. Ralph should advance to next iteration."
    else
      echo "[$(date)] Log idle ${IDLE_MIN} min but no child claude found, skip."
    fi
  fi
done
