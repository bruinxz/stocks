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

  if [ -d "$SHARED_NM/$pkg" ] && [ "$new_hash" = "$cur_hash" ]; then
    echo "[deploy] $pkg lock unchanged (${new_hash:0:12}), reuse shared node_modules"
  else
    echo "[deploy] $pkg lock changed or shared missing — npm ci (this will take a few min)"
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
    echo "$new_hash" > "$hash_file"
    echo "[deploy] $pkg shared node_modules refreshed → ${new_hash:0:12}"
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
