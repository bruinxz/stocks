#!/bin/bash
# Ralph 看门狗 - 如果 ralph-run.log 超过 N 分钟没更新就 kill 卡死的 claude 进程
# 让 ralph.sh 主循环自动进入下一轮
# Usage: nohup ./ralph-watchdog.sh > ralph-watchdog.log 2>&1 &

# 移除 set -e — 任何子命令失败都会导致看门狗自杀（这是凌晨挂掉的原因）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_FILE="$SCRIPT_DIR/ralph-run.log"
STUCK_MINUTES=20  # 超过这么多分钟没更新就视为卡死
CHECK_INTERVAL=120  # 每 2 分钟检查一次
WORKTREE_PATH="/Users/bytedance/go/src/github.com/bruinxz/stocks/.claude/worktrees/zen-khorana-13679b"

# 心跳：每次循环写入一个时间戳到一个独立文件，方便外部检测看门狗是否还活着
HEARTBEAT_FILE="$SCRIPT_DIR/ralph-watchdog.heartbeat"

echo "[$(date)] Ralph watchdog started (stuck threshold: ${STUCK_MINUTES} min, PID $$)"

while true; do
  sleep $CHECK_INTERVAL
  date > "$HEARTBEAT_FILE" 2>/dev/null

  # 找出当前 worktree 的 ralph 主进程
  RALPH_PID=$(pgrep -f "ralph.sh --tool claude" 2>/dev/null | head -1)
  if [ -z "$RALPH_PID" ]; then
    echo "[$(date)] Ralph not running, watchdog idle (will check again in ${CHECK_INTERVAL}s)."
    continue
  fi

  # 看 log 最后修改时间
  if [ ! -f "$LOG_FILE" ]; then
    continue
  fi

  LOG_MTIME=$(stat -f %m "$LOG_FILE" 2>/dev/null)
  if [ -z "$LOG_MTIME" ]; then
    continue
  fi
  NOW=$(date +%s)
  IDLE_SEC=$((NOW - LOG_MTIME))
  IDLE_MIN=$((IDLE_SEC / 60))

  if [ $IDLE_MIN -ge $STUCK_MINUTES ]; then
    # 卡了，找当前 worktree 路径下所有 claude --dangerously 进程
    CLAUDE_PIDS=$(pgrep -f "claude --dangerously" 2>/dev/null)
    KILLED_ANY=""
    for pid in $CLAUDE_PIDS; do
      proc_cwd=$(lsof -p "$pid" -d cwd -F n 2>/dev/null | awk 'NR==2{sub(/^n/,"");print}')
      if [[ "$proc_cwd" == "$WORKTREE_PATH"* ]]; then
        echo "[$(date)] ⚠ Ralph stuck for ${IDLE_MIN} min. Killing claude PID ${pid} (cwd=$proc_cwd)."
        kill "$pid" 2>/dev/null
        KILLED_ANY="yes"
      fi
    done

    if [ -n "$KILLED_ANY" ]; then
      sleep 5
      for pid in $CLAUDE_PIDS; do
        if kill -0 "$pid" 2>/dev/null; then
          proc_cwd=$(lsof -p "$pid" -d cwd -F n 2>/dev/null | awk 'NR==2{sub(/^n/,"");print}')
          if [[ "$proc_cwd" == "$WORKTREE_PATH"* ]]; then
            echo "[$(date)] Forcing kill -9 ${pid}"
            kill -9 "$pid" 2>/dev/null
          fi
        fi
      done
      sleep 10
      echo "[$(date)] Watchdog action complete. Ralph should advance to next iteration."
    else
      echo "[$(date)] Log idle ${IDLE_MIN} min but no matching claude found in worktree, skip."
    fi
  fi
done
