#!/usr/bin/env bash
# CI 弱密钥 / 弱密码 lint。
# 上线 launch-helper：防止 'your-secret-key-change-in-production' / '666' / 'tr_agent_k8s_*' 等
# 已泄露默认值再次进入代码库。
#
# 命中即 exit 1。运行：
#   bash scripts/ci/check_weak_secrets.sh
#
# 排除规则：
#   - .git/ node_modules/ logs/ build/ dist/
#   - docs/ 下注释引用 OK，因为是描述"为什么不能用"
#   - .env.example 系列 OK（占位符明示）
#   - .env / .env.* （本地真实配置，不入 CI；但出现就 warn）
#   - utils/productionPreflight.ts / middlewares/internalAuth.ts 里的"已知泄露列表"OK
#   - scripts/ci/check_weak_secrets.sh 自身（避免自我命中）

set -uo pipefail

cd "$(dirname "$0")/../.."

PATTERNS=(
  'your-secret-key-change-in-production'
  'your-refresh-secret-key-change-in-production'
  'your_jwt_secret_key_here'
  'tr_agent_k8s_x9a1!b2c3d4e5f6g7h8i9j0'
  'your_internal_api_key_here'
)

# 弱密码字面量：必须出现在 :|= 之类赋值/比较上下文，否则匹配太宽
# 这里用 ripgrep 一行一行查；命中即报。
WEAK_PASSWORDS=(
  "password['\"]\\s*[:=]\\s*['\"]666['\"]"
  "SMOKE_PASSWORD['\"]?\\s*[|=]\\s*['\"]666['\"]"
  "password_hash['\"]?\\s*[:=]\\s*['\"]666['\"]"
)

ALLOWLIST_PATHS=(
  'backend/src/utils/productionPreflight.ts'
  'backend/src/middlewares/internalAuth.ts'
  'scripts/ci/check_weak_secrets.sh'
  'docs/'
  '.env.example'
)

EXCLUDE_DIRS=(
  '.git'
  'node_modules'
  'logs'
  'dist'
  'build'
  '.artifacts'
  '__pycache__'
  '.next'
  'coverage'
)

if ! command -v rg >/dev/null 2>&1; then
  echo "[ci-lint] ripgrep (rg) not installed; falling back to grep -R"
  GREP_CMD="grep -RInE"
else
  GREP_CMD="rg --no-heading --line-number --color=never -nE"
fi

build_exclude_args() {
  local args=()
  if [[ "$GREP_CMD" == rg* ]]; then
    for d in "${EXCLUDE_DIRS[@]}"; do args+=(--glob "!**/${d}/**"); done
  else
    for d in "${EXCLUDE_DIRS[@]}"; do args+=(--exclude-dir="$d"); done
  fi
  printf '%s\0' "${args[@]}"
}

mapfile -d '' EXCLUDE_ARGS < <(build_exclude_args)

in_allowlist() {
  local path="$1"
  for allow in "${ALLOWLIST_PATHS[@]}"; do
    [[ "$path" == *"$allow"* ]] && return 0
  done
  return 1
}

fail=0
fail_lines=()

scan_pattern() {
  local pat="$1"
  local label="$2"
  local hits
  hits=$($GREP_CMD "$pat" . "${EXCLUDE_ARGS[@]}" 2>/dev/null || true)
  [[ -z "$hits" ]] && return 0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local path
    path=$(echo "$line" | awk -F: '{print $1}')
    if in_allowlist "$path"; then
      continue
    fi
    fail=1
    fail_lines+=("[$label] $line")
  done <<< "$hits"
}

for pat in "${PATTERNS[@]}"; do
  scan_pattern "$pat" "leaked-secret"
done
for pat in "${WEAK_PASSWORDS[@]}"; do
  scan_pattern "$pat" "weak-password"
done

if [[ $fail -eq 1 ]]; then
  echo "==========================================="
  echo "❌ 弱密钥 / 弱密码 lint 失败"
  echo "==========================================="
  for l in "${fail_lines[@]}"; do
    echo "  $l"
  done
  echo ""
  echo "允许的引用位置见 ALLOWLIST_PATHS（脚本顶部）；"
  echo "如果是真的需要轮换，编辑后让密钥不再出现在源码里。"
  exit 1
fi

echo "✅ 弱密钥 / 弱密码 lint 通过"
