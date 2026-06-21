/**
 * SystemWorkspace markdown content (Batch AL 2026-06-21).
 *
 * 4 个静态 tab 的文本 (intro / manual / changelog / architecture);
 * feedback tab 是动态 UI, 不在此文件.
 *
 * 引用源 (随仓库同步更新):
 *   - docs/trader-system/00_overview.md
 *   - docs/USER_GUIDE.md
 *   - docs/audit/full_completion_2026_06_21.md
 */

export const SYSTEM_INTRO_MD = `# QuantX A 股 Alpha 平台 — 系统介绍

> **核心目标**：自动化的买入卖出，帮人赚钱。不爆仓 > 打得过基准 > 能扩规模 > 能解释。
>
> **底层信念**：A 股不是"找一个圣杯策略一劳永逸"，而是 **多策略组合 + 严格风控 + 持续迭代**。

---

## 一、交易闭环：信号是怎么变成实盘单的

\`\`\`
[数据层]                         5500 只股票 / 10+ 数据源
   │  AKShare + 腾讯 + 新浪 双源校验，多源降级，T+0/T+1/T+2 三档新鲜度
   ▼
[因子与信号]                     18+ factor（value / quality / growth / momentum
   │                            / low_vol / northbound / dragon_tiger / sentiment …）
   │  每个 factor IC ≥ 0.03 / IR ≥ 0.3 才上线；相关性 ≤ 0.7
   ▼
[策略与组合]                     13 个组合级策略：
   │  - 多因子选股 / 龙头 / 突破 / 左侧反转 / 高股息 / 业绩超预期
   │  - 北向跟随 / 策略融合（regime 加权）
   │  - 每个策略有自己的 capacity + kill switch
   ▼
[组合构造与仓位]                 PortfolioOptimizer（mean-variance / risk-parity）
   │  Kelly + ATR 双轨取小，单股 ≤ 8%、单行业 ≤ 25%
   │  RebalanceEngine：偏离 > 3% 才动手
   ▼
[风控 8 闸门 fail-closed]        ① 5 wizard compliance ② 涨跌停 ③ T+1 ④ ST/退市
   │                            ⑤ 行业集中度熔断 ⑥ 组合 drawdown 熔断
   │                            ⑦ 黑天鹅 watchdog ⑧ 限售解禁预警
   │  风控不可用 = 拒单，不放行
   ▼
[执行]                          ExecutionFeasibilityRecord 预判 (feasibility ≥ 60)
   │  小单立即 / 大单 TWAP / VWAP / Iceberg；按盘口流动性自适应
   │  client_order_id 唯一；broker event 幂等去重
   ▼
[broker-bridge 实盘 / paper]     ed25519 签名 + 鉴权；KillSwitch 激活即 abort 所有 pending
   ▼
[Fill 回报 + Reconciliation]    每隔 30min 对账：alignment_score < 70 自动写 RiskAlert
   │                            + 飞书推送；live_only / paper_only drift 主动告警
   ▼
[每日 / 每周 / 每月 复盘]        DailyAttribution → AIDiary → ErrorPatternReport
   │                            → ImprovementSuggestion → 用户 apply
   ▼
                                调整策略权重 → 回流到信号层
\`\`\`

---

## 二、6 大模块

### 模块 A · 数据层
- 行情 ≥ 2 源互验，盘中延迟 ≤ 30s；基本面 T+1，舆情 T+2
- 全市场 ≈ 5500 只覆盖（含 BJ 920/430，默认避开）
- 每条记录带 \`source / ingested_at / as_of_time\`，可追溯 + 可验证
- 一个源挂掉自动切备源 + 写 RiskAlert，**不阻断决策**

### 模块 B · 因子与信号
- 18+ factor 全部有清晰经济学逻辑，禁止 data mining
- IC < 0.03 持续 3 个月即下线；高相关因子（>0.7）合并
- 因子按市场状态加权：牛市动量+成长，熊市低波动+高分红
- 每个信号 ≥ 3 条 evidence 解释 "为什么是这只票"

### 模块 C · 策略与组合（13 个策略）
1. **多因子选股 (MultiFactorAlpha)** — 中长期主力，因子复合打分
2. **龙头策略 (DragonHead)** — 涨停板 + 龙虎榜 + 北向共振
3. **突破策略 (Breakout)** — 量价突破带止损
4. **左侧反转 (LeftSideReversal)** — 业绩拐点 + 超跌反弹
5. **高股息价值 (HighDividend)** — 防御资产，长期复利
6. **业绩超预期 (EarningsSurprise)** — 财报后 N 日跟随
7. **北向跟随 (NorthboundFollow)** — 净流入排序
8. **策略融合 (Ensemble)** — Regime 自适应加权
9-13. **持续迭代中** — 见 \`docs/trader-system/30_strategy_overview.md\`

### 模块 D · 风控（8 层闸门，fail-closed）
| 闸门 | 触发条件 | 动作 |
|---|---|---|
| Pre-trade compliance | 5 wizard 合规扫描 | 拒单 |
| 涨跌停拦截 | 主板 ±10% / 创业板 ±20% / BJ ±30% | 拒单 |
| T+1 / ST / 停牌 | 卖出时必须 T+1 解锁 | 拒单 |
| 行业集中度 | 单行业 > 25% | 减仓 |
| 组合 Drawdown | dd > 8% → 减仓 50%；dd > 12% → 清仓 | 熔断 |
| 市场环境 | 连续 3 日跌停个股 > 100 | 全市场暂停建仓 |
| 黑天鹅 watchdog | ST 公告 / 退市预警 / 重大诉讼 / 高管暴增减持 | 立即清仓 |
| 限售解禁 | 解禁前 5 日 | 仓位降一半 |

### 模块 E · 执行 + 对账
- **ExecutionFeasibility** 预判：流动性 / bid-ask / 停牌
- **算法执行**：TWAP / VWAP / Iceberg；ExecutionPolicyRouter 自适应
- **bridge fail-safe**：失联 / KillSwitch → 所有 pending → aborted
- **对账主动告警 cron**：alignment_score < 70 / live-only / paper-only 立即写 RiskAlert + 飞书

### 模块 F · 复盘 + 迭代
- 每日：DailyAttribution（盈亏拆解到 因子/行业/时机/选股/择时）
- 每周：策略 vs 基准、vs 上周、vs 历史均值、capacity 估算
- 每月：因子 IC 衰减 + 相关性矩阵 + redundancy 告警
- 每季度：贝叶斯 / grid search / walk-forward 参数重训
- 黑天鹅事件复盘：每次大跌大涨后输出"是否预警 / 风控是否触发"

---

## 三、AI 多维分析引擎

### v1（已上线）— 8 个 Analyzer 并发

| Analyzer | 输入 | 输出维度 |
|---|---|---|
| FundamentalAnalyzer | 财报 / PE/PB/ROE / peer rank | 估值健康度 |
| TechnicalAnalyzer | K 线 / 涨跌停 / ATR | 形态 / 突破信号 |
| MoneyFlowAnalyzer | 主力资金 / 北向 / 龙虎榜 | 资金倾向 |
| SentimentAnalyzer | 新闻 / 雪球 / 互动易 | 情绪强度 |
| NewsAnalyzer | KOL / 公告 NLP | 事件影响 |
| IndustryRegimeAnalyzer | 板块强弱 / 龙头共振 | 行业风口 |
| RiskAnalyzer | ATR / drawdown / 集中度 | 风险评分 |
| AnnouncementAnalyzer | event_type / priority / entities | 公告事件分析 |

8 个 analyzer 输出 → **DecisionAggregator** → 落 \`AIInvestmentSignal(source_type='analysis_engine')\`。

### v2（设计中）— 见 \`docs/trader-system/80_ai_analysis_engine.md\`

---

## 四、Shadow → Hard 灰度

| 阶段 | mode | AI 输出位置 | 行为 |
|---|---|---|---|
| W1-W2 | \`shadow\` | 仅落 \`AIInvestmentSignal\` 表；不下单 | 数据收集 |
| W3 | \`shadow + agreement_rate\` | 与 v1 推荐对比一致率 | 灰度评估 |
| W4+ | \`hard\` | 直接进 \`AutomatedRecommendationLoop.runAnalysisEngineHardFollowup\` | 真下单 |

切换通过 \`User.risk_config.analysis_engine.mode\` 配置，**默认 off**，必须显式打开。

---

## 五、6 工作区导航

| 工作区 | 做什么 |
|---|---|
| **今日作战** | 集合竞价异动 / AI brief / 卖出建议 / 当日候选 |
| **选股因子** | 23 个 factor / 龙虎榜 / 北向 / 涨停板 / ETF flow / 公告政策 / 宏观 |
| **策略实验室** | 策略详情 / Walk-forward / 跨 regime / Quarterly retrain / Leaderboard |
| **持仓与复盘** | 实盘 / 模拟盘 / 对账 / 归因日记 / 错误模式 |
| **数据中心** | 数据健康 / 行情同步 / 调度任务 / 系统日志 / 健康监控 |
| **账号设置** | 个人中心 / 风险参数 / 改进建议待办 / Kill switch / 通知 |
| **系统介绍**（本页） | 系统介绍 / 操作手册 / 更新日志 / 架构图 / 用户反馈 |

---

> 详细方法论：\`docs/trader-system/00_overview.md\`
>
> 完整实施记录：\`docs/audit/full_completion_2026_06_21.md\`
`;

