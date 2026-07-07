# 策略契约（contracts/strategy）

**版本**：v0（M0 骨架）
**Owner**：Orchestrator（吸收 Strategy 输入）
**上位规范**：`../adr/0001-layering-and-collab.md` §10 现有强约束条款 + §11 Strategy 3 条方案期红线
**冻结依赖**：`contracts/data.md` v1 冻结后

---

## 1. 现有强约束条款（10 条，全项目通用）

见 `../adr/0001-layering-and-collab.md` §10：

1. **5 个 public facade 单例**：`strategyEngine / signalEngine / backtestEngine / performanceReporter / quantHealthMonitor`（禁新增第 6 个）
2. **回测 7 关 P0**：策略上线必过 6/7（成本后年化 ≥10% / CSCV·PBO<0.5 / walk-forward / 参数扰动 / OOS 12月 / regime分层 / 成本翻倍压力）
3. **因子内部规范**：禁 winsorize/zscore（Pipeline 统一做）+ 稀疏 Map + 一因子一文件
4. **DataSource DI 六范式**：`BacktestRunner / RegimeSource / TradeReturnSource / StrategyReturnSource / BenchmarkReturnSource / IndustryDataSource`（脱 DB）
5. **`SeededRandom` 强制、`Math.random()` 禁用**（US-038）
6. **组合策略 caller-prefetch 契约**
7. **信号 confidence = 90 天真实胜率**（禁投票+规则打分）
8. **因子权重锚 §11.1**：Value 0.40 / Quality 0.30 / LowVol 0.30 / Momentum 0.0 (shadow)
9. **不发手机 push（C-7），飞书允许**；产品文案禁绝对收益承诺
10. **远端配置走 env**（禁硬编码 IP）

---

## 2. 方案期 3 红线（li-yiming 默认全允）

1. **不推翻 signals-first 架构与 §11.1 权重**（除非参考项目 catalyst 展现"可回测 + 成本后年化 ≥ 10%"显著优势）
2. **不复现 QuantFusionService 模式**（95 笔 0% 实盘证伪）
3. **AI/tradingagents 保持 vendoring 独立进程**

---

## 3. 荐股策略接口签名（v0 待 Strategy 出交付物 B 时填充）

### 3.1 因子读取
```
factor.read(symbol, factor_name, as_of_date=None)
```
- 默认签名 = `contracts/data.md` §4
- 稀疏 Map 返回；缺失值三态语义 = `contracts/data.md` §2

### 3.2 信号生成
```
signal.generate(as_of_date, universe) -> List[Signal]
```
Signal 结构：
- `symbol / signal_type / direction`
- `confidence`（90 天真实胜率 Wilson 下界，非规则打分）
- `factor_snapshot`（可解释性三同）
- `available_at`（PIT 门禁）

### 3.3 回测入口
```
backtestEngine.run(strategy, start, end, seed, cost_model)
```
- 强制 `SeededRandom(seed)` → 结果可复现
- `cost_model` 必须（费率 + 滑点 + A 股约束）
- 输出通过 7 关 P0 硬约束

### 3.4 caller-prefetch
`generateSignals(date)` 由 caller 预取信号；否则退化 hold（US-038 anti-pattern）

---

## 4. 保护清单策略段（→ `contracts/protect.md`）

Strategy 提议 17 条 glob（见 `notes/existing-conventions.md`）；采纳到 `contracts/protect.md` v0：
- `backend/src/{quant,backtest,portfolio,metrics}/**`
- `backend/src/services/{factor,analysis-engine,regime,attribution}/**`
- `backend/src/models/`（策略类）
- `backend/tests/{factor,factors,backtest,quant,strategies}/**`
- `backend/tests/**/*real*`
- `ai/tradingagents-app/**`
- `docs/SIGNAL_FIRST_PLAN.md`（若存在）
- `docs/PROJECT_COMPASS.md`（若存在）

