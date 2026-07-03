/**
 * SystemWorkspace markdown content.
 *
 * 现版本 (Phase 11, 2026-06-28) — 重写以反映 Phase 1-11 后的真实结构.
 *   - 7 项主菜单 (5 通用 + 2 admin): 主页 / 简易版 / 持仓 / 实验室 / 设置
 *                                  + 数据中心 (admin) + 系统介绍 (admin)
 *   - /home 是登录默认页 (Phase 6 加, 7.5 接入标准 layout)
 *   - 简易版 /workspace/easy (EasyQuant) 独占整屏, 24/24 contract test 守护
 *   - 7 通知/告警服务 (个人 + OPS 两层)
 *   - 78 cron + 29 策略 + 8 因子目录 + 22 因子指标
 *   - 综合策略主盘 (id=65) 唯一活跃实盘
 *
 * 之前内容 (Batch AL / AT 2026-06-21) 仍引用 6 工作区 + 33 个 legacy page,
 * 在 Phase 1-10 Tab 大幅精简 / 菜单整合 / /home 上线后已严重过时. Phase 11
 * 用户原话: "看下系统介绍里面的相关内容, 是不是按照现状要做一些改动和优化"
 * → 此次随视觉重构一并对齐.
 *
 * 4 个静态 tab 的文本 (overview / manual / changelog / architecture);
 * feedback tab 是动态 UI, 不在此文件.
 */

