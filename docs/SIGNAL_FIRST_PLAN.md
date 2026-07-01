# 信号优先重构计划 (Signal-First Plan)

> 决策档。只保留最新结论, 不留修订历史。任何决定变化时**改这份文档**, 不追加。

---

## 0. 全局约束

### 0.1 正确性优先准则

判断代码留 / 删用二维矩阵 (思路对错 × 用没用):

| 思路 | 在用 | 处置 |
|---|---|---|
| 正确 | 在用 | 保留 |
| 正确 | 没在用 | 可以删 (留着是 noise) |
| 错误 | 在用 | 改思路或重写 |
| 错误 | 没在用 | 删 |

"干净" = 思路正确合理 + 有在用。
代码多 ≠ 脏, 烂思路才是脏。

**优先级**: 正确 > 快, 思路对 > 代码量小, 不图快图对。

### 0.2 例外 (必须保留, 即便思路待评)

- PR-L 紧急停损 (实盘 win% 转正前)
- 公共基础设施 (DB / cron 框架 / 日志 / monitoring)

### 0.3 决策前置

- 决定要写代码前, 先在文档中写出该模块 "思路对不对" 的判断, 通过后再执行

---

## 1. 起因

系统在 6 周内积累 30+ PR, 6 条战线并行 (数据 / detector / UI / 通知 / 风控 / bug fix)。
两个矛盾事实:

| 事实 | 数据 |
|---|---|
| 系统在亏钱 | 实盘 95 笔平仓 win% = 0%, avg -8.04% |
| 信号在被加 | 6 周新增 13+ detector / 122 战法 / 6 条战线并行 |

深度诊断发现:
- prod 信号表实际只 3 个 source_type 在写 (非"13 个 detector")
- 95 笔 0% 实盘全来自 `QuantFusionService` (B-fusion 管线), 该管线使用 20 个同质化趋势策略做"伪共识"
- confidence 是规则封顶 (fusion_score ≥ 96 几乎必然), 失去概率含义
- A 股学术证据: 题材短反转 > 动量, 主题 ETF 5 年跑输基准 30%, 散户系统性亏损

---

## 2. 产品骨架

### 2.1 骨架

> **一个信号源 → 两个出口 → 回测验证可信度**
>
> 出口 A (现在): 给用户, 用户拍板
> 出口 B (后期): 自动执行
> 同一套信号回灌回测, 回答"这信号可不可信"

隐含恒等式: **信号 = 回测 = 实盘**。目前不成立 (回测 48% vs 实盘 0%)。让它成立是北极星。

### 2.2 信号原子定义

```typescript
type Signal = {
  // 核心 5 字段
  symbol: string;
  action: 'BUY' | 'SELL' | 'TARGET_WEIGHT';  // TARGET_WEIGHT 用于 ETF 组合再平衡
  timestamp: Date;
  confidence: number;          // [0, 1] historical win rate
  source_detector: string;

  // 生命周期
  lifecycle_id?: string;       // 配对 BUY-SELL
  theme_id?: string;           // 卫星题材专用
  rebalance_id?: string;       // 核心 ETF 月度再平衡组标识
  target_pct?: number;         // TARGET_WEIGHT 时使用

  // 自动化字段 (自动化层填充)
  expected_value?: number;
  recommended_size_pct?: number;
  entry_price_strategy?: 'auction_open' | 'observe_15min' | 'skip';
  stop_loss_pct?: number;
  take_profit_pct?: number;
  cooldown_until?: Date;
  gate_pass?: boolean;
  gate_reason?: string;
}
```

**关键设计**:
- confidence 是概率, 不是得分
- source_detector 让每条信号可追责
- SELL 是配对平仓 (Type 2), 不是看跌扫描 (Type 1)
- 自动化和用户拍板消费同一套信号 + 同一套 gate

---

## 3. 最终锁定

