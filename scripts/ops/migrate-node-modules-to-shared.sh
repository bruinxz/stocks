#!/usr/bin/env bash
# 一次性: 把 active release 的 node_modules 提到 /opt/stocks/shared/node_modules/,
# 其他 release 的 node_modules 全部删了重建为 symlink.
#
# 跑之前: 已确认全部 release 的 backend/package-lock.json + frontend/package-lock.json hash 相同
# (即 4 份独立装的 node_modules 内容必然一样, 安全合并)
#
# 立省: 4 份 × ~1.3GB = ~5.2GB

set -euo pipefail

RELEASES=/opt/stocks/releases
SHARED=/opt/stocks/shared
SHARED_NM="$SHARED/node_modules"
ACTIVE_REL="$SHARED/../current"

ACTIVE=$(readlink -f "$ACTIVE_REL")
ACTIVE_NAME=$(basename "$ACTIVE")
echo "[A] active release: $ACTIVE_NAME"

mkdir -p "$SHARED_NM"

migrate_one_pkg() {
  local pkg=$1  # backend | frontend
  echo "--- $pkg"
  local src="$ACTIVE/$pkg/node_modules"
  local dst="$SHARED_NM/$pkg"

  if [ -L "$src" ]; then
    echo "  active's $pkg/node_modules is already symlink → $(readlink "$src"), skip migration"
  elif [ -d "$src" ]; then
    if [ -d "$dst" ]; then
      echo "  shared $dst exists, removing (will use active's as fresh source)"
      rm -rf "$dst"
    fi
    echo "  mv $src → $dst (be patient, $(du -sh "$src" | cut -f1))"
    mv "$src" "$dst"
    # active 自己也 symlink 到 shared
    ln -s "$dst" "$src"
    echo "  ln $src → $dst"
  else
    echo "  ERROR active's $pkg/node_modules not found: $src"
    return 1
  fi

  # 记录当前 lock hash (deploy 脚本将比对)
  local lock="$ACTIVE/$pkg/package-lock.json"
  if [ -f "$lock" ]; then
    local h=$(sha256sum "$lock" | cut -d' ' -f1)
    echo "$h" > "$SHARED_NM/.${pkg}.lock.hash"
    echo "  lock hash: $h"
  fi
}

migrate_one_pkg backend
migrate_one_pkg frontend
echo

# 其他 release 全删 + 软链
echo "[A] migrate other releases to symlink shared"
for r in "$RELEASES"/*/; do
  rn=$(basename "$r")
  if [ "$rn" = "$ACTIVE_NAME" ]; then continue; fi
  for pkg in backend frontend; do
    p="$r/$pkg/node_modules"
    if [ -L "$p" ]; then
      echo "  $rn/$pkg: already symlink, retarget to shared"
      rm -f "$p"
      ln -s "$SHARED_NM/$pkg" "$p"
    elif [ -d "$p" ]; then
      sz=$(du -sh "$p" 2>/dev/null | cut -f1)
      echo "  $rn/$pkg: delete real dir ($sz) → symlink"
      rm -rf "$p"
      ln -s "$SHARED_NM/$pkg" "$p"
    fi
  done
done
echo

echo "[A] done"
echo "shared node_modules:"
du -sh "$SHARED_NM"/backend "$SHARED_NM"/frontend 2>&1
ls -la "$SHARED_NM"/*.hash 2>&1
echo
echo "releases now:"
du -sh "$RELEASES"
du -sh "$RELEASES"/*/ | sort -h | tail -8
echo
echo "全盘:"
df -h / | head -2
