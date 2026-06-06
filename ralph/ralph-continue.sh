#!/bin/bash
# Ralph 接力脚本 — 当前 18 轮跑完后，自动接力跑剩余 story
# Usage: nohup ./ralph-continue.sh > ralph-continue.log 2>&1 &

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Wait for current ralph.sh to finish (检查 ralph-run.log 最后一行是否包含结束标记)
echo "[$(date)] Waiting for current ralph run to finish..."
while pgrep -f "ralph.sh --tool claude 18" > /dev/null; do
  sleep 30
done

echo "[$(date)] Current run finished. Launching continuation: 92 more iterations."

# 继续跑剩余 story（最多 92 轮，因为已经跑了至多 18 个）
./ralph.sh --tool claude 92