```
真目标      = 组合年化 10-15% (持续, 不要短期高然后回吐)
主线结构    = 核心 70% (ETF 因子) + 卫星 20% (题材事件) + 现金 10%
资金        = 10-50 万 (以 30 万为基准计算)
决策方式    = 用户拍板 (核心月度, 卫星按事件)

单仓上限    = ETF 15% / 题材股 5% (卫星更严)
最大持仓    = 4-5 只 ETF + 3-4 只题材股 (总 7-9 只)
override    = 允许, 但走审计流程 (二次确认 + 写理由 + 入库)

数学核算 (30 万):
  乐观: 12.6% 组合年化 (核心 12% + 卫星 20%)
  中性: 8.2%  组合年化 (核心 10% + 卫星 5%)
  悲观: 4.8%  组合年化 (核心 8% + 卫星 -5%, 硬边界触发前会停)
```

**证据锚定** (Fang & Olteanu-Veerman 2020, de Groot 2021):
- A 股 Value / Quality / LowVol 有稳定溢价 (10-18% 长期年化)
- Momentum 在 A 股有争议 (Hsu 2018: fails), 谨慎权重

**stance**: 换, 但要证据。今天已兑现一次 (题材 → ETF 混合)。

---

## 4. 主线设计

### 4.1 核心 70% — ETF 因子轮动

**候选 ETF 池 (46-63 只)**:

| 组 | 数量 | 内容 |
|---|---|---|
| 宽基 | 8-12 | 300 / 500 / 1000 / 创业板 / 科创 50 / 深证 100 / 上证 50 |
| 风格因子 | 6-10 | 红利 / 中证红利 / 高股息 / 300 价值 / 低波红利 / 500 质量 |
| 行业 | 20-25 | 消费/医药/科技/金融/军工/新能源/半导体/银行/券商/有色 |
| 主题 | 8-10 | AI/芯片/5G/新能车/光伏/医疗器械 (慎用, 用于 Momentum 测试) |
| 债券/商品 | 4-6 | 国债/短融/黄金 (对冲 + 闲置现金去处) |

**因子权重**:

| 因子 | 权重 | 计算 |
|---|---|---|
| Value | 0.35 | PB 倒数 + PE-TTM 倒数 + 股息率, z-score 加权 |
| Quality | 0.30 | 成分股平均 ROE + 利润增长稳定性 (5 年利润 std 倒数) |
| LowVol | 0.25 | 过去 60 日日收益 std × (-1) 与 20 日 std × (-1) 加权 |
| Momentum | 0.10 | 过去 20 日累计收益 (谨慎, 首月回测决定去留) |

综合分 = Σ zscore(因子ᵢ) × 权重ᵢ

**再平衡**:
- 频率: 月度 (每月最后交易日 22:00 计算, 次月第一交易日 9:25 集合竞价执行)
- 持仓: top 4-5 只 ETF, 单只 12-15%, 核心总仓位 60-70%
- 换仓逻辑:
  - 排名滑出 top 6 → SELL
  - 排名进入 top 4-6 → BUY
  - 排名保持 → 持有不动

**SELL 机制**: 只有月度再平衡触发, **不设单笔止损止盈**。ETF 波动小, 月度调仓足够风控。组合级 PR-L 保留。

### 4.2 卫星 20% — 题材事件驱动

**依托**: `ThemeFermentationDetector` (PR-O5) — 但**必须先做数据链修复** (见 §6.2)。

**触发** (BUY):
- Detector 报"启动"或"爆发"阶段
- 该题材未在冷却期
- 卫星总仓位未达 20% 上限

**触发** (SELL):
- Detector 报"高潮"或"退潮"
- 单笔 -7% 止损
- 单笔 +20% 止盈
- 持仓满 21 个交易日 (硬时间)

**仓位**:
- 单只题材股上限 5% (严于 ETF 的 15%)
- 目标持仓 3-4 只题材股
- 卫星总仓位上限 20%

**卫星硬边界** (防止无限吞钱):

```
□ 卫星总仓位 ≤ 20% (不允许扩)
□ 卫星累计亏损 > 组合 5% → 卫星冻结 30 天, 只保留核心
□ 连续 3 个月卫星负 alpha → 卫星永久停止, 资金转入核心
□ 单只题材股 -15% (深止损, 波动大) → 强制平仓
```

