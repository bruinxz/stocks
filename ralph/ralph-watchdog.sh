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
    # 卡了，找当前 worktree 路径下所有 claude --dangerously 进程
    # （ralph.sh -> 子 bash -> claude，所以 pgrep -P 找不到，用 pwdx/cwd 匹配 worktree 路径）
    WORKTREE_PATH="/Users/bytedance/go/src/github.com/bruinxz/stocks/.claude/worktrees/zen-khorana-13679b"
    CLAUDE_PIDS=$(pgrep -f "claude --dangerously" || true)
    KILLED_ANY=""
    for pid in $CLAUDE_PIDS; do
      # 检查这个 claude 进程的 CWD 是不是在我们的 worktree 下
      proc_cwd=$(lsof -p "$pid" -d cwd -F n 2>/dev/null | awk 'NR==2{sub(/^n/,"");print}')
      if [[ "$proc_cwd" == "$WORKTREE_PATH"* ]]; then
        echo "[$(date)] ⚠ Ralph stuck for ${IDLE_MIN} min. Killing claude PID ${pid} (cwd=$proc_cwd)."
        kill "$pid" 2>/dev/null || true
        KILLED_ANY="yes"
      fi
    done

    if [ -n "$KILLED_ANY" ]; then
      sleep 5
      for pid in $CLAUDE_PIDS; do
        if kill -0 "$pid" 2>/dev/null; then
          echo "[$(date)] Forcing kill -9 ${pid}"
          kill -9 "$pid" 2>/dev/null || true
        fi
      done
      sleep 10
      echo "[$(date)] Watchdog action complete. Ralph should advance to next iteration."
    else
      echo "[$(date)] Log idle ${IDLE_MIN} min but no matching claude found in worktree, skip."
    fi
  fi
done
