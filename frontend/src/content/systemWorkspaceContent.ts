/**
 * SystemWorkspace markdown content.
 *
 * 现版本 — 随「Signal-First + 核心-卫星」重构改写. 旧的 29 策略 / 多维分析引擎
 * (shadow/hard) / L1-L8 分层 / 22 因子个股信号工厂 / 日内高频推送 均已删除.
 * 决策依据: docs/SIGNAL_FIRST_PLAN.md; 执行记录: docs/REFACTOR_PLAN.md.
 *
 * 主线: 核心 70% (ETF 因子轮动) + 卫星 20% (题材事件驱动) + 现金 10%.
 *
 * 4 个静态 tab 的文本 (overview / manual / changelog / architecture);
 * feedback tab 是动态 UI, 不在此文件.
 */

export const SYSTEM_INTRO_MD = `# QuantX A 股 Alpha 平台 — 系统介绍

> **核心目标**：在 A 股持续复利. 底线年化 8-10% (核心 ETF 兜底), 冲刺 10-15% (卫星打满, 不当必达).
>
> **底层信念**：散户中频拍板个股长期难赢. 系统只做一件被学术支撑的事——**机械化 ETF 因子轮动 + 严控上限的题材卫星**, 把情绪从选股里剥掉.

---

## 一、主线结构：核心 / 卫星 / 现金

\`\`\`
核心 70%  = ETF 因子轮动 (月度机械换仓, 稳中求进, 收益主要来源)
卫星 20%  = 题材事件驱动 (个股, 波动大, 严控上限, 探索沙盒)
现金 10%  = 5% 应急 + 5% 国债/短融 ETF (压舱石)
\`\`\`

三桶解耦: 底线目标交给核心兜底, 冲刺目标交给卫星, 两者互不绑架. 卫星即使被冻结/永久停, 核心仍能兜住底线.

---

## 二、产品入口

| 入口 | 路由 | 给谁 | 主要内容 |
|---|---|---|---|
| **主页** | \`/home\` | 默认登录落地 | 账户总览 + 核心 ETF 排名 + 卫星题材 + 现金 三栏 + 我的持仓 |
| **简易版** | \`/workspace/easy\` | 想学量化的新手 | 4 步教学 (选模板 → 跑回测 → 看结果 → 推模拟盘), 独占整屏 |
| **持仓** | \`/workspace/portfolio\` | 想看细节的 | 实盘 + 模拟盘 + 对账 + 归因日记 + AI 日记 + 改进建议 |
| **实验室** | \`/workspace/lab\` | 高阶用户 | 回测 + walk-forward + 跨 regime + OverfitMetrics + 排行 |
| **设置** | \`/workspace/settings\` | 所有用户 | 个人信息 + 风险参数 + 组合构造 + 通知渠道 |
| **数据中心** (admin) | \`/workspace/data\` | 管理员 | 数据健康度 / 同步状态 / 调度任务 / 系统日志 |
| **系统介绍** (admin, 本页) | \`/workspace/system\` | 管理员 | 系统介绍 / 操作手册 / 更新日志 / 架构图 / 用户反馈 |

---

## 三、信号闭环：因子分怎么变成换仓单

\`\`\`
[数据层]                A 股 + 46-63 只候选 ETF + 成分股 / 财务 / 宏观
   │  双源校验 + point-in-time 快照 (禁止用今天的池反推历史)
   ▼
[核心 ETF 因子层]        ETFConstituentExpander: ETF → 成分股
   │                    ETFFactorService: Value 0.40 / Quality 0.30
   │                    / LowVol 0.30 / Momentum 0.0 (shadow)
   │                    → etf_total_score
   ▼
[排名 + 换仓]            ETFRankingService: top4 买 / top6 卖 缓冲带
   │                    → 目标权重 (核心 70% 硬顶 + 单只 15% 封顶)
   │                    ETFRotationService: 附 confidence + rebalance_id
   │                    → 落 AIInvestmentSignal(action=TARGET_WEIGHT)
   ▼
[卫星题材层]             ThemeFermentation detector → EV gate (L4)
   │                    → 建仓 (单只 ≤ 5%, 卫星总仓 ≤ 20%)
   │                    AutoExitService: -15% 硬止损 / +20% 止盈
   │                    / 21 日时间退出 / -7% 主动止损 / 熔断
   ▼
[Gate 4 层]             L1 eligibility + L2 risk + L3 cost (核心+卫星必过)
   │                    L4 EV gate (仅卫星; 核心跳过, 月度排名替代)
   ▼
[执行]                  次月首日 9:40 分批限价 / VWAP, 折溢价 gate
   ▼
[复盘 + 校准]           ConfidenceCalibrationService (Wilson 下界)
   │                    月度战略镜子 6 题 + 卫星 alpha 归因
   ▼
                        confidence 回灌 sizing / 冷启动纸面判定
\`\`\`

---

## 四、核心 ETF 因子 (权重 V0)

| 因子 | 权重 | 状态 | 计算口径 |
|---|---|---|---|
| Value | 0.40 | 主 | 成分股 z(1/pb)+z(1/pe_ttm)+z(股息率) → 加权 → ETF 层 |
| Quality | 0.30 | 主 | 成分股 z(roe)+z(-5年净利润波动)+z(5年ROE均值) → 加权 |
| LowVol | 0.30 | 主 | ETF 层 z(-vol_60d)×0.6 + z(-vol_20d)×0.4 |
| Momentum | 0.0 | shadow | z(return_20d)-z(return_5d)×0.3, 单独存不入 total |

> 综合分 = Σ 权重 × z(因子原始值). 权重是 V0 candidate, 允许保守网格敏感性验证, 禁止追最优参数. 详见 \`docs/trader-system/21_alpha_factor_library.md\`.

---

## 五、Gate 4 层 (§5.2)

| 层 | 名称 | 检查 | 核心 | 卫星 |
|---|---|---|---|---|
| L1 | eligibility_gate | 数据完整 / 池成员 / 停牌 / 流动性 / 上市时间 | 必过 | 必过 |
| L2 | risk_gate | 单仓上限 / 板块上限 / 组合回撤 / PR-L 熔断 | 必过 | 必过 |
| L3 | cost_gate | 换手率 / 冲击成本 / 折溢价 / 双边成本 | 必过 | 必过 |
| L4 | ev_gate | EV = 胜率×平均赚 -(1-胜率)×平均亏 > 0.5% | 跳过 | 必过 |

---

## 六、通知时机 (高价值低噪声, 复用飞书 webhook)

删掉了"每几分钟一条日内异动"这类噪声推送, 收敛为 5 类:

| 时机 | 内容 | 频率 |
|---|---|---|
| 月度再平衡信号生成 | 核心 ETF 轮动换仓建议 (排名变化 + EV gate 结论) | 月度 |
| 卫星题材事件命中 | 题材发酵 / 事件触发 + 建议动作 | 事件驱动 |
| 风控告警 | 止损 / 回撤熔断 / 黑天鹅 / 单仓超限 | 实时 |
| 数据/任务健康异常 | 数据源过期 / 同步失败 / cron 失败 | 异常即推 |
| 周度复盘报告 | 组合表现 + 归因 + 下周关注 | 周度 |

---

## 七、关键规模

| 维度 | 数量 |
|---|---|
| 候选 ETF 池 | 46-63 只 |
| 稳态持仓 | 核心 4-6 只 ETF + 卫星 3-4 只题材股 |
| 核心因子 | 4 (Value / Quality / LowVol / Momentum-shadow) |
| 注册表策略 | 1 (ETFRotationStrategy; 原 29 个股策略已删) |
| 单仓上限 | ETF 15% / 题材股 5% |
| 桶上限 | 核心 70% / 卫星 20% / 现金 10% |

---

> 详细设计: \`docs/SIGNAL_FIRST_PLAN.md\` §4;
> 引擎实现: \`docs/trader-system/20_alpha_engine_overview.md\`.
`;