export const SYSTEM_INTRO_MD = `# QuantX A 股 Alpha 平台 — 系统介绍

> **核心目标**：让新手也能自动化在 A 股赚钱。不爆仓 > 打得过基准 > 能扩规模 > 能解释每一笔。
>
> **底层信念**：A 股不是"找一个圣杯策略一劳永逸"，而是 **多策略组合 + 严格风控 + 持续迭代**。

---

## 一、产品形态：两种入口，同一份能力

| 入口 | 对应路由 | 给谁 | 主要内容 |
|---|---|---|---|
| **主页** | \`/home\` | 默认登录后落地 (所有用户) | 账户 hero + 今日推荐 (按时段分组) + 学一招 + 因子表现 + 我的持仓 + 一键操作 |
| **简易版** | \`/workspace/easy\` | 想学量化的新手 | 4 步教学暖纸色页面 (选模板 → 跑 backtest → 看结果 → 推到模拟盘), 独占整屏 |
| **持仓** | \`/workspace/portfolio\` | 想看细节的 | 实盘 + 模拟盘 + 对账 + 归因日记 + AI 日记 + 改进建议 |
| **实验室** | \`/workspace/lab\` | 高阶用户 | 29 策略 + walk-forward + 跨 regime + 季度重训 + Shadow Run + OverfitMetrics + 高级量化 |
| **设置** | \`/workspace/settings\` | 所有用户 | 个人信息 + 风险参数 + 策略 kill switch + 通知渠道 + 黑天鹅历史 |
| **数据中心** (admin) | \`/workspace/data\` | 管理员 | 数据健康度 / 同步状态 / 调度任务 / 系统日志 / 健康监控 |
| **系统介绍** (admin, 本页) | \`/workspace/system\` | 管理员 | 系统介绍 / 操作手册 / 更新日志 / 架构图 / 用户反馈 |

> Phase 9 精简后, 顶部菜单 4 项 (从 11 项缩到核心 4 项 + 简易版 + admin 2 项),
> 二级 Tab 数 (Phase 9): Lab 5 个 / Portfolio 4 个 / Settings 5 个 / Data 4 个.

---

## 二、交易闭环：信号是怎么变成实盘单的

\`\`\`
[数据层]                         5500 只股票 / 10+ 数据源
   │  AKShare + 腾讯 + 新浪 双源校验, 多源降级, T+0/T+1/T+2 三档新鲜度
   ▼
[因子与信号]                     22 个 factor (value / quality / growth / momentum
   │                            / low_vol / northbound / dragon_tiger / sentiment …)
   │  IC ≥ 0.03 / IR ≥ 0.3 才上线; 相关性 ≤ 0.7
   ▼
[策略与组合]                     29 个组合级策略 (StrategyRegistry):
   │  - 多因子选股 / 龙头 / 突破 / 左侧反转 / 高股息 / 业绩超预期
   │  - 北向跟随 / 策略融合 (regime 加权)
   │  - 每个策略有自己的 capacity + kill switch
   ▼
[组合构造与仓位]                 PortfolioOptimizer (mean-variance / risk-parity)
   │  Kelly + ATR 双轨取小, 单股 ≤ 8%, 单行业 ≤ 25%
   │  RebalanceEngine: 偏离 > 3% 才动手
   ▼
[风控 8 闸门 fail-closed]        ① 5 wizard compliance  ② 涨跌停  ③ T+1  ④ ST/退市
   │                            ⑤ 行业集中度熔断  ⑥ 组合 drawdown 熔断
   │                            ⑦ 黑天鹅 watchdog  ⑧ 限售解禁预警
   │  风控不可用 = 拒单, 不放行
   ▼
[执行]                          ExecutionFeasibilityRecord 预判 (feasibility ≥ 60)
   │  小单立即 / 大单 TWAP / VWAP / Iceberg; 按盘口流动性自适应
   │  client_order_id 唯一; broker event 幂等去重
   ▼
[broker-bridge 实盘 / paper]     ed25519 签名 + 鉴权; KillSwitch 激活即 abort 所有 pending
   ▼
[Fill 回报 + Reconciliation]    每隔 30min 对账: alignment_score < 70 自动写 RiskAlert
   │                            + 飞书推送; live_only / paper_only drift 主动告警
   ▼
[每日 / 每周 / 每月 复盘]        DailyAttribution → AIDiary → ErrorPatternReport
   │                            → ImprovementSuggestion → 用户 apply
   ▼
                                调整策略权重 → 回流到信号层
\`\`\`

---

## 三、6 大底层模块

### 模块 A · 数据层

- 行情 ≥ 2 源互验, 盘中延迟 ≤ 30s; 基本面 T+1, 舆情 T+2
- 全市场 ≈ 5500 只覆盖 (含 BJ 920/430, 默认避开)
- 每条记录带 \`source / ingested_at / as_of_time\`, 可追溯 + 可验证
- 一个源挂掉自动切备源 + 写 RiskAlert, **不阻断决策**

### 模块 B · 因子与信号

- 22 个 factor 全部有清晰经济学逻辑, 禁止 data mining
- IC < 0.03 持续 3 个月即下线; 高相关因子 (>0.7) 合并
- 因子按市场状态加权: 牛市动量+成长, 熊市低波动+高分红
- 每个信号 ≥ 3 条 evidence 解释 "为什么是这只票"

### 模块 C · 策略与组合 (29 策略)

按类型分组 (完整列表见 \`backend/src/quant/engine/StrategyRegistry.ts\`):

| 类别 | 策略数 | 代表 |
|---|---|---|
| 趋势 (Trend) | 5 | MovingAverageTrend / MacdTrend / DonchianTrend / MinerviniTrendTemplate / TrendPullbackReentry |
| 突破 (Breakout) | 3 | BreakoutAtr / TurtleBreakout / VolatilityContractionBreakout |
| 反转 (Reversion) | 2 | RsiMeanReversion / BollingerReversion |
| 动量 (Momentum) | 6 | RelativeStrengthMomentum / DualMomentumRotation / QualityMomentumBlend / CTA100Momentum / DragonHeadMomentum / GameTraderRelay |
| 量化质量 / 价量 | 2 | LowVolatilityQuality / VolumePriceConfirmation |
| 多因子 / 龙头 / 业绩 | 4 | MultiFactorAlpha / DragonHead / MultiFactorRanking / EarningsSurprise |
| 价值 / 分红 / 北向 | 4 | HighDividend / GARP / Value / NorthboundFollow |
| 融合 / 板块 | 3 | Ensemble / SectorRotationLeader / Linkage |

**当前活跃实盘**: 综合策略主盘 (paper_trading_portfolios.id=65). 其它 paper 盘可同时跑不同策略组合做横向对比.

### 模块 D · 风控 (8 层闸门, fail-closed)

| 闸门 | 触发条件 | 动作 |
|---|---|---|
| Pre-trade compliance | 5 wizard 合规扫描 | 拒单 |
| 涨跌停拦截 | 主板 ±10% / 创业板 ±20% / BJ ±30% | 拒单 |
| T+1 / ST / 停牌 | 卖出时必须 T+1 解锁 | 拒单 |
| 行业集中度 | 单行业 > 25% | 减仓 |
| 组合 Drawdown | dd > 8% → 减仓 50%; dd > 12% → 清仓 | 熔断 |
| 市场环境 | 连续 3 日跌停个股 > 100 | 全市场暂停建仓 |
| 黑天鹅 watchdog | ST 公告 / 退市预警 / 重大诉讼 / 高管暴增减持 | 立即清仓 |
| 限售解禁 | 解禁前 5 日 | 仓位降一半 |

### 模块 E · 执行 + 对账

- **ExecutionFeasibility** 预判: 流动性 / bid-ask / 停牌
- **算法执行**: TWAP / VWAP / Iceberg; ExecutionPolicyRouter 自适应
- **bridge fail-safe**: 失联 / KillSwitch → 所有 pending → aborted
- **对账主动告警 cron**: alignment_score < 70 / live-only / paper-only 立即写 RiskAlert + 飞书

### 模块 F · 复盘 + 迭代

- 每日: DailyAttribution (盈亏拆解到 因子/行业/时机/选股/择时)
- 每周: 策略 vs 基准, vs 上周, vs 历史均值, capacity 估算
- 每月: 因子 IC 衰减 + 相关性矩阵 + redundancy 告警
- 每季度: 贝叶斯 / grid search / walk-forward 参数重训
- 黑天鹅事件复盘: 每次大跌大涨后输出 "是否预警 / 风控是否触发"

---

## 四、通知 / 告警系统 (Phase 10 audit 完成)

7 个相关 service, 两层目标:

| Service | 用途 | 目标 |
|---|---|---|
| \`NotificationService\` | 个人通知主入口 | 单用户飞书 / Email / In-App |
| \`EmailNotificationService\` | SMTP 发送 | 黑天鹅季度邮件 / OPS 公告失败告警 |
| \`FeishuBotWebhookService\` | 飞书 webhook 抽象 | 文本 / Card / Bot-as-User |
| \`RealtimeAlertDispatcher\` | 实时告警分发 | 个人 (drawer/SSE) + OPS 群 (card) |
| \`RiskAlertService\` | 风控告警入库 + 通知 | 8 闸门触发 / 对账 drift / 数据 stale |
| \`SystemAdminAlertPusher\` | OPS 群唯一推送出口 | critical 路径强制只推 1 条 card, 不双推 |
| \`webhookFailOpen\` | webhook fail-open / fail-closed 策略 | 默认 fail-open + dead 元告警 |

Phase 10 修复要点 (见更新日志):
- critical 公告推送失败 → 元告警自动反馈
- webhook fallback dead → 5 min 内出元告警
- 同一事件不双推 OPS 群 + 个人 (用 SystemAdminAlertPusher 集中收口)

---

## 五、AI 多维分析引擎

### v1 (已上线) — 8 个 Analyzer 并发

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

8 个 analyzer 输出 → **DecisionAggregator** → 落 \`AIInvestmentSignal(source_type='analysis_engine')\`.

### Shadow → Hard 灰度

| 阶段 | mode | AI 输出位置 | 行为 |
|---|---|---|---|
| W1-W2 | \`shadow\` | 仅落 \`AIInvestmentSignal\` 表; 不下单 | 数据收集 |
| W3 | \`shadow + agreement_rate\` | 与 v1 推荐对比一致率 | 灰度评估 |
| W4+ | \`hard\` | 直接进 \`AutomatedRecommendationLoop.runAnalysisEngineHardFollowup\` | 真下单 |

切换通过 \`User.risk_config.analysis_engine.mode\` 配置, **默认 off**, 必须显式打开.

---

## 六、关键规模 (Phase 11)

| 维度 | 数量 |
|---|---|
| 主菜单项 | 5 (通用) + 2 (admin) |
| 二级 Tab (合并后) | Lab 5 / Portfolio 4 / Settings 5 / Data 4 |
| 策略 (StrategyRegistry) | 29 |
| 因子指标 | 22 |
| Cron 任务 (registry) | 78 |
| 通知 / 告警 service | 7 |
| 数据源 | 10+ |
| A 股覆盖 | ≈ 5500 |
| 当前活跃实盘 | 1 (综合策略主盘 id=65) |

---

> 详细方法论: \`docs/trader-system/00_overview.md\`
>
> Phase 1-11 改造完整记录: 本页 "更新日志" tab.
`;