**卫星是探索沙盒, 核心永远是主战场**。

### 4.3 现金 10%

- 5% 应急现金 (余额宝, 2%)
- 5% 收益现金 (国债 ETF 511010 或短融 ETF 511360, 3%)
- 不做股票短线操作

### 4.4 T+1 Entry 规则

针对题材主线的涨停 / 高开问题:

```
if 信号 T 收盘涨停:
  → 允许"限价追高 3%" (T+1 集合竞价挂高开 3% 限价单)
     打得进 → entry
     打不进 (一字板) → T+2 观察, 继续涨停则放弃, 开板则追入
elif T+1 高开 > 5%:
  → 观察 15 分钟后决定
elif T+1 高开 < 3%:
  → 集合竞价 entry
```

核心 ETF 不受此规则约束 (ETF 无涨停打不进问题, 直接集合竞价)。

---

## 5. 自动化 + confidence

### 5.1 confidence 模型

**统一逻辑**: `confidence = historical_win_rate(detector, last_90d)`

- 数据源: `recommendation_trade_outcomes` 按 source_type group
- 窗口: (signal_date - 5 天 - 90 天, signal_date - 5 天), 5 天滞后因 forward_return 需 5 天结算
- 缓存: 每 detector 每天算一次
- 三条管线 (A-market / B-fusion / C-bullish) 全部改用此 service, 不再用 score 当 alias
- 服务: 新建 `ConfidenceCalibrationService`

**冷启动**: 新 detector 无历史数据时 default = 30% (悲观), 或用可用最相似 detector 的 win% 作为 prior。

**必然滞后 5 天**: UI 显式标注 "Confidence 38% (基于 04-01 至 06-25), 最近 5 天尚未结算"。

### 5.2 EV gate

**适用范围**:
- 核心 ETF 主线: **不用 EV gate**, 月度因子排名替代
- 卫星题材: **用 EV gate 全套**

**公式**:
```
EV = confidence × avg_win_pct - (1 - confidence) × avg_loss_pct
if EV > 0.5% → 下单
else → 信号留库, 不下单, UI 显示"AI 不建议跟单"
```

0.5% 锚定: A 股双边手续费 0.13% × 2 + 滑点 0.2-0.5% ≈ 0.5%。

### 5.3 自动化和用户拍板同源

- 用户拍板: 所有信号 + gate_reason 展示给用户, 用户自己决定
- 自动化: gate_pass = true 才下单
- 两条路消费同一信号 + 同一 gate, 只在"是否触发下单"分岔

**用户 override** (违反系统建议直接下单):
- UI 二次弹窗
- 手动写理由 (≥ 20 字, 入库)
- 记录 override 编号

**Override 冷冻规则**:
- 触发: 累计 override ≥ 10 次且亏损占比 > 60%
- 分 regime: 熊市阈值 = 80%
- 触发后冷冻 30 天, 期间只能跟系统信号

### 5.4 PR-L 与 §14 优先级

```
if PR-L 紧急停损触发:
  新信号: 全部 skip
  已持仓: 单笔止盈止损仍生效 (仓位保护优先)
  已触发 SELL 后: 转观察, 不再自动开新仓
优先级: PR-L 冻新单 > 单笔保护 > 时间止损
```

**PR-L 过渡期解除条件**:
- Day 0-90: PR-L 保持 (实盘几乎冻结)
- Day 91-150: PR-L 部分解除 (允许小仓位, 5% 单仓)
- Day 151+: 完全解除条件 = "主线累计 ≥ 30 笔 且 win% ≥ 40%"

---

## 6. 数据 + 修复

### 6.1 数据源 (精简版)

**主渠道 (合规, 主线数据基础)**:
- 新浪财经 / 财联社 RSS (合规)
- 证监会 + 交易所公告 API (官方)