**4 项核心资产特护**（PR-L 例外通道）：
- momentum_reversal 策略
- AShareConstraintEngine
- FactorRegistry + Pipeline
- 权重锚 §11.1

---

## 5. QA 契约级校验位（对齐 ADR-0001 §9）

7. 回测 7 关 P0 硬约束 → QADocs `adr/0003-backtest-7-gates.md`
8. `Math.random()` 全项目禁用（US-038）→ QADocs `adr/0002-us-038-math-random-ban.md`

（其他 1-6 见 `contracts/data.md` §11）

---

## 6. v1 冻结前 TODO（Strategy 主控）

- [ ] 因子体系 v0（`library/` 结构 + Registry + Pipeline）
- [ ] 信号体系 v0（Signal v3 + 三 ID + Gate 4 层）
- [ ] 选股架构 v0（核心 70% / 卫星 20% / 现金 10%）
- [ ] 融合决策表策略/因子/回测行（等 Research 参考项目通读）
- [ ] Open Questions 6 条（待 Orchestrator 裁）

---

---

## §Q7 · 卫星层双态权重表

### §Q7.1 5-slot 主态权重（决策 3 = A · Alpha Vantage 主链 · `ENABLE_US_DRIVER_SIGNAL=true`）

| # | slot | 权重 | 语义 | 数据源 |
|---|------|------|------|--------|
| 1 | `us_driver` | **0.30** | US 主题龙头传导信号 | Alpha Vantage 5 输入（us_theme_leader_return_5d/20d/guidance_beat/us_theme_index_regime/vix_risk_regime） |
| 2 | `history_response` | **0.25** | A 股历史响应度 | 内部因子引擎（daily_bars 派生） |
| 3 | `quality_proxy` | **0.15** | 质量代理 | `fundamental_pit` (Baostock) |
| 4 | `intraday_momentum` | **0.15** | 日内动量 | daily_bars 派生（IntradayMomentumDetector） |
| 5 | `news_evidence` | **0.15** | 新闻/公告证据链 | Announcement + DragonTiger + MoneyFlow |

**权重和 = 1.000** · Risk 层乘性衰减 0.5-1.0（VIX 分箱 · §Q7.4 gate）

### §Q7.2 4-slot 回落态权重（US 数据源缺位态 · `ENABLE_US_DRIVER_SIGNAL=false`）

归一化公式：`w_i = w_i_original / (1 - w_us_driver) = w_i_original / 0.70`

| # | slot | 权重（精算） | 派生 |
|---|------|-------------|------|
| 1 | `history_response` | **0.357** | 0.25 / 0.70 = 0.357142... |
| 2 | `quality_proxy` | **0.214** | 0.15 / 0.70 = 0.214285... |
| 3 | `intraday_momentum` | **0.214** | 0.15 / 0.70 = 0.214285... |
| 4 | `news_evidence` | **0.215** | 0.15 / 0.70 = 0.214285... + Rounding tie-break +0.001 |

**权重和 = 1.000** · Rounding tie-break 位落在 news_evidence（详见 ADR-0001 §附录 §Rounding-Tie-Break）

### §Q7.3 Rounding tie-break 规则

**规则**：4-slot 精算后若三值相等（0.214/0.214/0.214）· 尾差 +0.001 补偿位落在 `news_evidence` slot

**理由**：news_evidence slot 三方证据链融合位（Announcement/DragonTiger/MoneyFlow）· 尾差不影响 signal 权重排序 · UX 感知无差异 · 语义呼应"证据补足"

**权威锚**：ADR-0001 §附录 §Rounding-Tie-Break（Orchestrator msg=646f9c2a 定稿）· QADocs Task #15 断言 C

### §Q7.4 切换开关 `ENABLE_US_DRIVER_SIGNAL` 双态互斥