export const SYSTEM_MANUAL_MD = `# 操作手册

> 端到端 step-by-step 指南：新手 / 高阶用户两条路径. 完整版见 \`docs/USER_GUIDE.md\`.

---

## 1. 登录

1. 浏览器打开系统地址 (部署后由管理员告知, 例如 \`http://103.242.3.87:3001\`)
2. 输入用户名 / 密码
3. 第一次登录默认进入 **/home 主页**

> 忘记密码: 联系管理员重置 (出于安全考虑, 不开放自助重置).

---

## 2. 新手路径 — 90 秒上手

### 2.1 看 \`/home\` 主页就够

- **账户 hero**: 暗色卡片 + 总资产 72px 大数字 + 今日盈亏 + 累计回报 + 可用现金 + 30 日 sparkline + 数据刷新时间
- **今日推荐 (按时段分组)**: 推荐按 30min 时间桶分组 (盘前 / 上午盘 / 下午盘 / 盘后), 每张卡显示置信度 / 现价 / 涨跌 / 预期波动 / 持有 / 风险
- **一键跟单**: 默认 ¥5000 / 单, 自动算手数, 弹窗确认 → 通过 8 闸门 → 落到当前模拟盘
- **学一招**: 每天轮一条量化基础知识 (动量 / 价值 / 质量 / 成长 / 北向 / 龙头, 共 6 条按日号 mod 6)
- **因子表现**: 6 大核心因子今天的强弱 + sparkline (启发式, 用于科普)
- **我的持仓**: 卡片网格 + 浮盈大字号 + 一键卖出, 红涨绿跌 A 股惯例

### 2.2 想学背后逻辑 → 简易版

\`/workspace/easy\` 是 4 步教学:
1. 选模板 (大盘股 / 高分红 / 动量 / 龙头 …)
2. 跑 backtest (本地秒级, 不限速)
3. 看结果 (年化 / 回撤 / 胜率, 健康度 verdict)
4. 推到模拟盘 (一键)

简易版独占整屏, 暖纸色页面, 不打扰主菜单.

---

## 3. 高阶用户路径

### 3.1 持仓 \`/workspace/portfolio\` (4 tab)

- 实盘 / 模拟盘账户 + 持仓 + Fill 流水
- AI 日记 + 错误模式 + 改进建议
- 模拟盘管理 (新建 / 编辑 / 重置 / 删除 + 自动跟单开关)
- 多盘对比 (横向哪套打得过基准)

### 3.2 实验室 \`/workspace/lab\` (5 tab)

- 我的策略 / 策略排行 / 新建回测 / 回测对比
- Walk-forward / 优化历史 / 季度重训 / Shadow Run / OverfitMetrics / 高级量化
- 29 个策略横向对比

### 3.3 设置 \`/workspace/settings\` (5 tab)

- 个人中心 + 头像 + 密码
- 风险参数中心 (5 wizard)
- 分析引擎 mode (off / shadow / hard)
- 策略 Kill switch
- 通知渠道矩阵 (事件 × 飞书 / Email / In-App)
- 黑天鹅历史

### 3.4 数据中心 \`/workspace/data\` (admin)

- 数据健康度看板
- 行情同步状态 + 一键补抓
- 调度任务 (78 cron 列表, admin 可手动触发 / 暂停)
- 系统日志 (admin)

---

## 4. 如何开 Shadow / Hard mode

AI 多维分析引擎默认 **off** (不参与下单). 要打开:

\`\`\`
设置 → 风险参数中心 → 分析引擎 tab
  ┌──────────────────────────────────────────┐
  │ 分析引擎模式:  ( ) off  ( ) shadow  ( ) hard │
  └──────────────────────────────────────────┘
\`\`\`

- **off**: 完全不跑 (默认)
- **shadow**: 跑 8 个 analyzer, 写 \`AIInvestmentSignal\` 表, 但 **不下单**; 只看
- **hard**: 跑完 + 落表 + 进 \`AutomatedRecommendationLoop.runAnalysisEngineHardFollowup\` → 真下单

> 建议先 **shadow 跑 1-2 周**, 看 agreement_rate 稳定后再切 hard.

---

## 5. 如何看 AI 分析

1. 任意工作区点击股票 (如 \`600519\`) → 进入个股详情
2. 顶部 "AI 分析" 按钮 → 弹 **AIStockAnalysisModal v2**
3. 弹窗里:
   - 顶部 **ScoreBar**: 8 个 analyzer 的横条评分
   - 右侧 **ConfidenceRing**: 综合置信度 + tier (HIGH/MEDIUM/LOW)
   - 中部 **EvidenceList**: 每个 analyzer ≥ 3 条证据
   - 底部 **ActionPlanCard**: 建议买入 / 持有 / 卖出 + 仓位 + 止损位
   - 如果某个 analyzer 缺数据: **DataMissingBanner** 红色提示

---

## 6. 通知 / 告警怎么收

设置 → 通知渠道 (Phase 10 重做的矩阵 UI):
- 行 = 事件类型 (cron 失败 / 风控触发 / 推荐成功 / 公告 critical / …)
- 列 = 飞书个人 / 飞书 OPS 群 / Email / In-App drawer
- 拨 Switch 即开关; "有未保存改动" 提示 + 保存按钮

OPS 群 critical 公告只推 1 条 (Phase 10 修复双推 bug); webhook fail-open + dead 5 min 内出元告警.

---

## 7. 常见问题

| 现象 | 怎么办 |
|---|---|
| 登录页一直闪 | 浏览器 localStorage 清掉 \`token\` / \`user\`, 重新登录 |
| AI 分析弹窗空白 | 后端 ai-polling-queue 卡了, 等 5 分钟或联系管理员重启 worker |
| 模拟盘看不到新单 | 看 RiskAlert 是不是被 gate 拒; 如果没拒看对账是否 drift |
| 改进建议 apply 没效果 | apply 后 30 天 \`DAILY_IMPROVEMENT_EFFECT_TRACK\` cron 才回采 metric |
| 新建的盘 cron 没自动下单 | 检查 "自动跟单" Switch 是否开; 关了 cron 会跳过 |
| 主页推荐没分时段 | 后端 \`V3RecommendationController.enrichSignal\` 没透传 \`created_at\` — 降级为不分组 (单一桶, head 显示 "今日推荐") |

> 找不到答案? 去 **系统介绍 → 用户反馈** 提交, 30 分钟内 AI 分类, admin 处理后下方绿底回复.
`;