**卫星辅助 (轻量)**:
- LLM 分类 (Claude Haiku 或 GPT-4o-mini, 月预算 ¥100)
- 关键词字典兜底 (LLM 超预算时降级)

**排除**:
- 雪球 / 东财爬虫 (合规风险)
- 微博 / 微信 / 抖音 (无免费方案)
- 同花顺 (反爬极严)
- 付费 iFinD / Wind / Choice (超预算)

**每周 15 分钟人工 review**: LLM 提议题材归一化 (例如"算力" → "AI"), 用户点确认 / 拒绝。**拒绝完全无人工** (LLM 幻觉会造成累积混乱)。

**工作量**: 3-4 天 (原规划 8-10 天, 因主线降为混合结构缩减)

### 6.2 PR-O5 数据链修复 (卫星前置)

**问题**:
- Cron 2026-06-30 才 seed, 之前 90 天没跑过
- 上游 `LIMIT_UP_SYNC` 当天 fetched=0, 全链空跑
- 代码 explicit 声明不写 `ai_investment_signals` (soft-layer 设计)

**修复方案**:

**A. 修上游 (必做, 2-4 h)**:
- 修 `LIMIT_UP_SYNC` 数据抓取
- 修 `resolveTradeDate` 挑"最近有 limit_up_stocks 的交易日"而不是"今天"
- Backfill 90 天历史 (2026-06-02 至 2026-06-29)

**B. 让 detector 写 signals 表 (1-2 天)**:
- 加 step 7: fan-out top_codes → `AIInvestmentSignal`
- source_type = `'theme_event'` (独立, 不再借 `quant_recommendation`)
- source_id = `theme:<industry>:<trade_date>:<symbol>`
- decision 映射: launch / outbreak → BUY, climax → HOLD / SELL, recession / germinate → skip
- metadata: phase, is_mainline, industry, timing_tag='theme_phase'

**严格顺序**: A → 观察 1 交易日 → B → 观察 3-5 天 → 才能接入 §5 confidence + EV gate。

---

## 7. 删码清单

### 7.1 保留

| 模块 | 说明 |
|---|---|
| `ThemeFermentationDetector` (PR-O5) | 卫星核心, 需先修复 §6.2 |
| `AnalysisEngineService` / tradingagents | 辅助研究, 月度调仓时给用户看行业分析 |
| `BullishEventDetectorService` | 卫星事件源 (改 source_type 独立不再借 quant_recommendation) |
| `AIInvestmentSignal` 主表 | 扩 schema (§2.2) |
| `recommendation_trade_outcomes` | 加 rebalance_id, theme_id 字段 |
| `BlackSwanDetectorService` | 风控类 (§0.2 例外) |
| PR-L 紧急停损 | (§0.2 例外) |
| PR-M4 仓位风控 | 阈值上调到单仓 15%, 单板块 25% |
| PR-M1/M2/M3 数据层 | ETF 因子需要数据基础设施 |
| PR-N 数据修复 | 保留 |
| `V3RecommendationController` | 重构展示逻辑 (ETF 排名 + 卫星题材) |
| `paper_trading_automation` 框架 | 重构下单逻辑接入 EV gate + 月度再平衡 |
| Phase 11-16 UI 基础布局 | 装饰组件删 |
| 战法库文档 (PR-I-v2) | 历史 reference |

### 7.2 改思路或重写

| 模块 | 处置 |
|---|---|
| 三条管线 confidence | 全部改用 `ConfidenceCalibrationService` (§5.1) |
| `paper_trading_automation` 下单排序 | 改用 EV gate 而非 `confidence_score DESC` |
| Phase 11-16 视觉装饰 | 扫光 / 飞线 / 3D tilt 删, 保留基础卡片 |

### 7.3 删除

**思路错 + 在用**:
- `QuantFusionService` 整套 (95 笔 0% 毒源, 伪共识 + 规则封顶)
- 20 个 per-stock 策略 (同质化趋势)