export const SYSTEM_MANUAL_MD = `# 操作手册

> 端到端 step-by-step 指南：从登录到放出真实信号到模拟盘。完整版见 \`docs/USER_GUIDE.md\`。

---

## 1. 登录

1. 浏览器打开系统地址（部署后由管理员告知，例如 \`http://103.242.3.87:3001\`）
2. 输入用户名 / 密码
3. 第一次登录默认进入 **今日作战** 工作区

> 忘记密码：联系管理员重置（出于安全考虑，不开放自助重置）。

---

## 2. 6 个工作区做什么

### 2.1 今日作战 \`/workspace/today\`

- **集合竞价异动**：9:25 后自动扫候选标的，给出"一字 / 高开 / 低开 / 撤单异常"
- **AI Brief**：每日盘前的市场判断 + 今日操作纪要（多 / 中 / 空 + 仓位建议）
- **卖出建议**：基于止损 / 行业集中度 / 触发的风控条目，提示当日该卖的票
- **候选池**：今日可买入观察池（评分 + evidence）

### 2.2 选股因子 \`/workspace/factors\`

7 个 tab 看不同维度数据：
- 基础因子（PE/PB/ROE/Momentum/低波动 等）
- 龙虎榜 / 北向资金 / 涨停板（含连板 / 炸板）
- 行业 ETF flow / 公告政策 / 宏观环境

### 2.3 策略实验室 \`/workspace/lab\`

6 个 tab：
- 高级量化（Walk-forward / Monte Carlo / Cost sensitivity）
- 跨 regime 表现 / Quarterly retrain / Shadow Run 对比
- Leaderboard：13 个策略横向对比

### 2.4 持仓与复盘 \`/workspace/portfolio\`

- 实盘账户 + 持仓 + Fill 流水
- 模拟盘账户（多盘）+ Snapshot 历史 + 对账信息
- 每日归因 + AI 日记 + 错误模式 + 改进建议

### 2.5 数据中心 \`/workspace/data\`

- 数据健康度看板
- 行情同步状态 + 一键补抓
- 调度任务（cron 列表，admin 可手动触发 / 暂停）
- 系统日志（admin）
- 健康监控（DB / Redis / AKShare / TradingAgents）

### 2.6 账号设置 \`/workspace/settings\`

- 个人中心 + 头像 + 密码
- 风险参数中心（5 wizard）
- 改进建议待办（点 apply 直接生效）
- Kill switch / 行业集中度阈值 / 仓位上限

---

## 3. 如何开 Shadow / Hard mode

AI 多维分析引擎默认 **off**（不参与下单）。要打开：

\`\`\`
账号设置 → 风险参数中心 → 分析引擎 tab
  ┌──────────────────────────────────────────┐
  │ 分析引擎模式:  ( ) off  ( ) shadow  ( ) hard │
  └──────────────────────────────────────────┘
\`\`\`

- **off**：完全不跑（默认）
- **shadow**：跑 8 个 analyzer，写 \`AIInvestmentSignal\` 表，但 **不下单**；只看
- **hard**：跑完 + 落表 + 进 \`AutomatedRecommendationLoop.runAnalysisEngineHardFollowup\` → 真下单

> 建议先 **shadow 跑 1-2 周**，看 agreement_rate 稳定后再切 hard。

---

## 4. 如何看 AI 分析

1. 任意工作区点击股票（如 \`600519\`）→ 进入个股详情
2. 顶部 "AI 分析" 按钮 → 弹 **AIStockAnalysisModal v2**
3. 弹窗里：
   - 顶部 **ScoreBar**：8 个 analyzer 的横条评分
   - 右侧 **ConfidenceRing**：综合置信度 + tier (HIGH/MEDIUM/LOW)
   - 中部 **EvidenceList**：每个 analyzer ≥ 3 条证据
   - 底部 **ActionPlanCard**：建议买入 / 持有 / 卖出 + 仓位 + 止损位
   - 如果某个 analyzer 缺数据：**DataMissingBanner** 红色提示

---

## 5. 如何手工把 AI 信号应用到模拟盘

1. 持仓与复盘 → AI 信号列表
2. 找到目标信号 → "应用到模拟盘" 按钮
3. 选择盘口（多个模拟盘支持 GlobalPortfolioSelector）
4. 确认仓位（系统按 Kelly + ATR 推荐，可手调）
5. 提交 → 走 pre-trade gate（compliance / 涨跌停 / T+1）
6. 通过后落 \`PaperTradingTrade\`，30min 内对账校验

> Gate 拒单原因会写到 \`RiskAlert\` 表，前端会有铃铛红 Badge。

---

## 6. 常见问题

| 现象 | 怎么办 |
|---|---|
| 登录页一直闪 | 浏览器 localStorage 清掉 \`token\` / \`user\`，重新登录 |
| AI 分析弹窗空白 | 后端 ai-polling-queue 卡了，等 5 分钟或联系管理员重启 worker |
| 模拟盘看不到新单 | 看 RiskAlert 是不是被 gate 拒；如果没拒看对账是否 drift |
| 改进建议 apply 没效果 | apply 后 30 天 \`DAILY_IMPROVEMENT_EFFECT_TRACK\` cron 才回采 metric |

> 找不到答案？去 **系统介绍 → 用户反馈** 提交，30 分钟内 AI 分类、admin 处理后下方绿底回复。
`;