export const SYSTEM_MANUAL_MD = `# 操作手册

> 端到端指南: 新手 / 高阶两条路径. 完整版见 \`docs/USER_GUIDE.md\`.

---

## 1. 登录

1. 浏览器打开系统地址 (部署后由管理员告知)
2. 输入用户名 / 密码
3. 首次登录默认进入 **/home 主页**

> 忘记密码: 联系管理员重置 (不开放自助重置).

---

## 2. 新手路径 — 看 \`/home\` 主页就够

- **账户总览**: 总资产 + 今日盈亏 + 累计回报 + 可用现金 + 30 日走势
- **核心 ETF 排名**: 本月因子分 top ETF + 换仓建议 (买/卖/持有) + confidence
- **卫星题材**: 当前命中的题材事件 + 建议动作 (受 EV gate + 5%/20% 上限约束)
- **现金**: 应急 + 收益现金 (国债/短融 ETF) 占比
- **我的持仓**: 卡片网格 + 浮盈 + 一键卖出, 红涨绿跌 A 股惯例

### 想学背后逻辑 → 简易版

\`/workspace/easy\` 4 步教学: 选模板 → 跑回测 → 看结果 (年化/回撤/胜率) → 推模拟盘. 独占整屏, 暖纸色页面.

---

## 3. 高阶用户路径

### 3.1 持仓 \`/workspace/portfolio\`

实盘 / 模拟盘账户 + 持仓 + Fill 流水; AI 日记 + 错误模式 + 改进建议; 模拟盘管理 (CRUD + 自动跟单开关); 多盘对比.

### 3.2 实验室 \`/workspace/lab\`

回测 + 回测对比 + Walk-forward + 优化历史 + OverfitMetrics + 策略排行. 接一键回测 (7 关), 不接已删的个股策略.

### 3.3 设置 \`/workspace/settings\`

个人中心; 风险参数中心; 组合构造 (核心/卫星/现金 比例 + sizing policy); 通知渠道矩阵.

### 3.4 数据中心 \`/workspace/data\` (admin)

数据健康度看板; 行情同步状态 + 一键补抓; 调度任务列表 (admin 可手动触发 / 暂停); 系统日志.

---

## 4. 核心 ETF 换仓怎么看

1. 主页"核心 ETF 排名"或再平衡通知 → 看本月 top4-6 + 掉出 top6 的卖出建议
2. 每条建议带 confidence (Wilson 下界真实胜率) + gate 结论
3. 月度触发 (每月末计算, 次月首日 9:40 后分批执行), **不设单笔止损** (ETF 波动小)

## 5. 卫星题材怎么看

1. 题材事件命中会推送 (detector 报启动/爆发)
2. 过 EV gate (EV > 0.5%) 才建议建仓
3. 退出规则: -15% 硬止损 / +20% 止盈 / 21 交易日 / -7% 主动止损 (带缓冲)
4. 卫星有硬边界: 单只 5% / 总仓 20% / 60 日累计亏 > 组合 5% 冻结 30 天 / 连续 3 月 alpha<0 永久停

## 6. 通知 / 告警怎么收

设置 → 通知渠道矩阵: 行 = 事件类型 (再平衡 / 题材命中 / 风控 / 数据健康 / 周报), 列 = 飞书个人 / 飞书 OPS 群 / Email / In-App.
`;