**思路对但不在新方向**:
- `archiveQuantRecommendations` (A 路径, 全市场选股)
- `QuantRecommendationService`
- `OpeningRushDetector` (PR-O3, 日内)
- `IntradayPriceVolumeAnomalyDetector` (日内)
- `LastHourMomentumDetector` (日内)
- `AfternoonKickDetector` (PR-O6, 日内)
- `LimitUpBoardDetector` (PR-O2, 短线, 卫星不需要)
- `IntradayMomentumDetector` (日内)
- `IntradayReversalDetector` (日内 0 产出)
- `MarketTopDetector` (辅助诊断)
- `BehaviorBiasDetector` (辅助诊断)
- `QALeadingSignalDetector`
- `IntradayOpportunityWatcher` (盘中 10 子规则)
- `syncDailyScreener` (全市场扫盘)
- 通知 PR-D/E 个股利好

### 7.4 新建

| 模块 | 工作量 |
|---|---|
| `ETFRotationService` (含因子计算 + 月度再平衡) | 3-4 天 |
| `FactorCalculatorService` (Value/Quality/LowVol/Momentum) | 2 天 |
| 因子历史回测脚本 (2022-2026, Week 2 验证) | 1-2 天 |
| 闲置现金管理 (国债 ETF / 货币基金自动配置) | 1 天 |
| `ConfidenceCalibrationService` | 1 天 |
| `AutoExitService` (EV gate) | 1-2 天 |
| 精简数据源 (RSS + 公告) | 3-4 天 |
| PR-O5 修复 (§6.2 A + B) | 2-3 天 |
| 战略镜子 UI + monthly_metrics.sql | 1 天 |
| **合计** | **15-19 天** |

**估算**:
- 删除: 后端业务代码 40-50%
- 改写: 3 处
- 新建: 15-19 天

---

## 8. 战略镜子

### 8.1 设计原则

每题 4 层固定 (不能跳):

```
层 1: 现状  → 数据是什么 (AI 填, 客观)
层 2: 评估  → 数据相对目标偏多远 (AI 算)
层 3: 归因  → 偏在哪里 (AI 建议, 用户手写至少一条)
层 4: 决定  → continue / 小调 / 切换 / 全停 (用户签字)
```

**分工**: AI 全填数据 + 建议, 用户 override。**必须至少一条归因手写**, 否则 §17.5 判定退化。

**存放**:
- 模板: `docs/PROJECT_COMPASS.md`
- 月度归档: `docs/compass/YYYY-MM.md`
- 数据 SQL: `scripts/compass/monthly_metrics.sql`

**节奏**: 每月第一个周末填一次。

### 8.2 6 题

| # | 主题 | 决定输出 |
|---|---|---|
| Q1 | 核心 (ETF 因子) 实盘表现 | continue / 调因子权重 / 切换 / 全停 |
| Q2 | 核心因子稳定性 | 因子不动 / 调权重 / 删加因子 |
| Q3 | 卫星 (题材) 表现 + 硬边界 | 卫星继续 / 冻结 / 永久停 |
| Q4 | 核心 vs 卫星 Sharpe 对比 | 比例不动 / 缩卫星 / 停卫星 |
| Q5 | 镜子机制自检 | 维持 / 调题目 / 暂停镜子 |
| Q6 | 下月承诺 (ToDo + 边界 + 数据焦点) | 具体到数字 |

### 8.3 硬阈值 (切换 / 卫星停 / 主线证伪)

**卫星停止** (任一):
- 累计亏损 > 组合 5% → 冻结 30 天
- 连续 3 个月负 alpha → 永久停止
- 单只 -15% → 强制平仓

**主线切换** (影响不到, 因为混合结构没有独立影子)
**主线证伪**:
- 累计 ≥ 30 笔样本 (Wilson CI 有意义)
- 分 regime 统计
- 连续 2 个月 win% < 30% 且 regime 相同 → 触发 §9 降级考虑

**镜子退化**:
- 连续 2 个月手写归因 < 1 条 或 用户填写 < 5 分钟 → 暂停镜子机制

### 8.4 Q6 承诺硬约束

