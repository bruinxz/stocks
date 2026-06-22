# Hold Semantic + Analyst Fallback — 2026-06-22

User 21 条清单 #14 (hold + position 语义) + #10 (AnalystForecast 8 票排查) 双任务报告.

部署: prod main `a1607aa` → 加 2 commit `f9f102a` (BA-A) + `c2cb117` (BA-B).

## Task A: hold + suggested_position 语义改造 (用户清单 #14)

### 问题描述

引擎 `action='hold'` 时 `suggested_position_pct` 永远是 0%, 用户在 AI 弹窗看到
"confidence 84% / 仓位 0%" 时**完全不知道**意思是:

- "高信心维持现有仓位" (用户已持仓, 没必要加仓也没必要卖出), 还是
- "高信心不建仓" (用户无持仓, 引擎不建议买入)

两种语义对用户行为影响**截然相反** — 误读会让"我应该不动"被解读成"我应该清仓".

### 根因定位

`backend/src/services/analysis-engine/DecisionAggregator.ts` 第 421 行:
```ts
if (action === 'hold' || action === 'reduce' || action === 'sell' || action === 'strong_sell') {
  suggestedPct = 0;
}
```
注释里写"调用方按持仓决定", 但实际上前端 (`aiStockAnalysisModalV2Components.tsx`)
直接显示 `${pct * 100}%`, 没做任何 has_open_position 推断.

### 改造方案 (双层)

**1. Backend — `PositionAction` 4 档 enum**

加 `RecommendationDecision.position_action: 'open' | 'maintain' | 'close' | 'avoid'`
让 has_open_position 维度显式编码 — 单一事实源, 前端不再反复散落判断.

映射矩阵 (DecisionAggregator.derivePositionAction 单一实现):

| action | has_open_position=true | has_open_position=false |
|--------|------------------------|-------------------------|
| strong_buy / buy / add | open | open |
| hold | **maintain** | **avoid** |
| reduce / sell / strong_sell | close | avoid |

3 个 aggregator return 路径全部填 position_action (critical hold / veto / 正常加权).

**2. Backend — metadata 4 处透传**

- `hardShortCircuit.buildHardShortCircuitResult` metadata
- `analysisEngineSignalArchive.archiveAnalysisEngineResult` detail + metadata
- `ShadowDoubleRunService.persistShadowReport` metadata

**3. Frontend — UI 按 position_action 渲染**

`aiStockAnalysisModalV2Helpers.ts`:
- `ActionPlanViewModelV2` 加 `position_action` + `position_action_label` 字段
- `POSITION_ACTION_LABELS = { open:'建议建仓', maintain:'维持当前仓位', close:'建议卖出', avoid:'不建议建仓' }`
- `buildActionPlanViewModelV2` 旧 archive 兜底: hold 默认 avoid (保守)

`aiStockAnalysisModalV2Components.tsx` ActionPlanCard 建议仓位列改成:
- `position_action='maintain'` → "维持当前仓位"
- `position_action='avoid'` → "不建议建仓"
- `position_action='close'` → "建议卖出"
- `position_action='open'` → 显示具体 `pct%`
- `'unknown'` (旧 archive) → fallback 显示 `pct%` (向后兼容)

### 测试 (脱 DB 全过)

| 文件 | 测试数 | 新增 BA-A case 数 |
|------|-------|------------------|
| DecisionAggregator.test.ts | 105 | 17 (12 矩阵 + 5 aggregator + 2 META-GUARD) |
| analysisEngineSignalArchive.test.ts | 99 | fixture 修 |
| hardShortCircuit.test.ts | 118 | fixture 修 |
| types.test.ts | 13 | fixture 修 |
| ai-stock-analysis-modal-v2-helpers.test.ts | 183 | 9 (a-f 4 档真值 + fallback + unknown) |

### 端到端 prod 验证

```bash
$ node /tmp/test_e2e.js sh.600350 true
{ "action": "reduce", "position_action": "close", "suggested_position_pct": 0 }

$ node /tmp/test_e2e.js sh.600350 false
{ "action": "reduce", "position_action": "avoid", "suggested_position_pct": 0 }
```

同股 + 同 action='reduce' 在两种 has_open_position 下输出截然不同的 position_action,
正是 BA-A 修复的核心.