```typescript
export const ENABLE_US_DRIVER_SIGNAL: boolean =
  process.env.ENABLE_US_DRIVER_SIGNAL === 'true'
  && US_DRIVER_SOURCE_HEALTHY  // Alpha Vantage 24h 内失败 < 3 次 gate

export function selectSatelliteWeights(): SatelliteWeightScheme {
  if (ENABLE_US_DRIVER_SIGNAL) {
    return SATELLITE_WEIGHT_5_SLOT  // §Q7.1
  } else {
    return SATELLITE_WEIGHT_4_SLOT_RENORMALIZED  // §Q7.2
  }
}
```

**双态互斥语义**：
- ✅ 双态**并存于代码 · 运行时二选一**（非同时激活）
- ✅ 状态切换 gate = `US_DRIVER_SOURCE_HEALTHY`
- ✅ 状态切换触发 `us_driver_source_unavailable_watch` 词表 slug（§Q8）

### §Q7.5 US Tickers v0 名单（10 项 · Alpha Vantage daily budget 60%）

**指数 / ETF（5 项）**：SPX / NDX / SPY / QQQ / VIX
**核心美股（5 项）**：NVDA / TSLA / AAPL / AMD / MSFT

**daily budget 核算**：
- 10 baseline + 5 event req = 15 req/day
- Alpha Vantage 免费 tier 25 req/day
- 消耗 60% · 剩余 40% buffer

### §Q7.6 A 股主题 → US 锚 symbol 映射（6 条 · v0 硬编码 · v1 走 `theme_us_anchor_map.ts`）

| A 股主题 (theme_id) | US 锚 symbol | 主指数 |
|--------------------|--------------|--------|
| 半导体 / AI 算力 | NVDA + AMD | NDX |
| 新能源汽车 / 锂电 | TSLA | NDX |
| 苹果链 | AAPL | NDX |
| 云 / AI 应用 | MSFT | NDX |
| 大盘 β（无明确主题时） | SPY（代理 SPX） | SPX |
| 风险偏好调节 | VIX | — |

---

## §Q7-fundamental-pit · 3 字段 + 3 值枚举（v1.1 §3 E4 联动）

### 字段定义（TypeScript · `backend/src/quant/factors/types.ts`）

```ts
export type FundamentalDataSource = 'BAOSTOCK' | 'TUSHARE_PRO' | 'MERGED'

export interface FundamentalPit {
  // v1.0 已锁字段（沿用）
  code: string
  as_of: string                      // PIT 时点 (available_at ≤ t)
  report_period: string
  eps: number | null
  net_income: number | null
  revenue: number | null
  gross_margin: number | null
  total_assets: number | null
  total_liabilities: number | null

  // v1.1 §3 E4 新增字段（3 字段）
  roa: number | null                 // net_income / total_assets · Baostock 计算式
  data_source: FundamentalDataSource // v1 默认 BAOSTOCK · TUSHARE_PRO/MERGED 空 slot
  fallback_reason: string | null     // BAOSTOCK 主 = null · MERGED 记合并规则版本
}
```

### 3 值枚举语义（Orchestrator msg=767ba280 §2）

| 值 | 语义 | v1 冻结状态 | 触发条件 |
|----|------|-------------|----------|
| `BAOSTOCK` | Baostock 免费主链 · Quality 唯一源 | ✅ 默认激活 | 决策 2 = B |
| `TUSHARE_PRO` | Tushare Pro 付费主链 · 未来激活位 | ⚪ 空 slot · v1 未启用 | 未来 li-yiming 授权 · v1.x minor bump |
| `MERGED` | Baostock + Tushare Pro 双源合并 · 未来激活位 | ⚪ 空 slot · v1 未启用 | 决策 2 = C 转正 |

**minor bump 非破坏兼容规则**：
- v1 冻结时：只允许 `BAOSTOCK` 一值实际写入 · TUSHARE_PRO/MERGED 定义就位但**不激活**
- 未来切换到 A/C 路径 = 只需 minor bump（e.g. v1.1 → v1.2）· 无 schema breaking
- 对齐 10-contracts §2 版本规则：加 enum value 非破坏 · 减 value 破坏

