# EPSILON — 测试 break 收尾报告

**Agent**: EPSILON
**Worktree**: `.claude/worktrees/happy-torvalds-180c51/`
**Date**: 2026-06-19 (Beijing)
**Scope**: 修 ALPHA/BETA/DELTA 改完后遗留的测试 break，不引入新功能

---

## 最终状态

```
Total: 140 files, 140 passed, 0 failed, 189.9s elapsed
```

**全绿** — 6 个测试 break 全部修复（包括 ALPHA 清单 4 个 + 跑全测时发现的额外 2 个 DELTA 新增测试自身 bug）。

---

## 修复明细

### 1) `tests/strategies/MultiFactorAlphaStrategy.test.ts` — 同步 14 因子权重

**根因**：Batch AC (`0d71a71`) 给 MFA 加了 2 个新因子 (`industry_momentum=0.10` / `concept_heat=0.06`)，把原 12 因子整体缩放（value/quality/growth/momentum 由 0.10 → 0.084，low_vol/northbound/money_flow/dragon_tiger 由 0.08 → 0.067，quality_high/analyst_consensus 由 0.07 → 0.059，east_money_qa 由 0.06 → 0.05），sum=0.999。测试断言还停留在 12 因子旧值。

**修改**：
- `test_default_weights_match_AC`: 全部断言对齐 14 因子新权重；count 12 → 14；sum 容差 `1e-9` → `1e-2`（normalize 在使用时强制为 1.0，源里没有强制 freeze 到 1）。
- `test_composite_score_weighted_sum`: 全 z=1 composite 1.0 → ≈0.84（12/14 老因子，normalize 后）；value=2 单因子 0.20 → ≈0.168。
- `test_weight_mode_static_is_default_equiv_us011`: value=10+momentum=10 composite 2.0 → ≈1.68。
- `test_weight_mode_equal_uniform_weights`: equal mode 12 z=1 composite 1.0 → 12/14；value=12 composite 1.0 → 12/14。
- `test_weight_mode_ic_weighted_dynamic_weights`: quality/growth fallback 0.10 → 0.084；east_money_qa fallback 0.06 → 0.05。

**source 未动**。

### 2) `tests/strategies/DragonHeadMomentumStrategy.test.ts` — 同步 sentiment 阈值 60→30

**根因**：commit `00687d6` (2026-06-10) 把默认 `minMarketSentiment` 从 60 调到 30（原因：60 阈值在 47.7 的中性市场下让候选 = 0 阻塞用户），测试还在校验 60。

**修改**：
- `test_default_params_match_AC`: 60 → 30。
- `test_us082_*` 3 个测试中 fixture 情绪 45 改为 20（< 30 才能验阻塞行为）；threshold 默认值 60 → 30；fixture 描述同步。

**source 未动**。

### 3) `tests/strategies/EarningsSurpriseStrategy.test.ts` — 同步 northbound fail-OPEN

**根因**：source 已改为"北向数据缺失时 fail-OPEN"（commit 中 jsdoc 写：当全市场 northbound_holdings 表空时双确认降级为单确认，避免整条策略瘫痪），测试还在断言 "缺数据 → eligible=0 + fail_northbound_missing=1"。

**修改**：
- `test_entry_fail_northbound_missing`: 断言改为 `eligible_count=1`（仍入场）+ `fail_northbound_missing=1`（计数但不阻塞）。

**source 未动**。

### 4) `tests/services/realtime-alert-dispatcher-service.test.ts` — 同步 signature 4-tuple

**根因**：Batch X (`notif-3`) 把 `buildAlertSignature` schema 从 `<rule>::<sym>::<level>` 改为 `<rule>::<sym>::<level>::<msgHash>`，让"升级告警"（drawdown 10% → 15%）能突破 dedup。测试还在断言 3-tuple 字面量。

**修改**：
- 7 处 signature 字面量加 `::d5e0cb68` 后缀（`d5e0cb68` 是 `makeInput` 默认 message `"触发持仓上限告警"` 的 FNV-1a hash）：
  - 6 处 buildAlertSignature 纯函数断言改为 `::0`（无 message 时）；
  - 1 处 dedup signature 落库断言（test 12）；
  - 2 处 pre-seeded `seenByUser` 记录（test 13、14，需匹配新签名才能触发 dedup）；
  - 4 处 e2e signature 字段断言（test 27、28、31、33）。

**source 未动**。

### 5) `tests/quant/backtest/metrics.calmar_sortino.test.ts` — Fixture 3 mdd 断言错误（DELTA 新增）

**根因**：DELTA agent 新增测试，Fixture 3 [100k→105k→101.85k→103.887k→102.848k] 的实际 max_drawdown_pct = 3.0% (peak 105000 → trough 101850)，但断言写成 `> 2 && < 3`，严格小于让 3.0 失败。

**修改**：
- 断言改为 `>= 2.9 && <= 3.1`，注释更新："peak 105000 → trough 101850 = 3.0% exact"。

**source 未动**。

### 6) `tests/quant/factors/tradingDayWindow.test.ts` — 跨春节断言不一致（DELTA 新增）

**根因**：DELTA agent 新增测试，fixture 含 10 个交易日（02-02..06 + 02-16..20），N=5 时正确返回 `[02-16, 02-17, 02-18, 02-19, 02-20]`（最后 5 个），但断言写成 `[02-06, 02-16, 02-17, 02-18, 02-20]` —— 既不是最后 5 个（漏 02-19），也不是包含 02-06 的合理切片。是断言本身有 typo。

**修改**：
- 原 case 断言改为正确的最后 5 个：`[02-16, 02-17, 02-18, 02-19, 02-20]`。
- 新增 case "N=10 跨春节"：验证 `dates[0] === '2026-02-02'`（真实交易日历，10 个交易日前），保留 DELTA 想表达的"helper 跳过春节闭市天"的业务意图。

**source 未动**。

---

## 关键约束遵守

- ✅ 不引入新 source 功能。
- ✅ 不修改 ALPHA / BETA / GAMMA / DELTA 改过的 source 逻辑。
- ✅ 不修改 `.env*` / docker / migrations。
- ✅ 仅改 test 文件，**source 0 处改动**。
- ✅ ALPHA 报告里第 5 项 `paper_trading_limit_up_block.test.ts` 在本次全测中已正常通过且进程正常退出（15 passed / OK 4.0s）— 无需修复。

---

## 跑测命令

```bash
cd backend && npm test
# → Total: 140 files, 140 passed, 0 failed, 189.9s elapsed
```

单测单跑（确认各 fix 不互相破坏）：
```bash
npx ts-node --transpile-only tests/strategies/MultiFactorAlphaStrategy.test.ts
npx ts-node --transpile-only tests/strategies/DragonHeadMomentumStrategy.test.ts
npx ts-node --transpile-only tests/strategies/EarningsSurpriseStrategy.test.ts
npx ts-node --transpile-only tests/services/realtime-alert-dispatcher-service.test.ts
npx ts-node --transpile-only tests/quant/backtest/metrics.calmar_sortino.test.ts
npx ts-node --transpile-only tests/quant/factors/tradingDayWindow.test.ts
```

均 `Result: all passed` / `0 failed`。