export const SYSTEM_CHANGELOG_MD = `# 更新日志

> 最近三个批次（AI / AJ / AK）的关键改动。完整记录见 \`docs/audit/full_completion_2026_06_21.md\`。

---

## Batch AL — 2026-06-21（本批）

**SystemWorkspace 系统介绍 + 用户反馈闭环**

- 新增左侧 "系统介绍" 工作区，5 个 tab：系统介绍 / 操作手册 / 更新日志 / 架构图 / 用户反馈
- 新表 \`user_feedbacks\` + 服务端 multer 图片上传（≤ 9 张 / ≤ 5 MB）
- 新 cron \`FEEDBACK_REVIEW_SWEEP\`（每 30 分钟）：自动分类 (bug/feature_request/question/praise) + 优先级 + 摘要
- admin 通过 \`POST /api/admin/feedbacks/:id/resolve\` 标记解决 + 写 commit/PR 关联
- 13 个新单测覆盖 service + cron 一致性 guard

---

## Batch AK — 2026-06-21

**修登录页一直闪动死循环 + 部署回归**

- 修 \`AppContent.useEffect\` 在 \`fetchProfile\` 失败 catch 分支也清 \`token\`，否则任何后续 API 401 → 跳 login → 又触发 fetchProfile → 死循环
- 部署 \`ralph/trader-system-prod\` → \`main\`

---

## Batch AJ — 2026-06-21

**Ralph 200 轮自动化 + Macro 串联补丁**

- 147 / 147 user story 全部完成；后端 245/245 测试全绿；TypeScript 零错误
- 新增 14 个之前漏 seed 的 cron + 3 个新 cron（WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE / DAILY_IMPROVEMENT_EFFECT_TRACK / ETF_FLOW_SYNC）
- 前端 ImprovementSuggestion + WeeklyReview apply UI
- AI Hard Cutover 真接通：\`archiveAnalysisEngineResult\` + \`runAnalysisEngineHardFollowup\`
- 6 / 6 macro check 断点修复

---

## Batch AI — 2026-06-18

**多维分析引擎 v1 上线**

- 8 个 analyzer 并发框架：Fundamental / Technical / MoneyFlow / Sentiment / News / IndustryRegime / Risk / Announcement
- DecisionAggregator + Shadow stats controller + AIAdvisor hook
- Schema migration 落 \`AIInvestmentSignal(source_type='analysis_engine')\`
- 闭环审计：BETA-1 ~ BETA-9（TradeCompliance pre-trade / 对账主动告警 / aiPollingQueue dedup / Shadow autopilot 幂等 / dry_run 默认值巡检 / 行情陈旧度改 RealtimeQuote / DrawdownCircuitBreaker fail-closed）

---

> 历史完整列表：\`docs/audit/full_completion_2026_06_21.md\`、\`docs/audit/deployment_2026_06_21.md\`
`;