**Frontend 不 aware**：`data_source` 是**契约层字段** · 不透传 `explain_card` UX 层（Orchestrator msg=f89e7ac0 §7 权威锁 · msg=b8b3baf4 终版澄清）

**权威 ADR**：ADR-0007 quality-factor-fallback（同批 landing）

---

## §Q8 · 词表 v1（27 slug 定稿）

**用途**：`explain_card.positive_flags[]` + `explain_card.risk_flags[]` 数组元素来源
**Owner**：Strategy + QADocs CODEOWNERS 共管（QADocs msg=1b22be22）
**CI 硬门禁**：QADocs `.jscpd.reference.json` 30% 相似度阈值（Task #15 断言 A）

### §Q8.1 positive_flag_dictionary v1（12 条）

```ts
export interface PositiveFlagEntry {
  slug: string
  category: 'fundamental' | 'money_flow' | 'policy' | 'event' | 'technical'
  source: 'fundamental_pit' | 'money_flow_pit' | 'announcement' | 'dragon_tiger' | 'northbound' | 'daily_bars'
  threshold_hint?: string
  i18n_key: string
}
```

| # | slug | category | source | i18n_key |
|---|------|----------|--------|----------|
| 1 | `earnings_beat_pit` | fundamental | fundamental_pit | `pos.earnings.beat` |
| 2 | `revenue_growth_pit` | fundamental | fundamental_pit | `pos.revenue.growth` |
| 3 | `margin_expansion_pit` | fundamental | fundamental_pit | `pos.margin.expand` |
| 4 | `northbound_net_buy` | money_flow | northbound | `pos.northbound.inflow` |
| 5 | `dragon_tiger_institutional` | money_flow | dragon_tiger | `pos.dragon.institutional` |
| 6 | `main_capital_inflow` | money_flow | money_flow_pit | `pos.capital.main.inflow` |
| 7 | `policy_tailwind_pit` | policy | announcement | `pos.policy.tailwind` |
| 8 | `industry_upcycle_pit` | policy | announcement | `pos.industry.upcycle` |
| 9 | `contract_win_disclosure` | event | announcement | `pos.contract.win` |
| 10 | `share_buyback_launched` | event | announcement | `pos.buyback.launched` |
| 11 | `insider_net_buy` | event | announcement | `pos.insider.buy` |
| 12 | `gradual_breakout` | technical | daily_bars | `pos.breakout.gradual` |

### §Q8.2 risk_flag_dictionary v1（14 条 + v1.1 追增 1 = 15 条）

```ts
export interface RiskFlagEntry {
  slug: string
  category: 'compliance' | 'liquidity' | 'concentration' | 'drawdown' | 'fundamental_deterioration' | 'policy_risk'
  source: 'fundamental_pit' | 'money_flow_pit' | 'announcement' | 'daily_bars' | 'gate_state'
  gate_layer_hint?: 'L1' | 'L2' | 'L3' | 'L4'
  threshold_hint?: string
  i18n_key: string
}
```

| # | slug | category | source | gate | i18n_key |
|---|------|----------|--------|------|----------|
| 1 | `st_designation` | compliance | announcement | L1 | `risk.st.designation` |
| 2 | `suspension_trading` | liquidity | gate_state | L1 | `risk.suspension.trading` |
| 3 | `new_listing_180d` | liquidity | gate_state | L1 | `risk.listing.new` |
| 4 | `low_liquidity_20m` | liquidity | daily_bars | L1 | `risk.liquidity.low` |
| 5 | `rolling_loss_5pct` | drawdown | gate_state | L2 | `risk.drawdown.rolling` |
| 6 | `alpha_negative_3m` | drawdown | gate_state | L2 | `risk.alpha.persistent.negative` |
| 7 | `hard_stop_loss_15pct` | drawdown | gate_state | L2 | `risk.stop.hard` |
| 8 | `soft_buffer_7pct` | drawdown | gate_state | L2 | `risk.stop.soft` |
| 9 | `pr_l_policy_shock` | policy_risk | gate_state | L2 | `risk.policy.shock` |
| 10 | `earnings_miss_pit` | fundamental_deterioration | fundamental_pit | — | `risk.earnings.miss` |
| 11 | `debt_ratio_spike` | fundamental_deterioration | fundamental_pit | — | `risk.debt.spike` |
| 12 | `main_capital_outflow` | drawdown | money_flow_pit | — | `risk.capital.main.outflow` |
| 13 | `regulatory_inquiry` | compliance | announcement | — | `risk.regulatory.inquiry` |
| 14 | `industry_downcycle_pit` | policy_risk | announcement | — | `risk.industry.downcycle` |
| 15 | `us_driver_source_unavailable_watch` | policy_risk | gate_state | L2 | `risk.us_driver.unavailable` |