- ToDo 最多 5 项
- "不做"最多 3 项
- 数据焦点必须具体到数字 (例如"实盘 win% 从 0% 提升到 30%", 而不是"表现变好")

---

## 9. 过渡期实施路径

### 9.1 时间线

| 阶段 | 天数 | 内容 |
|---|---|---|
| **冷却** | Day 0-3 | 重读全文, 校准 §11 待校准数字, 决定是否仍认同 §3 锁定 |
| **Wave 1** | Day 4-14 | 建 confidence / EV gate / ETF 框架 / 数据源 / PR-O5 修复 |
| **Wave 2** | Day 15-21 | ETF 因子回测 (2022-2026), 若 ≥ 10% 主线上线 |
| **Wave 3** | Day 22-35 | 删码, 核心 ETF 小仓位上线 (30 万 × 30% 试水) |
| **观察** | Day 36-60 | 核心稳定, 卫星纸面积累 30-45 天数据 |
| **扩展** | Day 60+ | 卫星表现 OK 转实盘 (20% 上限) |
| **全量** | Day 90+ | 首次填战略镜子 |

### 9.2 关键分岔点

**Wave 1 → Wave 2**:
- B-fusion 已停 (auto_trade off)
- 实盘完全冻结
- 所有新 service 单测通过

**Wave 2 因子回测**:
- 年化 ≥ 12% → 主线上线, 目标锁定 10-15%
- 年化 8-12% → 主线上线, 目标下调到 8-10%
- 年化 < 8% → 主线不上线, 重新评估因子权重或触发 §10 降级

**Wave 3 上线条件**:
- Wave 2 回测通过
- 新 service 观察 3 天无 bug

**卫星上实盘 (Day 60+)**:
- 卫星纸面 30 天 win% ≥ 45%
- 未触发 §4.2 硬边界

---

## 10. 失败降级路径

主线依赖 3 个前置, 任一失败, 降级如下:

### 10.1 §6.1 数据源失败

**触发**: 8 天内爬虫合规 / IP 池被封 / LLM 成本超预算 200%

**降级**:
- 砍备用渠道, 只用主渠道 (新浪 RSS + 证监会 API)
- LLM 分类关闭, 只用规则关键词字典
- 卫星 alpha 减半, 硬边界从 5% 缩到 3%

### 10.2 §6.2 PR-O5 修复失败

**触发**: 上游 `LIMIT_UP_SYNC` 超 3 天调试无果

**降级**:
- 卫星推迟到 Q4 (等数据源恢复)
- 卫星资金转入核心 (核心 90% + 现金 10%)
- 目标降到 8-12% (纯 ETF 因子上限)

### 10.3 §5.1 confidence 冷启动失败

**触发**: default 30% 造成卫星实盘连续 5 笔亏损 (2 周内)

**降级**:
- 卫星冻结 30 天, 只跑纸面
- confidence default 从 30% 下调到 20% (更悲观)
- 30 天后基于纸面数据重新评估

### 10.4 全部前置失败的终极降级

**触发**: 三个前置在 60 天内都跑不通

**处置**:
- 核心继续 (ETF 因子学术支持稳)
- 卫星彻底放弃
- 组合结构变为 核心 80% + 现金 20%
- 目标降到 8-12%
- 战略镜子开特殊 review, 讨论项目是否继续

---

## 11. 数字锚定参考

### 11.1 已锚定 (有依据, 可直接使用)

| 数字 | 依据 |
|---|---|
| 组合年化 10-15% | 学术锚 (Fang 2020, de Groot 2021 A 股因子长期收益) |
| ETF 单仓 15% | 单股黑天鹅 -50% 时组合 -7.5%, 一次可承受 |
| 题材单仓 5% | 卫星波动大, 严于核心 |
| 单板块 25% | 继承 PR-M4 已有约束 |
| EV gate 0.5% | 手续费 0.13% × 2 + 滑点 0.2-0.5% |
| 因子权重 V0.35 Q0.30 L0.25 M0.10 | 学术经验值, 首月回测验证 |
| Wilson CI 样本 N ≥ 30 | 统计显著性下限 |
| override 冷冻 10 次 / 60% | 平衡"允许探索"和"防止失控" |
| 数据源工作量 3-4 天 | 主线降为混合后精简 |
| 主线首月回测阈值 10% | 学术下限 |