export const SYSTEM_CHANGELOG_MD = `# 更新日志

> Phase 1 → Phase 11 (2026-06-27 ~ 2026-06-28) 是一轮"信息架构 + 视觉" 大重构.
> 之前的 Batch AL / AT / AS / AJ / AI / AK 等 22 个批次记录仍保留在
> \`docs/audit/full_completion_2026_06_21.md\`.

---

## Phase 11 — 2026-06-28 (本次)

**3D 特效 + 高级感 + 系统介绍重写**

- 引入 **framer-motion** (~30KB gz) + **react-parallax-tilt** (~5KB gz), 共 ~35KB
- 主页 \`/home\` 视觉重构:
  - Hero 改暗色 + aurora gradient + 鼠标跟随 spotlight + noise grain (4% opacity)
  - 推荐卡 / 持仓卡 / 学一招卡: 3D parallax tilt (5°/3°/2.5°) + glare 高光
  - framer-motion spring 入场 stagger (替代 CSS animation-delay)
  - 时段分组 head: whileInView 入场动画
- 全局 glassmorphism:
  - \`.modern-sider\` / \`.modern-header\` 加 \`backdrop-filter: blur(20px) saturate(180%)\`
  - logo hover 旋转 8° + 紫色光晕
- 学一招卡: mesh gradient (双 radial) + noise 4%
- 系统介绍页 (本页) 全面重写, 反映 Phase 1-11 现状
- prefers-reduced-motion 用户全部退化静态

---

## Phase 10 — 2026-06-28

**推荐按时段分组 + 全模块时间显示 + 通知 audit**

- 主页推荐按 30min 时间桶分组 (盘前 / 上午盘 / 下午盘 / 盘后)
- Hero 加 30 日资产 sparkline + 数据时间 pill
- 推荐卡片右上角 "信号 HH:MM" badge
- 推荐卡片底部 mini info row (预期波动 / 持有 / 风险)
- 通知 audit: 7 个 service 整合; OPS 群 critical 推送只发 1 条 card 不双推; webhook fail-open + dead 元告警

---

## Phase 9 — 2026-06-28

**Tab 大幅精简 (11 → 4 / 12 → 5) + 全局模块视觉细化**

- 主菜单 11 → 5 (通用) + 2 (admin)
- 二级 Tab: Lab 12→5 / Portfolio 8→4 / Settings 7→5 / Data 5→4
- 模块边角 / 间距 / 字号 / 阴影 全部细化

---

## Phase 8 — 2026-06-28

**高级感视觉重设计 (Apple Finance × Stripe Dashboard)**

- Inter font + violet \`#7c3aed\` brand + 黑色 primary button
- 12 档 zinc 灰阶 + 8 档 spacing + 10 档字号 (11-64px)
- Hero 64-72px 大数字 + sparkline + tabular-nums
- Card hover translateY(-1px) + accent line
- Stagger fade-in (CSS animation-delay)

---

## Phase 7.5 — 2026-06-28

**\`/home\` 加入标准 Sider + Header Layout**

- 修 "主页为什么没有导航栏" 反馈
- /home 与 /workspace/* 共用 ModernAppLayout (例外: /workspace/easy 独占)

---

## Phase 7 — 2026-06-28

**主页学习区块 + 菜单统一 + 简易版回归**

- 主页加 3 区: 学一招 / 因子表现 / 推荐 why
- 所有用户看一样的菜单 (admin 多 2 项)
- 简易版回主菜单 (Phase 6 短暂消失)

---

## Phase 6 — 2026-06-27

**新手主页 \`/home\` 上线**

- 用户原话: "我是个股票的新手小白...这套系统太复杂"
- 3 区块 (账户 / 推荐 / 持仓) + 一键操作
- 登录默认落地页

---

## Phase 1-5 — 2026-06-27

**6 workspace shell 做减法**

- 删 33 个 legacy pages (~ 4.1 万行)
- 合并到 6 个 unified workspace
- 仅保留 4 个 non-workspace 页面 (Login / RecommendationTrace / StockDetail / HealthMonitor)

---

## 早期 Batch (摘录, 完整见 \`docs/audit/full_completion_2026_06_21.md\`)

| Batch | 日期 | 关键改动 |
|---|---|---|
| Batch AT | 2026-06-21 | 模拟盘完整 CRUD UI (持仓与复盘 → 模拟盘管理) |
| Batch AS | 2026-06-21 | 5 P0 修复 (AI 引擎 / cron 2034 / 北向 / 拓扑 / 重复 cron) |
| Batch AL | 2026-06-21 | SystemWorkspace 系统介绍 + 用户反馈闭环 (本页) |
| Batch AK | 2026-06-21 | 修登录页死循环 + 部署回归 |
| Batch AJ | 2026-06-21 | Ralph 200 轮自动化 + Macro 串联 |
| Batch AI | 2026-06-18 | 多维分析引擎 v1 上线 (8 analyzer 并发) |

---

> 完整历史: \`docs/audit/full_completion_2026_06_21.md\`, \`docs/audit/deployment_2026_06_21.md\`
`;