**v1.1 追增（第 15 项）**：`us_driver_source_unavailable_watch`（US 数据源缺位 · §Q7.4 切态触发）

**移除项**：`quality_data_fallback_baostock`（原提议 · 决策 2 = B 后 Baostock 主链非 fallback · slug 命名前提不成立 · Orchestrator msg=b8b3baf4 终版裁决）

### §Q8.3 独立性声明

- 词条源自我方业务场景（A 股 · ETF 因子轮动 + 卫星层题材/事件驱动）
- 5-6 字段结构差异化 · 与参考项目扁平字符串数组结构不同
- Research 22 §E1-E5 我方历史零 catalyst 词表命中（0/5）· §E7 5 因子魔数联合 grep 零命中
- jscpd 30% 命中评估：预计相似度 < 5%（远低于阈值）

### §Q8.4 落地位

- `backend/src/quant/explain/dictionaries/positive_flag_dictionary.ts`
- `backend/src/quant/explain/dictionaries/risk_flag_dictionary.ts`
- `backend/src/quant/explain/dictionaries/types.ts`
- `backend/src/quant/explain/dictionaries/README.md`
- CI 硬门禁 `test_word_dictionary_jscpd_threshold_30.test.ts`（QADocs Task #15）

### §Q8.5 rebuild 纪律

- 每次新增/修改词条 · ADR 说明
- CODEOWNERS Strategy + QADocs 双签
- 每词条附来源标签（数据源 + 事件类别）
- 禁引 catalyst 词典任何字面（jscpd baseline 强制）

---

## §Q7 v1 冻结 DoD

- ✅ 5-slot 主态 5 值定值
- ✅ 4-slot 回落态 4 值精算 + tie-break +0.001
- ✅ Rounding tie-break 规则锚 §Rounding-Tie-Break（ADR-0001 §附录 5th 项）
- ✅ `ENABLE_US_DRIVER_SIGNAL` 切换开关双态互斥语义
- ✅ US Tickers v0 名单 10 项 + daily budget 60% 核算
- ✅ A 股主题 → US 锚 symbol 映射 6 条
- ✅ `fundamental_pit` 3 字段 + 3 值枚举定义
- ✅ §Q8 词表 v1 = 27 slug 定稿

---

## Cross-References

- Orchestrator msg=656c8cf4 · License 政策放宽令 v1
- Orchestrator msg=767ba280 · `data_source` 3 值枚举
- Orchestrator msg=c2b28c7c · 自主推进边界令 v1
- Orchestrator msg=b8b3baf4 · Q8 slug 终版
- Orchestrator msg=646f9c2a · §Rounding-Tie-Break 权威锚
- Orchestrator msg=f89e7ac0 §7 · Frontend 不 aware
- Orchestrator msg=84fa4b84 · M-Draft 挪入终裁
- Strategy workspace 4 稿件（原 source）
- ADR-0001 §附录 6 项（同批 landing）
- ADR-0007 · quality-factor-fallback（同批 landing）
- ADR-0009 · baostock-gpl-isolation（同批 landing）
- Research 25-* · Reference Independence v1.1 3 档改造范式

---

**End of contracts/strategy.md v1 追加块**