### 11.2 待校准 (回测数据决定, 冷却期或 Wave 1 校准)

| 数字 | 待校准依据 |
|---|---|
| 卫星累计亏损 5% 组合冻结 | 需回测确认 A 股题材月度亏损分布 |
| 卫星单笔止损 -15% | 需回测题材股月度回撤分布 |
| 卫星止盈 +20% | 需回测题材股月度上涨分布 |
| 卫星持仓 21 天 | 需回测 A 股题材平均生命周期 |
| 连续 3 月负 α 停 | 拍脑袋, 待样本积累后调整 |
| 主线切换 Sharpe 差 0.3 | 统计经验值, 需回测确认 |
| LLM 月预算 ¥100 | 待第一次实测调用量后校准 |

### 11.3 数字锚定原则

**冷却期任务**: 遍历 11.2 每个数字, 若能找到学术 / 历史数据支持则改到 11.1; 若无法, 保留 "待动手时校准" 标签。

**动手时禁止拍脑袋加新 magic number**: 新的数字必须有 11.1 或 11.2 之一的锚定。

---

## 12. 元教训 (工作方法层)

这些是这次会话本身的产出, 不是项目内容, 但影响后续所有工作:

### 12.1 讨论方法

- 单次会话极限 = 走出方向, 不是产出可执行方案
- 每次锁定大决策前, 用 sub-agent 模拟"苛刻外部审计员"挑刺
- 审计员发现的漏洞会推翻锁定 (今天发生过一次: 题材 → ETF 混合)
- AI 会默认接住用户方向 (确认偏差), 除非被明确要求挑战

### 12.2 数字使用

- "持仓部分年化" vs "组合年化" 是单位差异, 混用会造成 60-70% 期望落差
- "梦想数字" (例如 50%) 若不校准, 会绑架整个方案设计
- 沉没成本偏差最明显的迹象: "看机会加仓" / "先留着以防万一"

---

## 13. 运维保障 (回滚 / 监控 / 数据回填)

### 13.1 回滚方案

**核心原则**: 每次删码 / 改写 / 新建都必须**可回滚**, 且回滚时间 < 15 分钟。

**分级回滚**:

| 级别 | 触发场景 | 回滚方式 | 耗时 |
|---|---|---|---|
| L1 单 PR 回滚 | 某个新 service 上线后 bug | `git revert <commit>` + 重新部署 | 5-10 分钟 |
| L2 主线整体回滚 | 核心 ETF 主线首月负 alpha 严重 | 切回 auto_trade off + PR-L 冻结 | 10 分钟 (无需回滚代码, 只关开关) |
| L3 版本回滚 | 大范围失败, 需要回到之前版本 | 从 `releases/` 目录切 symlink | 15 分钟 |
| L4 数据回滚 | DB schema 变更后失败 | 从每日备份恢复 (pg_dump 已存在) | 30-60 分钟 |

**关键约束**:
- **B-fusion 代码删除前必须先跑 30 天新自动化层影子对比**, 确认新逻辑不比 B-fusion 差之后再删
- **删码前必须打 tag**: `git tag pre-delete-b-fusion-2026-07-XX`, 便于紧急恢复
- **DB 变更必须两阶段**: 先加字段 (向后兼容), 观察 7 天, 再删字段
- **禁止**: 单个 PR 里同时删多个模块的代码 (哪个坏了不知道)

**回滚决策权**:
- L1/L2: 用户单独决定
- L3: 用户 + 战略镜子 Q5 讨论
- L4: 必须留证据 (log + 数据快照), 战略镜子专项 review

### 13.2 监控告警

**监控分 3 层**:

