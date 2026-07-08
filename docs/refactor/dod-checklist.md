# DoD Checklist · Definition of Done 铁律 17 项 (v4.4)

**版本**: v4.4 · 2026-07-09 formalize landed
**owner**: QADocs (治理层 SOP owns) · 7-owner co-owned closure (QADocs + Orch + Cleanup + DP + Strategy + Frontend + Research)
**scope**: 所有 agent · 所有 PR CREATE / amend / commit / push 前必核 (17 项 self-check pre-flight)
**姊妹锚**:
- `notes/dod-self-check-list.md` v4.3 (16 项 canonical 累积)
- `notes/lesson-17-cross-agent-amend-preflight.md` v1 (§17 SOP 4-step + 5-step fail-safe · 9 例事实链 pin · 7-owner co-owned closure landed 2026-07-09 01:08 CST)
- `notes/lesson-16-package-lock-full-regen.md` v1.0 seal (§16 package.json delta lock 同步)

**版本历史**:
- v1.0-v3 · 5 项主自检累积 (Layer-Separation / 权威锚 / test 后缀 / Independence / test runner)
- v3.1 · +9th Task/Option premise pre-flight verify SOP (Task #32 stale 揭首入 · 教训 #12 反向应用五例同族)
- v4.1 · 教训 #12 反向应用第七例 landed (PR #95 doc 层独立承接首入) · 五种场景全覆盖矩阵 formalize
- v4.2 (15 项) · +第 14 项 (多 stage verify · 教训 #16 反例第九例 formalize) + 第 15 项 (test 层 grep 铁律)
- v4.3 (16 项) · +第 16 项 (package.json delta lock 同步 · lesson-16 v1.0 seal · 5-owner co-owned closure)
- **v4.4 (17 项 · 本版)** · +**第 17 项** (跨 agent shared repo `git commit --amend` pre-flight verify · lesson-17 v1 · 7-owner co-owned closure · 9 例事实链 pin)

---

## 每 PR 副签 pre-flight self-check (17 项)

以下 17 项 · **任一未通过 = BLOCK · 不 CREATE / amend / push** · exempt 通道见各项细则。

---

### 第 1 项 · 跨层命名核对 (§Layer-Separation)

- §Q7 satellite 5-slot (us_driver / history_response / quality_proxy / intraday_momentum / news_evidence) ≠ core.factors 5-factor (Momentum / Value / Quality / Size / LowVol)
- 起草前必核: 本 test / doc 引的是哪层? 是否有跨层命名交集?

### 第 2 项 · 权威锚 vs 引用锚区分

- 主权威锚 (owner 起草位) vs 副权威锚 (跨引用位) 明写
- 起草前必列: 本 test 权威锚 = 谁? 我是主签 or 副签?

### 第 3 项 · 跨栈 test 后缀 (`.py` vs `.test.ts`)

- `backend/tests/**/*.test.ts` (TS) · `scripts/tests/**/*.py` (Python)
- 每次 doc 提 test 文件名前必核: 该 stack 是 TS 还是 Python?

### 第 4 项 · 独立性红线

- 参考项目 (a-share-us-catalyst) 无 LICENSE · msg=656c8cf4 政策放宽 · 保留独立性 red line v1.1
- v1.1 §Independence-Flexibility-Footnote 3 档 (字面 ≥30% ❌ / 最小改造 <30% ✅ / 借鉴思想 ✅)
- 起草前必核: 是否引 production module? 是否含 fixture 教具边界越位?

### 第 5 项 · Test Runner 范式对齐 (v1.3)

**5.a · grep 项目 runner** (起草 test 前必跑):

```bash
cd backend && grep -l "@jest/globals" tests -r | wc -l   # 期望 = 0
cd backend && grep -l "node:assert" tests -r | wc -l     # 期望 >> 0 (项目标准)
```

**5.b · 参考同域 landed test 语法** (每域 grep 1 个 template):

- `tests/quant/marketLimits.test.ts` (IIFE + node:assert · 参考实现 1)
- `tests/quant/quant_open_watchdog_archived_zero.test.ts` (IIFE + fake module + assert · 参考实现 2)
- `tests/metrics/prometheus-registry.test.ts` (IIFE + 复杂 mock · 参考实现 3)

**5.c · 本地 verify exit=0** (起草即跑 · 不 land 未跑测):

```bash
cd backend && npx ts-node --transpile-only tests/quality/<file>.test.ts
echo $?  # 期望 = 0
```

### 第 6 项 · 教训 #7 公式 4 例复核 (K1/K2 独立数字口径)

**公式**: `Post raw = Base raw - K1 + K2`

- **K1** = 本 PR 从 baseline 移除的 entries 数
- **K2** = 本 PR 新增到 baseline 的 entries 数 (JSDoc 承接位 test scanner 剔除 · 不入 baseline entries)
- **K2 语义锁死**: JSDoc 内含 `Math.random` 字符 → 不入 baseline entries · 仅入 baseline JSON `grep_pattern_ast_aligned_note` 字段说明

### 第 7 项 · baseline SHA-lock rename 集中承接范式 (教训 #9)

baseline JSON 文件名内嵌 SHA-lock (e.g., `us-038-baseline-<sha>.json`) · rename 延至 grand-close (最末位 PR) 一次性 executed · 中间 PR 保留原文件名 + 只更新内容 field · 详见 `notes/lesson-9-baseline-filename-lock.md`

### 第 8 项 · broadcast 观测偏差 (教训 #11 · QADocs 副签侧防御)

**收到 owner broadcast 后必跑**:

```bash
# S1 · 校对 owner broadcast SHA
gh pr view <N> --json state,mergeCommit,statusCheckRollup
# S2 · 校对 main head SHA
git fetch origin main && git rev-parse origin/main
# S3 · flush inbox (再看是否有 owner 事实更新)
raft message check
```

**QADocs 独立数字口径**: 副签 broadcast 不 copy owner broadcast 数字 (K1/K2 独立算 · 4-way cross-check 依赖)

### 第 9 项 · Task/Option premise pre-flight verify SOP (v3.1 · 教训 #12 反向应用五例同族)

**任何 v1.1 追增队列 backlog task 起手前 + 任何 PR 副签起草前必跑 4 步** (30-sec cost):

```bash
# S1 · premise 关键文件存在 verify
ls -la <premise 所述文件路径>
# S2 · premise 语义 grep verify (是否已 landed)
grep -n "<premise 关键 flag>" <相关文件>
# S3 · git log 追溯 (是否已早 landed)
git log --oneline --all -S "<premise 关键 flag>" -- <相关文件>
# S4 · 若 S1-S3 揭 premise stale · 立即撤销 · 换其他 Option · zero 执行浪费
```

**触发事件锚**: Task #32 撤销 (Orch msg=16bbcd6f Option 2 → QADocs msg=ceb5150a · CI wire 早 landed = US-069 `ac87425` + US-131 `dd34489`)

### 第 10-13 项 · 反向应用 A 群 + SOP v1 事实链 + zero 凭证 + zero server touch

- **第 10 项** 教训 #12 反向应用 (contract vs code truth 五源 zero drift verify)
- **第 11 项** SOP v1 事实链 pin (工作流 + broadcast + 承接锚)
- **第 12 项** 凭证纪律 (public channel zero literal · `sk_agent_<redacted>` / `sk_machine_<redacted>` shape · workspace file 内 zero credential)
- **第 13 项** zero server touch (DB / prod / SSH · owner 明示 authorize 场景外禁触碰)

### 第 14 项 · 多 stage verify 铁律 (S0.5 · v4.2)

任何 code touch PR pre-CREATE 必跑 3 stage 双证:

```bash
# Stage 1 · tsc 编译 verify (src/ only)
cd backend && npx tsc --noEmit
# Stage 2 · runtime test discovery verify (tests/ walk)
cd backend && npx ts-node --transpile-only src/scripts/run-tests.ts
# Stage 3 · 全域 grep
grep -rn "<key symbol>" backend/src backend/tests frontend/src
```

**Why**: tsc 只编 src/ · 不加载 tests/ · npm test runtime discovery 才走 tests/ auto-walk (`run-tests.ts:64`) · verify stage 时间 scope 单 stage 不足

**反例锚**: PR #97 R2-A `production-bridges.ts` delete 初判 · tsc pass · 未覆盖 tests/ · CI RED · QADocs 首入 override

### 第 15 项 · test 层 grep 铁律 (S0.6 · v4.2)

任何 workspace draft / pre-CREATE grep 必包含 `backend/tests/**` (五档全 grep 空间 scope):

- `backend/src/**`
- **`backend/tests/**`** ⭐ (第 15 项追增 · 必含)
- `frontend/src/**`
- `scripts/**`
- `docs/**`

**Why**: workspace judge 只查 src 层 · 未查 tests 层 · 会漏 import 依赖 · 属"workspace judge 空间 scope 不足"漂移

### 第 16 项 · package.json delta lock 同步铁律 (S0.7 · v4.3 · lesson-16 v1.0 seal)

任何 code touch PR 若涉及 `package.json` dependencies delta (add / remove / version bump) · pre-CREATE 必执行:

1. `cd <frontend|backend> && rm -rf node_modules package-lock.json` (可选 scorched-earth) OR `npm install` full-regen
2. `git add package.json package-lock.json` — **双文件并入 · zero one-side push**
3. `npm ci --frozen-lockfile` 本地二次 verify (CI parity)
4. commit + push · CI `npm ci` job 走 gate 位

**Why**: `package.json` 依赖 delta 若不同步 `package-lock.json` · CI `npm ci --frozen-lockfile` 会因 lock mismatch immediate hard-fail

**反例锚**: PR #102 R2-B (Cleanup) · `frontend/package.json` -1 dep (react-query) · 首入 push 未 regen lock · CI `npm ci` RED · Cleanup lesson-16 v0.1 4-step SOP push landed @ `42d6d0d6` (lock 240+/155- full-regen)

**Ownership · 5-owner co-owned closure**: Cleanup (起源) + Research (§S3.4 副签发现) + Orch (formalize) + QADocs (承接) + Strategy/DP/Frontend (endorse)

**姊妹锚**: `notes/lesson-16-package-lock-full-regen.md` v1.0 seal

---

### 第 17 项 · 跨 agent shared repo `git commit --amend` pre-flight verify (v4.4 · 强制) ⭐

**触发场景** (任一命中即适用):

- (a) 任何 code / doc / test / config 文件 touch 后 `git commit --amend` 前
- (b) 任何 PR CREATE 前的 `git add` + `git commit` 序列
- (c) 任何 `git push --force-with-lease` / `git push -f` 前
- (d) 多 agent 共用主 repo (`/Users/bytedance/go/src/github.com/bruinxz/stocks`) 并发写场景

#### §17.1 · SOP 4-step canonical pre-flight

**Step 1 · `git status --short` pre-amend**

```bash
git status --short
```

- 断言 output **仅含自身预期 task scope file** (`M `/`A `/`??` 各行必须与当前 task scope 一致)
- 若含 task scope 外 file (unstaged 或 untracked) → **STOP · 不 amend · 转 Step 2**
- 特别注意: 多 agent 共用主 repo · 单 agent 独占 worktree 假设**失效**

**Step 2 · 精确 unstage / stash others**

```bash
# 已 staged 的他 agent file (index 内 · 最常见路径)
git reset HEAD <path-1> <path-2> ...
# working tree 内他 agent unstaged file (通常无需处理 · amend 不动 unstaged · 但为保险)
git stash push -m "concurrent-agent-wip-<timestamp>" -- <path-1> <path-2> ...
```

**禁用**: `git add .` / `git add -A` / `git commit -am` 全量 staging (会把 concurrent agent WIP file 意外 sweep 入 index)

**Step 3 · `git diff --cached --stat` verify**

```bash
git diff --cached --stat
```

- 断言 stat output **仅含自身 task scope file** · 数量 + path 100% 匹配当前 task
- 若含他 agent file → STOP · 回 Step 2

**Step 4 · 优先新 commit over `--amend`**

```bash
# 强烈推荐: 新 commit (可回滚 · zero history rewrite · zero force-push 风险)
git commit -m "..."

# 仅当以下四条件全 pass 时允 --amend:
#   (i) 单 commit micro-refactor
#   (ii) 未 push
#   (iii) Step 1-3 全 pass
#   (iv) 无 concurrent agent 迹象
git commit --amend --no-edit  # (谨慎)
```

#### §17.2 · Fail-safe recovery 5-step (若 amend 已把他 agent file 混入)

```bash
# Step 1 · soft reset 撤 commit (保 index + working tree · zero discard)
git reset --soft HEAD^

# Step 2 · 精确 unstage 他 agent file (zero discard · 保留 working tree)
git reset HEAD <other-agent-file-1> <other-agent-file-2> ...

# Step 3 · verify index clean (仅剩自己的 file)
git status --short

# Step 4 · verify stat (仅自己 scope)
git diff --cached --stat

# Step 5 · 新 commit + force-push (with-lease 保护)
git commit -m "<clean-scope-message>"
git push --force-with-lease origin <branch>
```

**Fail-safe 事实链 pin**: PR #101 fresh commit `1cf580c` clean 2-file 247-line landing · CI 5/5 GREEN · admin squash merge `81bc018b` @ 十六 (十一连胜第 16 例)

#### §17.3 · Exempt 通道 (窄门)

允例外场景 (owner + Orch 双签授权 · PR body trailer `[dod-17-exempt: <slug>]`):

- (a) 独立 branch · zero shared repo touch (worktree isolation confirmed via `git rev-parse --show-toplevel` verify)
- (b) 单 agent 独占时间窗 (Orch broadcast 明确 stand-down 其他 agents 前置)
- (c) Emergency hotfix (owner ping direct + Orch immediate override)

exempt slug 登记至 `docs/refactor/baseline/quality/dod-17-exempt-<sha>.json` · entries 内含 slug / branch / reason / approved_by / approved_at / revoke_condition

#### §17.4 · 9 例事实链 pin (v1 formalize threshold pass)

| # | example | pattern | anchor |
|---|---|---|---|
| 1 | QADocs msg=e130e261 dod v4.3 §16 v1.0 seal | 治理层 SOP evolve · zero cross-agent repo amend | msg=e130e261 |
| 2 | DP Path C.3 workspace v0.1 | 独立起草 · code path landing 前 workspace prep | msg=eb9cc0e8 |
| 3 | Strategy Path ρ workspace (v1.1 shadow_evidence_detail) | 独立起草 · contract minor bump 前 workspace prep | Strategy Path ρ msg |
| 4 | Strategy Path τ workspace (§Q7.10.5 contract minor bump) | 独立起草 · contract minor bump 前 workspace prep | Strategy Path τ msg |
| 5 | Strategy Path υ workspace (walk-forward v0 baseline JSON schema) | 独立起草 · walk-forward v0 前 workspace prep | msg=6af38104 |
| 6 | Strategy Path χ workspace (satellite 4-slot v0 baseline) | 独立起草 · Task #12 v2 承接 baseline 前 workspace prep | msg=9a9b40c8 |
| 7 | Frontend Path ψ workspace (factorService audit) | 独立起草 · audit-only zero-touch | msg=bca47f46 |
| 8 | Orch aggregate v15+v16+v17+v18+v19+v20+v21 (7 aggregate broadcast 累计) | 治理层 broadcast 独立 · owner-review pre-grant 免签窗口 landed pattern | 7 broadcast msg |
| 9 | Frontend Path AA workspace `explain-card.schema.ts` Zod v1 baseline | 独立起草 · Phase 3 Zod runtime 前置件 workspace prep | msg=ff1453fe |

**7-owner co-owned closure landed**: QADocs (起源) + Orch (formalize dispatch v18/v19/v20/v21) + Cleanup (lesson-16 姊妹) + DP (Path C.3 pattern) + Strategy (Path ρ/τ/υ/χ 4 例) + Frontend (Path ψ + AA 2 例) + Research (msg=ab81dc08/24cb074e endorse)

**姊妹锚**: `notes/lesson-17-cross-agent-amend-preflight.md` v1 (formalize landed 2026-07-09 01:08 CST)

---

## 附录 A · v4.3 → v4.4 delta summary

| 项 | v4.3 (16 项) | v4.4 (17 项 · 本版) |
|---|---|---|
| 项数 | 16 项 (§1-§16) | **17 项 (§1-§17)** |
| 治理层触点 | code / test / doc / lint 层 | **§17 首入 git 操作层 pre-flight verify** (Layer independence extension) |
| Ownership 模型 | §16 5-owner co-owned closure (Cleanup 起源) | **§17 7-owner co-owned closure** (QADocs 起源 · 全域 endorse) |
| SOP 位阶 | §16 pre-CREATE code touch 层 | **§17 pre-amend / pre-commit git 操作层 · 强制适用所有 agents** |

## 附录 B · exempt 通道汇总

| §  | exempt trailer syntax | authority required | 登记位 |
|---|---|---|---|
| §16 | `[dod-16-exempt: <slug>]` | owner + Orch | (未强制登记 · 事件锚 pin lesson-16 v1.0 seal) |
| **§17** | `[dod-17-exempt: <slug>]` | owner + Orch | `docs/refactor/baseline/quality/dod-17-exempt-<sha>.json` |

---

**Cross-refs**:

- `notes/dod-self-check-list.md` v4.3 (16 项 canonical 累积 · 详细 sub-item 应用矩阵)
- `notes/lesson-16-package-lock-full-regen.md` v1.0 seal (§16 canonical)
- `notes/lesson-17-cross-agent-amend-preflight.md` v1 (§17 canonical · 9 例事实链 + 7-owner co-owned closure)
- `docs/refactor/40-quality-gates.md` (质量门禁全景)
- `docs/refactor/quality/qadocs-l2-hard-fail-sop.md` (§API-Contract L2 verb hard-fail SOP)
- `docs/refactor/adr/0010-api-versioning-strategy.md` (API Versioning · L3 route path 命名 + L7 X-API-Version header)

**v4.4 formalize landed** · 17 项 self-check pre-flight canonical · 强制适用所有 agents · exempt 通道窄门开放 (owner + Orch 双签授权)
