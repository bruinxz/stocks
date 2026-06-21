#!/usr/bin/env bash
# scrub_legacy_ip.sh — 用 git filter-repo 把仓库历史里残留的内网 IP `47.93.224.109`
# 全部替换成占位符 `<legacy-internal-ip>` (US-130 / OPS-011).
#
# 为什么是脚本不是 ralph 自动跑:
#   - git filter-repo 改写 commit hash, 必须 force-push, 仓库级影响, 协作者要全员
#     re-clone. 这是部署级动作, ralph 红线: 触部署的改动跳过等用户.
#   - 你 (维护者) 选时间窗口 (锁仓库 / 发公告), 然后跑这个脚本.
#
# 前置:
#   - 已经在工作树把所有 active 文件里的字面 IP 改掉了 (US-130 工作树 patch).
#   - 已经在 CI 里挂了 scripts/ci/check_legacy_ip.sh 防回插.
#   - 你已经 mirror-clone 出仓库 (history rewrite 在 mirror clone 上做, 不在
#     日常工作 clone 上做).
#   - 已装 git-filter-repo: `brew install git-filter-repo` 或 `pip install git-filter-repo`.
#
# 用法 (在 mirror clone 里跑):
#   1. cd /tmp && git clone --mirror git@github.com:<org>/<repo>.git stocks.git
#   2. cd stocks.git
#   3. bash /path/to/scripts/ops/scrub_legacy_ip.sh
#   4. 人肉抽查: git log -p --all -S "47.93.224.109" | head   # 应零命中
#                git log -p --all -S "<legacy-internal-ip>" | head   # 应有
#   5. 全员通告 + 锁 push + 备份 → git push --force-with-lease --mirror
#   6. 全员 re-clone (旧 clone 直接删, 不要 git pull --rebase, 会把旧 hash 拉回来).
#
# 验收 (PRD US-130 AC):
#   git log --all -S "47.93.224.109" --oneline | wc -l   # = 0
#
# 不动 ralph/prd.json / ralph/archive/ : 这两个文件里的 IP 是 PRD 描述本身
# (用户故事文本明示 "把 git 历史中的 47.93.224.109 删掉"), 改了会让 PRD 失语.
# replace-text 通过 path-glob 排除 (filter-repo 暂不支持 --path-rename + --replace-text
# 路径排除, 所以走 paths-from-file 反向白名单的 hack: 先 dump 文件列表, 排除掉
# ralph/, 然后 --paths-from-file).

set -euo pipefail

# --- safety gates --------------------------------------------------------------

if [[ ! -d "./refs" ]] || [[ ! -f "./HEAD" ]]; then
  echo "❌ 必须在 mirror clone 目录 (bare repo) 里跑. 当前 $(pwd) 不像 mirror clone."
  echo "   先: git clone --mirror <repo-url> /tmp/stocks.git && cd /tmp/stocks.git"
  exit 1
fi

if ! command -v git-filter-repo >/dev/null 2>&1 && ! git filter-repo --help >/dev/null 2>&1; then
  echo "❌ git-filter-repo 未安装. brew install git-filter-repo 或 pip install git-filter-repo"
  exit 1
fi

if [[ -z "${I_KNOW_THIS_REWRITES_HISTORY:-}" ]]; then
  cat <<'EOF'
⚠️  此脚本会改写 git history (commit hash 全变), 必须 force-push, 协作者全员
    re-clone. 这是部署级动作, 不可逆.

    确认你已经:
      1. 在 mirror clone 目录里 (不是日常工作 clone)
      2. 全员通告好了
      3. 锁了仓库 push (临时把分支保护规则收紧)
      4. 异地备份了 mirror clone

    确认无误后, 重新运行:
      I_KNOW_THIS_REWRITES_HISTORY=1 bash scripts/ops/scrub_legacy_ip.sh
EOF
  exit 1
fi

# --- replacement spec ----------------------------------------------------------

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/replacements.txt" <<'EOF'
47.93.224.109==><legacy-internal-ip>
EOF

# 反向白名单: 所有 commit ever 触过的文件, 减去 ralph/ 路径
git log --all --name-only --pretty=format: \
  | sort -u \
  | grep -v '^$' \
  | grep -v '^ralph/' \
  > "$WORK/paths.txt"

PATHS_COUNT=$(wc -l < "$WORK/paths.txt")
echo "ℹ️  将在 $PATHS_COUNT 个路径里替换 (已排除 ralph/ 下 PRD 与 archive)."

# --- the rewrite --------------------------------------------------------------

git filter-repo \
  --replace-text "$WORK/replacements.txt" \
  --paths-from-file "$WORK/paths.txt" \
  --force

echo ""
echo "✅ filter-repo 完成. 验证:"
echo "    git log -p --all -S '47.93.224.109' | head    # 应该完全空"
echo ""
echo "下一步 (人肉确认后):"
echo "    git remote add origin git@github.com:<org>/<repo>.git   # filter-repo 会清掉 remote"
echo "    git push --force-with-lease --mirror origin"
echo ""
echo "全员通告: 旧 clone 直接删, 重新 git clone, 不要 rebase / merge 旧分支."