**系统层** (基础设施):
- Cron 任务 stuck / 失败 → 飞书 OPS 告警
- DB 连接失败 / 慢查询 → 飞书 OPS
- 磁盘 / 内存超阈值 → 飞书 OPS
- (保留 PR-A / 已有基础设施)

**业务层** (信号 / 交易):
- 主线月度再平衡未触发 (次月第一交易日 10:00 仍无信号) → 用户飞书通知
- 卫星连续 3 笔亏损 → 用户飞书通知 (提前警示硬边界)
- Confidence 计算失败 (依赖数据缺) → 用户飞书 + 战略镜子 Q1 数据标"未知"
- Override 触发 → 用户飞书通知 + 入库审计
- PR-L 触发 → 用户飞书**紧急**通知 (置顶)

**指标层** (性能 / 趋势):
- 每周日晚生成一份指标简报 → 飞书自己
  - 本周组合收益率
  - 核心 vs 卫星 PnL 分解
  - 卫星硬边界距离 (剩余 X% 触发)
  - Override 次数 / 亏损占比
- 战略镜子月度自动 draft → 飞书自己

**告警**渠道**:
- 用户飞书 OPS 群 (已有基础设施, PR-C 通知中心)
- 不发短信 / 电话 (成本 + 打扰)
- **不发用户手机通知** (用户是初炒者, 频繁弹窗会加剧情绪化操作)

**静默期**:
- 用户在飞书标 "静默"后 24 小时内不发非紧急通知
- 但 PR-L 触发 / 卫星硬边界触发**永远发**

### 13.3 数据回填

**背景**: Wave 1 建 ETF 因子需要历史因子数据, 建 confidence 服务需要历史 win% 数据, 两者都要 backfill。

**回填任务清单**:

| 任务 | 数据 | 时间窗 | 工作量 | 前置 |
|---|---|---|---|---|
| **T1** | daily_bars for 50 只候选 ETF | 2022-01-01 至今 | 0.5 天 (已有 PR-N / 增量 sync) | 无 |
| **T2** | ETF 成分股财务因子 (PB/PE/ROE/股息率) | 每月 1 次快照, 2022 至今 | 1 天 | T1 |
| **T3** | 因子分历史 (Value/Quality/LowVol/Momentum for each ETF) | 从 T1+T2 计算, 每月 1 次快照 | 0.5 天 | T1, T2 |
| **T4** | `limit_up_stocks` 历史 (卫星 detector 依赖) | 2026-06-02 至今 (§6.2 提到) | 0.5 天 | 无 |
| **T5** | `theme_fermentation_phases` 历史 | 用 T4 + `industry_sentiment_indices` 计算 | 0.5 天 | T4 |
| **T6** | 历史信号 (`ai_investment_signals`) 迁移 | 保留 tradingagents 部分, 打 archive tag | 0.5 天 | 无 |
| **T7** | `recommendation_trade_outcomes` 历史 | 保留全部 (战略镜子 Q1 用) | 0 天 (已有) | 无 |

**总耗时**: 3-4 天 (与新代码开发并行)

**回填错误处理**:
- 数据源 API 失败 → 记录到 `data_update_logs` 表, 手动重试
- 部分数据缺失 (如某 ETF 2022 年数据不全) → 该 ETF 从候选池删除
- Backfill 期间 prod 服务**必须停** (auto_trade off), 避免半态数据触发错误信号
- 每步 backfill 完成后写一份**快照报告** (`docs/backfill/YYYY-MM-DD-taskX.md`) 记录: 数据量、缺失情况、决定

**Backfill 顺序** (严格依赖):
1. T1 (基础数据)
2. T4 (卫星基础数据, 与 T1 并行可)
3. T2 (依赖 T1)
4. T3 (依赖 T1 + T2)
5. T5 (依赖 T4)
6. T6/T7 (保留处理)

**回填质量门**:
- T1-T5 完成后, 跑一次**完整性检查**: 每个 ETF 至少有 90% 交易日数据, 因子分不为 null
- 完整性 < 90% 的 ETF 从候选池删除
- 完整性 90-99% 的 ETF 保留但标注"数据有缺失"