export const SYSTEM_CHANGELOG_MD = `# 更新日志

> 本轮「Signal-First + 核心-卫星」重构: 把系统从"29 策略个股融合 + 多维分析引擎 + 日内高频"收敛到"ETF 因子轮动主线". 决策档 \`docs/SIGNAL_FIRST_PLAN.md\`, 执行档 \`docs/REFACTOR_PLAN.md\`.

---

## 重构批次 (Signal-First)

| 批 | 关键改动 |
|---|---|
| 批1 | 删空壳 (layers/ L1-L8 + quant/engine barrel) |
| 批2 | 删日内 (services 日内类 + jobs burst + 日内表 + 前端日内 tab) |
| 批3 | 删融合/策略/引擎瘦身 (D10-A): 删 29 个股策略 + QuantFusionService, 注册表只留 1 个 ETF 因子策略 |
| 批4 | 删社媒情绪数据源 (KOL / 情绪 / 问答 / 大宗; 龙虎榜/北向保留供查看) |
| 批5 | 改造: 4 因子 ETF 化 + PaperTrading 接 EV gate + AIInvestmentSignal schema + 通知时机收敛 |
| 批6 | 新建: ETFRotationService / FactorCalculator / ConfidenceCalibrationService / AutoExitService |
| 批7 | 前端装饰清理 (删飞线/数字滚动/扫光/3D tilt) + 删 AnalysisEngine shadow 全栈 + docs/scripts 清理 + 系统介绍重写 |
| 批8 | models 物理删表 (D7 直删 + pg_dump 备份) |

---

## 已删除的旧架构 (备忘)

- **29 个股策略** (Trend/Breakout/Reversion/Momentum/MultiFactor/DragonHead/HighDividend/Earnings/Northbound/Ensemble/SectorRotation/Linkage) — 融合毒源, 95 笔 0% 胜率
- **多维分析引擎** (8 analyzer + DecisionAggregator + shadow/hard 灰度) — shadow 实验, 已删
- **日内高频** (开盘抢筹 / 日内价量异动 / 尾盘动量 / 涨停板 / 竞价) — 噪声推送源
- **L1-L8 分层空壳** + **22 个股 factor 信号工厂** — 与 ETF 主线无关

---

> 完整删码清单: \`docs/SIGNAL_FIRST_PLAN.md\` §7; 早期历史: \`docs/audit/\`.
`;

