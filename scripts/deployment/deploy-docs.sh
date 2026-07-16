#!/bin/bash
# deploy-docs.sh — 快速上线文档更新, 无需 rebuild
#
# 用途: 修改 docs/ 目录下的 md 文件后, 一键推送到 prod 服务器
# 无需: 重启 backend / rebuild frontend / 重启 docker
# 生效: 服务器 git pull 完成即刻生效 (下次 API 请求实时读磁盘)
#
# 前置:
#   - 本地 docs/ 已 git commit
#   - 已 git push 到远程分支 (main 或指定分支)
#
# 使用:
#   ./scripts/deploy-docs.sh              # 部署到 main 分支
#   ./scripts/deploy-docs.sh <branch>      # 部署指定分支

set -euo pipefail

BRANCH="${1:-main}"
SSH_HOST="${SSH_HOST:-<legacy-prod-host>}"
SSH_PORT="${SSH_PORT:-14126}"
SSH_USER="${SSH_USER:-deploy}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/stocks/current}"

# 密码优先从 env 读, 否则从 exp 脚本或提示
if [ -z "${DEPLOY_PASSWORD:-}" ]; then
  echo "[ERR] DEPLOY_PASSWORD not set. Export it first:"
  echo "      export DEPLOY_PASSWORD='<deploy user password>'"
  exit 1
fi

echo "[docs-deploy] branch=$BRANCH host=$SSH_HOST"

# 检查 local 是否 push 完
LOCAL_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
LOCAL_STATUS=$(git status --porcelain docs/ 2>/dev/null || true)

if [ -n "$LOCAL_STATUS" ]; then
  echo "[WARN] docs/ 有未提交的改动:"
  echo "$LOCAL_STATUS"
  read -p "继续吗? (y/N) " confirm
  [[ "$confirm" =~ ^[yY]$ ]] || { echo "aborted"; exit 1; }
fi

echo "[docs-deploy] local HEAD: $LOCAL_HEAD"

# /opt/stocks/current 是 symlink 到 releases/<timestamp>, 每个 release 是独立
# 复制体 (无 .git). 因此不能用 git pull, 直接用 rsync 把本地 docs/ 推上去即可.
LOCAL_DOCS="$(cd "$(dirname "$0")/../.." && pwd)/docs/"
echo "[docs-deploy] rsync 本地 $LOCAL_DOCS → $SSH_USER@$SSH_HOST:$REMOTE_ROOT/docs/"

sshpass -p "$DEPLOY_PASSWORD" rsync -avz --delete \
  -e "ssh -o StrictHostKeyChecking=no -p $SSH_PORT" \
  "$LOCAL_DOCS" \
  "$SSH_USER@$SSH_HOST:$REMOTE_ROOT/docs/"

echo "[docs-deploy] 完成 — API 下次请求会直接读磁盘新内容 (无需 restart)"

echo ""
echo "[docs-deploy] ✅ 完成! 文档已生效, 无需 restart backend."
echo "[docs-deploy] 访问 https://<prod-frontend>/workspace/docs 验证"
