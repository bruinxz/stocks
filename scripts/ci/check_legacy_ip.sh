#!/usr/bin/env bash
# CI lint: 禁止把 legacy 内网 IP `47.93.224.109` 重新引入工作树 (US-130 / OPS-011).
#
# 背景: 这个 IP 是 TradingAgents 早期硬编码默认值, audit L-19 已经从 backend/src/
# 抽到 config/externalServices.ts 并改成 127.0.0.1 兜底. 残留在 git history 里的
# 用 scripts/ops/scrub_legacy_ip.sh 抹 (手工跑). 本 lint 防的是新 commit 再次
# 把字面 IP 加回来.
#
# 命中即 exit 1. 用法: bash scripts/ci/check_legacy_ip.sh
#
# 白名单 (按路径模糊匹配):
#   - ralph/prd.json / ralph/archive/  : 用户故事文本本身, 描述要清的就是这个 IP
#   - scripts/ci/check_legacy_ip.sh    : 本脚本自己 (字面值出现在 PATTERN)
#   - scripts/ops/scrub_legacy_ip.sh   : 抹除脚本本身, 注释里要明示要清的字面值
#   - 没了. 任何代码 / 测试 / 文档新 commit 命中 = 阻 PR.

set -uo pipefail

cd "$(dirname "$0")/../.."

PATTERN='47\.93\.224\.109'

ALLOWLIST_PATHS=(
  'ralph/prd.json'
  'ralph/archive/'
  'scripts/ci/check_legacy_ip.sh'
  'scripts/ops/scrub_legacy_ip.sh'
)

EXCLUDE_DIRS=(
  '.git'
  '.claude'
  'node_modules'
  'logs'
  'dist'
  'build'
  '.artifacts'
  '__pycache__'
  '.next'
  'coverage'
)

if command -v rg >/dev/null 2>&1; then
  EXCLUDE_ARGS=()
  for d in "${EXCLUDE_DIRS[@]}"; do EXCLUDE_ARGS+=(--glob "!**/${d}/**"); done
  hits=$(rg --no-heading --line-number --color=never -nE "$PATTERN" . "${EXCLUDE_ARGS[@]}" 2>/dev/null || true)
else
  EXCLUDE_ARGS=()
  for d in "${EXCLUDE_DIRS[@]}"; do EXCLUDE_ARGS+=(--exclude-dir="$d"); done
  hits=$(grep -RInE "$PATTERN" . "${EXCLUDE_ARGS[@]}" 2>/dev/null || true)
fi

in_allowlist() {
  local path="$1"
  for allow in "${ALLOWLIST_PATHS[@]}"; do
    [[ "$path" == *"$allow"* ]] && return 0
  done
  return 1
}

fail=0
fail_lines=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  path=$(echo "$line" | awk -F: '{print $1}')
  # 去掉前缀 ./
  path="${path#./}"
  if in_allowlist "$path"; then
    continue
  fi
  fail=1
  fail_lines+=("$line")
done <<< "$hits"

if [[ $fail -eq 1 ]]; then
  echo "==========================================="
  echo "❌ legacy 内网 IP lint 失败"
  echo "==========================================="
  for l in "${fail_lines[@]}"; do
    echo "  $l"
  done
  echo ""
  echo "原因: 47.93.224.109 是 audit L-19 / US-130 已经清掉的内网 IP."
  echo "      新代码 / 新文档不应再出现这个字面值."
  echo ""
  echo "怎么改:"
  echo "  - 代码默认值: 用 config/externalServices.ts 的 TRADING_AGENTS_BASE_URL"
  echo "  - 文档描述:   用占位符 <legacy-internal-ip> 或 <internal-host>"
  echo "  - 测试 mock:  用 http://127.0.0.1:8000 兜底"
  exit 1
fi

echo "✅ legacy 内网 IP lint 通过"