export const SYSTEM_ARCHITECTURE_MD = `# 系统架构图

> 当前架构对应核心-卫星主线 + Gate 4 层 + 月度再平衡 + 卫星自动退出 + 复盘/校准闭环.
> 本页上方嵌入实时拓扑图组件 \`SystemTopologyMap\`; 下方文本版与之对应.

---

## 一、模块关系 (一图概览)

\`\`\`
        ┌────────────────────────────────────────────────┐
        │  数据层                                          │
        │  A 股 + 46-63 只候选 ETF + 成分股 / 财务 / 宏观   │
        │  point-in-time 快照 · 双源校验 · 龙虎榜/北向只读  │
        └────────────────────────────────────────────────┘
                            ↓
        ┌────────────────────────────────────────────────┐
        │  核心 ETF 因子层 (quant/etf/)                    │
        │  ETFConstituentExpander → ETFFactorService       │
        │  Value 0.40 / Quality 0.30 / LowVol 0.30 /       │
        │  Momentum 0.0 shadow → etf_total_score           │
        └────────────────────────────────────────────────┘
                            ↓
        ┌────────────────────────────────────────────────┐
        │  排名 + 换仓 (quant/etf/ · services/etf/)         │
        │  ETFRankingService: top4 买 / top6 卖 缓冲带      │
        │  → 目标权重 (70% 硬顶 + 15% 封顶)                 │
        │  ETFRotationService: confidence + rebalance_id    │
        │  → AIInvestmentSignal(action=TARGET_WEIGHT)       │
        └────────────────────────────────────────────────┘
                            ↓
        ┌────────────────────────────────────────────────┐
        │  卫星题材层 (services/exit/ + detector)           │
        │  ThemeFermentation → EV gate → 建仓 (≤5%/≤20%)   │
        │  AutoExitService: -15% 硬止损 / +20% 止盈 /       │
        │  21 日时间退出 / -7% 主动止损 / 60日冻结 / 永久停  │
        └────────────────────────────────────────────────┘
                            ↓
        ┌────────────────────────────────────────────────┐
        │  Gate 4 层 (fail-closed)                         │
        │  L1 eligibility + L2 risk + L3 cost (必过)       │
        │  L4 ev_gate (仅卫星; 核心月度排名替代)            │
        └────────────────────────────────────────────────┘
                            ↓
        ┌────────────────────────────────────────────────┐
        │  执行 + 对账                                     │
        │  次月首日 9:40 分批限价 / VWAP + 折溢价 gate     │
        │  broker-bridge (ed25519, KillSwitch fail-safe)   │
        │  Reconciliation cron (30min)                     │
        └────────────────────────────────────────────────┘
                            ↓
        ┌────────────────────────────────────────────────┐
        │  复盘 + 校准 + 战略镜子                          │
        │  ConfidenceCalibrationService (Wilson 下界)      │
        │  DailyAttribution → AIDiary → ImprovementSuggest │
        │  月度战略镜子 6 题 (切换/卫星停/主线证伪 阈值)    │
        └────────────────────────────────────────────────┘
                            ↓
        [反馈] → confidence 回灌 sizing / 卫星熔断判定 → 回信号层
\`\`\`

---

## 二、注册表瘦身 (D10-A)

\`quant/engine/\` 的 \`StrategyRegistry\` / \`StrategyEngine\` 骨架保留 (7 关回测 / PaperTrading / 绩效看板反向依赖), 但注册表只剩 **1 个 ETF 因子策略** (\`ETFRotationStrategy\`); 原 29 个股策略 + \`QuantFusionService\` 已删.

---

## 三、参考文档

| 文档 | 内容 |
|---|---|
| \`docs/SIGNAL_FIRST_PLAN.md\` | 决策档: 目标 / 主线设计 §4 / gate §5 / 删码 §7 |
| \`docs/REFACTOR_PLAN.md\` | 执行档: 逐模块处置 + 分批 + 回滚 |
| \`docs/trader-system/20_alpha_engine_overview.md\` | ETF 因子引擎总览 |
| \`docs/trader-system/21_alpha_factor_library.md\` | 4 因子详解 |
| \`docs/trader-system/40_portfolio_construction.md\` | 核心/卫星/现金 组合构造 |
| \`docs/trader-system/42_rebalancing.md\` | 月度轮动 + 卫星退出 |
| \`backend/src/quant/strategies/ETFRotationStrategy.ts\` | 主线策略 |
| \`backend/src/constants/cronRegistry.ts\` | cron 任务事实源 |
`;
