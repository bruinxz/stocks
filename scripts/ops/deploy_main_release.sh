#!/bin/bash
# /opt/stocks/shared/deploy_main_release.sh
# R71 改造 (2026-06-15):
#   - node_modules 改为 /opt/stocks/shared/node_modules/{backend,frontend} 共享
#   - 比对 package-lock.json hash, 只有 lock 变化时才 npm ci 重装
#   - 节省: 每份 release 不再独占 1.3GB node_modules
#
set -euo pipefail
ROOT=/opt/stocks
CUR="$ROOT/current"
SHARED="$ROOT/shared"
SHARED_NM="$SHARED/node_modules"
STATUS_FILE="$SHARED/deploy_main_status"
PATH_FILE="$SHARED/deploy_main_release_path"
PKG="$SHARED/stocks_release_20260520_3.tgz"

trap 'echo FAILED > "$STATUS_FILE"' ERR
TS=$(date +%Y%m%d%H%M%S)
REL="$ROOT/releases/$TS"
echo RUNNING > "$STATUS_FILE"

mkdir -p "$REL" "$SHARED_NM"

# 1. 解压 release
tar xzf "$PKG" -C "$REL"
cp "$SHARED/backend.env" "$REL/backend/.env"

# 2. node_modules: 比对 lock hash, 变了就 npm ci, 没变就直接 symlink
for pkg in backend frontend; do
  lock="$REL/$pkg/package-lock.json"
  if [ ! -f "$lock" ]; then
    echo "[deploy] WARN $pkg/package-lock.json missing, skipping"
    continue
  fi

  new_hash=$(sha256sum "$lock" | cut -d' ' -f1)
  hash_file="$SHARED_NM/.${pkg}.lock.hash"
  cur_hash=""
  [ -f "$hash_file" ] && cur_hash=$(cat "$hash_file")

  # Sprint 39: shared node_modules health smoke check.
  # 决定本次是 reuse 还是 npm ci 重装. 两个条件都满足才 reuse:
  #   (a) lock hash 未变 (常规判断)
  #   (b) 关键 .bin/ executable 存在 (防 shared dir 被部分删 / 错误覆盖 / 异常中断)
  #       backend 关键: tsc + ts-node
  #       frontend 关键: react-scripts
  # 加 smoke 是因为: 之前我们碰到过 worktree 本地 'react-scripts: command not found'
  # 错误 — node_modules 看起来在但 .bin 残缺. 生产用 shared 不能踩同样的坑.
  smoke_ok() {
    local pkg="$1"
    case "$pkg" in
      backend)
        [ -x "$SHARED_NM/$pkg/.bin/tsc" ] && [ -x "$SHARED_NM/$pkg/.bin/ts-node" ]
        ;;
      frontend)
        [ -x "$SHARED_NM/$pkg/.bin/react-scripts" ]
        ;;
      *) return 0 ;;
    esac
  }

  reuse_ok=false
  if [ -d "$SHARED_NM/$pkg" ] && [ "$new_hash" = "$cur_hash" ]; then
    if smoke_ok "$pkg"; then
      reuse_ok=true
    else
      echo "[deploy] $pkg shared node_modules hash 一致但 .bin/ smoke 失败, 强制重装"
    fi
  fi

  if [ "$reuse_ok" = true ]; then
    echo "[deploy] $pkg lock unchanged (${new_hash:0:12}) + .bin smoke OK, reuse shared node_modules"
  else
    echo "[deploy] $pkg lock changed / shared missing / smoke failed — npm ci (this will take a few min)"
    rm -rf "$SHARED_NM/$pkg"
    mkdir -p "$SHARED_NM/$pkg"
    # npm ci 需要 package.json + lock 都在同目录, 用 tmp 装好再挪
    # 注意 1: 不能 --omit=dev — backend `npm run build` 用 tsc (devDep), frontend 用 next
    # 注意 2: 用 rsync 而不是 mv glob, 否则 .bin/ 这种 dotfile 不会被搬
    TMP_DIR=$(mktemp -d)
    cp "$REL/$pkg/package.json" "$REL/$pkg/package-lock.json" "$TMP_DIR/"
    (cd "$TMP_DIR" && npm ci --no-audit --no-fund --legacy-peer-deps)
    rsync -a --delete "$TMP_DIR/node_modules/" "$SHARED_NM/$pkg/"
    rm -rf "$TMP_DIR"
    # 安装后再 smoke 一遍 — 如果还失败, 说明 lock 本身坏, fail-fast 让运维查
    if ! smoke_ok "$pkg"; then
      echo "[deploy] FATAL: $pkg npm ci 完成但 .bin/ smoke 仍失败 — package-lock.json 可能不健全"
      echo "[deploy]   expected: $([ "$pkg" = backend ] && echo tsc+ts-node || echo react-scripts)"
      ls -la "$SHARED_NM/$pkg/.bin/" 2>&1 | head -10
      exit 1
    fi
    echo "$new_hash" > "$hash_file"
    echo "[deploy] $pkg shared node_modules refreshed → ${new_hash:0:12} + smoke OK"
  fi

  # 始终用 symlink (即使老脚本残留真 dir 也覆盖)
  rm -rf "$REL/$pkg/node_modules"
  ln -s "$SHARED_NM/$pkg" "$REL/$pkg/node_modules"
done

# 3. build
cd "$REL/backend"
npm run build
cd "$REL/frontend"
CI=false npm run build

# 4. atomic switch
ln -sfn "$REL" "$CUR"
echo "$REL" > "$PATH_FILE"
echo SUCCESS > "$STATUS_FILE"
echo "DONE:$REL"