export const SYSTEM_ARCHITECTURE_MD = `# 系统架构图

> 当前架构对应 7 工作区入口 (5 通用 + 2 admin) + AI 多维分析引擎 v1 hard cutover
> + 黑天鹅 6 stage 复盘 + AI 日记 + 改进建议闭环 + Phase 10 通知/告警分层.
>
> 本页上方已嵌入实时拓扑图组件 \`SystemTopologyMap\` (含节点状态, 9 层 ≈ 40 节点).
> 下方文本版整体地图是文字解释, 与上图一一对应.

---

## 一、模块关系 (一图概览)

\`\`\`
                ┌────────────────────────────────────────────────┐
                │  L1 数据层 (10+ 数据源 → PG/TimescaleDB)         │
                │  行情 · 基本面 · 北向 · 龙虎榜 · 涨停 · 公告      │
                │  · 研报 · 舆情 · 互动易 · ETF flow · 宏观        │
                └────────────────────────────────────────────────┘
                                    ↓
                ┌────────────────────────────────────────────────┐
                │  L2 因子与信号 (22 factor; IC/IR 持续监测)       │
                │  value · quality · growth · momentum ·          │
                │  low_vol · northbound · money_flow ·            │
                │  dragon_tiger · liquidity · sentiment · event   │
                │       ↓ FactorPipeline → factor_scores          │
                │       ↓ AlphaSignalGenerator (8 种 signal)      │
                └────────────────────────────────────────────────┘
                                    ↓
                ┌────────────────────────────────────────────────┐
                │  L3 策略 & 组合 (29 策略 regime-加权融合)       │
                │  StrategyRegistry: 29 策略 (Trend/Breakout/    │
                │  Reversion/Momentum/Quality/MultiFactor/        │
                │  DragonHead/HighDividend/Earnings/Northbound/   │
                │  Ensemble/SectorRotation/Linkage 共 29)        │
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
        │           只读, 不触发下单
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

## 三、通知 / 告警分层 (Phase 10)

\`\`\`
   [事件源] (cron 失败 / 风控触发 / 对账 drift / 公告 critical)
            │
            ▼
   ┌─────────────────────────────────┐
   │  RealtimeAlertDispatcher        │
   │   ├─ user_id 推个人             │
   │   └─ category=ops 推 OPS 群     │
   └─────────────────────────────────┘
            │
            ▼
   ┌─────────────────────────────────┐
   │  SystemAdminAlertPusher         │
   │  (OPS 群唯一推送出口, 防双推)    │
   └─────────────────────────────────┘
            │
            ├─ FeishuBotWebhookService (card / text)
            ├─ EmailNotificationService (季报 / 关键失败)
            └─ webhookFailOpen (fail-open + dead 元告警)
\`\`\`

---

## 四、Cron 拓扑 (78 个任务, 摘录)

完整见 \`backend/src/constants/cronRegistry.ts\`. 关键周期任务:

| 频率 | Cron Type | 做什么 |
|---|---|---|
| 每 30s | \`REALTIME_QUOTE_SYNC\` (盘中) | 实时行情 |
| 每 30min | \`LIVE_RECONCILIATION_GUARD\` (盘中 + 收盘) | 对账主动告警 |
| 每 30min | \`BLACK_SWAN_DETECT\` | 5 类黑天鹅信号巡检 |
| 每 30min | \`FEEDBACK_REVIEW_SWEEP\` | 用户反馈分类 |
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

## 五、参考文档

| 文档 | 内容 |
|---|---|
| \`docs/trader-system/00_overview.md\` | 操盘手方法论 + 6 大模块 |
| \`docs/trader-system/80_ai_analysis_engine.md\` | AI 引擎 v2 设计 |
| \`docs/audit/full_completion_2026_06_21.md\` | 早期 147 story 完整实施记录 |
| \`docs/audit/deployment_2026_06_21.md\` | 部署坑 + ops 三账号 |
| \`backend/src/constants/cronRegistry.ts\` | 78 cron 任务事实源 |
| \`backend/src/quant/strategies/ETFRotationStrategy.ts\` | ETF 因子轮动主线策略 |
`;