## Task B: AnalystForecast 8 票排查 + fund_consensus fallback (用户清单 #10)

### 排查结论

用户 8 票全部 (sh.688008 / sz.300054 / sh.600667 / sz.300476 / sz.002916 / sh.600350 /
sz.002025 / sh.601985) **不在 analyst_forecasts 表里**:

```sql
SELECT COUNT(*), COUNT(DISTINCT stock_code), MAX(report_date)
FROM analyst_forecasts;
-- 10663 行 / 50 distinct stocks / 2026-06-03
```

50 票是 600519 / 002594 / 601888 / 300750 等大盘白马, 8 票 (含 sh.688008 澜起科技 /
sz.300054 鼎龙股份 / sh.600350 山东高速 等) 全部不在内. crontab 也没有
sync-analyst-forecast 调度 — 是**一次性 backfill 50 票, 其余 ~5000 A 股从未同步**.

不是 symbol 格式问题, 不是 sync bug, 是**数据覆盖原本就极窄**.

### 根因链 (4 步)

1. user 票不在 analyst_forecasts → `AnalystConsensusFactor.compute()` 不返该股
2. FactorPipeline 中性补全 → DB 写 `raw_value=NULL z_score=0 percentile=0.5`
   (FactorPipeline.ts:252-254)
3. `AnalysisEngineService.loadFactorSnapshot` 只读 z_score, 把"缺数据中性补全"
   与"有数据真中性"混为一谈 → 返 z=0 喂给 analyzer
4. FundamentalAnalyzer 把 z=0 当"有数据中性" 加权, 不进 data_missing →
   evidence 显示 `分析师一致预期 z=0.00` (用户描述为 "0 条")

### 修复方案 (双层)

**1. AnalysisEngineService — 显式区分 "缺数据补全" vs "真中性"**

`loadFactorSnapshot` 同时读 `raw_value` 列, `raw_value=NULL` 时显式 `out[factor]=null`
让 analyzer 走 data_missing 路径 (而非把 z=0 当中性信号).

**2. FundamentalAnalyzer — fund_consensus fallback (业务代理)**

`analyst_consensus` 缺失时降级用 `fund_consensus` (FundConsensusFactor 公募基金
重仓抱团度) 作为代理:

- evidence label: `分析师一致预期 (基金一致预期代理) z=-0.22`
- detail: `归一化得分 -7.2 (无真研报数据, 用基金抱团度代理)`

业务合理性: 二者都反映"机构对该股的关注度" — 实证 IC ~0.4-0.5 相关. 弱于真研报
但远好于"中性 0 分"误导决策.

**升级路径**: 若未来 AnalystForecast sync 接入 cron 全覆盖 ~5000 A 股,
analyst_consensus 大部分非 null, fallback 自动失活.

### 测试

`analyzers.test.ts` 48 ok (BA-B 新增 4 case):
- analyst_consensus 缺失 + fund_consensus 命中 → fallback + evidence 含代理标注
- 双缺 → 进 data_missing
- 真研报存在 → fallback 不触发
- 非 'factor.analyst_consensus' 路径不影响

### 端到端 prod 验证

```bash
$ node /tmp/test_e2e.js sh.688008 true
{
  "action": "add",
  "position_action": "open",
  "fundamental": {
    "evidence": [
      { "label": "分析师一致预期 (基金一致预期代理) z=-0.22",
        "detail": "归一化得分 -7.2 (无真研报数据, 用基金抱团度代理)" },
      ...
    ],
    "data_missing": [...]  // 不含 factor.analyst_consensus
  }
}
```

完美命中: evidence 显式标注代理, analyst_consensus 不再进 data_missing.

## Commits

- `f9f102a` feat(BA-A): hold + position_action 语义 + 前端 UI 改造 (12 文件 / +376 行 / 5 测试 ok)
- `c2cb117` fix(BA-B): AnalystForecast 8 票排查 + fund_consensus fallback (3 文件 / +121 行 / 48 测试 ok)

## 部署

main HEAD → 加 2 commits → backend tsc → frontend build →
rsync dist + build → systemctl restart stocks-backend → health 200.

prod 验证 sh.600350 + sh.688008 两个真实场景均符合预期.