export const SYSTEM_ARCHITECTURE_MD = `# 系统架构图

> 当前架构对应 6 工作区 + AI 多维分析引擎 v1 hard cutover + 黑天鹅 6 stage 复盘 + AI 日记 + 改进建议闭环。
>
> 数据中心的实时拓扑图（含节点状态）仍可在 **数据中心 → 数据健康** 找到 SystemTopologyMap，本页是文本版整体地图。

---

## 一、模块关系（一图概览）

\`\`\`
                ┌────────────────────────────────────────────────┐
                │  L1 数据层 (10+ 数据源 → PG/TimescaleDB)         │
                │  行情 · 基本面 · 北向 · 龙虎榜 · 涨停 · 公告      │
                │  · 研报 · 舆情 · 互动易 · ETF flow · 宏观        │
                └────────────────────────────────────────────────┘
                                    ↓
                ┌────────────────────────────────────────────────┐
                │  L2 因子与信号 (23 factor; IC/IR 持续监测)       │
                │  value · quality · growth · momentum ·          │
                │  low_vol · northbound · money_flow ·            │
                │  dragon_tiger · liquidity · sentiment · event   │
                │       ↓ FactorPipeline → factor_scores          │
                │       ↓ AlphaSignalGenerator (8 种 signal)      │
                └────────────────────────────────────────────────┘
                                    ↓
                ┌────────────────────────────────────────────────┐
                │  L3 策略 & 组合 (13 策略 regime-加权融合)       │
                │  MultiFactorAlpha / DragonHead / Breakout /     │
                │  LeftSide / HighDividend / Earnings /           │
                │  Northbound / Ensemble / + 5 in pipeline        │
                │       ↓ PortfolioOptimizer + PositionSizing     │
                │       ↓ RebalanceEngine (3% 偏离触发)            │
                └────────────────────────────────────────────────┘
                                    ↓
                ┌────────────────────────────────────────────────┐
                │  L4 风控 (8 闸门, fail-closed)                  │
                │  pre-trade: compliance + 涨跌停 + T+1 + ST      │
                │  post-trade: trailing stop + drawdown +         │
                │              industry concentration              │
                │  watchdog: BlackSwan 6-stage + 限售解禁          │
                └────────────────────────────────────────────────┘
                                    ↓
                ┌────────────────────────────────────────────────┐
                │  L5 执行 + bridge + 对账                         │
                │  ExecutionPolicyRouter → TWAP/VWAP/Iceberg →    │
                │  broker-bridge (ed25519, KillSwitch fail-safe) │
                │       ↓ Fill events ← LiveBrokerEvent           │
                │       ↑ Reconciliation cron (30min)             │
                └────────────────────────────────────────────────┘
                                    ↓
                ┌────────────────────────────────────────────────┐
                │  L6 复盘 + AI 日记 + 改进建议                    │
                │  DailyAttribution → AIDiary → ErrorPattern →    │
                │  ImprovementSuggestion → apply effect tracker   │
                │       ↓ BlackSwanPostmortem (6 stage)           │
                └────────────────────────────────────────────────┘
                                    ↓
              [反馈] → 调整策略权重 / kill switch / 因子启停 → 回 L2
\`\`\`

---

## 二、AI 多维分析引擎位置

\`\`\`
   [用户 / cron 触发个股分析]
            │
            ▼
   AIAdvisorService.analyzeSingleStock
            │
       (mode = ?)
        ├── off    → 不跑
        ├── shadow → AnalysisEngineService.analyzeStock (8 analyzer 并发)
        │              ↓
        │           DecisionAggregator
        │              ↓
        │           落 AIInvestmentSignal(source_type='analysis_engine')
        │              ↓
        │           只读，不触发下单
        │
        └── hard   → 上面整条 + archiveAnalysisEngineResult
                        ↓
                   AutomatedRecommendationLoop.runAnalysisEngineHardFollowup
                        ↓
                   PaperTradingFacade.placeOrder  ←  5 wizard gate
                        ↓
                   broker-bridge / paper-trading 实盘
\`\`\`

---

## 三、Cron 拓扑（关键周期任务）

| 频率 | Cron Type | 做什么 |
|---|---|---|
| 每 30s | \`REALTIME_QUOTE_SYNC\` (盘中) | 实时行情 |
| 每 30min | \`LIVE_RECONCILIATION_GUARD\` (盘中 + 收盘) | 对账主动告警 |
| 每 30min | \`BLACK_SWAN_DETECT\` | 5 类黑天鹅信号巡检 |
| 每 30min | \`FEEDBACK_REVIEW_SWEEP\` | 用户反馈分类（Batch AL 新增） |
| 每日 17:00 | \`DAILY_ATTRIBUTION_GENERATE\` | 当日归因 + 飞书推送 |
| 每日 18:00 | \`AI_DIARY_GENERATE\` | AI 日记 |
| 每日 18:00 | \`DAILY_UPDATE\` | K 线 / 财务 / 龙虎榜 |
| 每日 18:00 | \`ETF_FLOW_SYNC\` (工作日) | 行业 ETF 资金流 |
| 每日 19:00 | \`FACTOR_IC_COMPUTE\` | 因子 IC / IR |
| 每日 19:30 | \`DAILY_IMPROVEMENT_EFFECT_TRACK\` | 改进建议 apply 后效果回采 |
| 每日 22:00 | \`RESEARCH_INTEGRITY_BATCH_AUDIT\` | 研究产物完整性 |
| 每日 23:00 | \`DATA_QUALITY_SCAN\` | 数据漂移扫描 |
| 每周日 10:00 | \`WEEKLY_ERROR_PATTERN_AGGREGATE\` | 错误模式聚合 |
| 每周一 02:00 | \`WEEKLY_QA_STAT_AGGREGATE\` | 投资者问答聚合 |
| 每周一 03:00 | \`SYNC_ALL_STOCKS\` | 股票基础信息 |
| 每周二 09:00 | \`WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE\` | 改进建议生成 |
| 季度首月 1 日 | \`BLACK_SWAN_QUARTERLY_SUMMARY\` | 黑天鹅季度邮件 |

---

## 四、参考文档

| 文档 | 内容 |
|---|---|
| \`docs/trader-system/00_overview.md\` | 操盘手方法论 + 6 大模块 |
| \`docs/trader-system/30_strategy_overview.md\` | 13 策略详细 |
| \`docs/trader-system/80_ai_analysis_engine.md\` | AI 引擎 v2 设计 |
| \`docs/audit/full_completion_2026_06_21.md\` | 147 story 完整实施记录 |
| \`docs/audit/deployment_2026_06_21.md\` | 部署坑 + ops 三账号 |
`;
