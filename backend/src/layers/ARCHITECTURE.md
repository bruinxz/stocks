# Backend Vertical Architecture — 8-Layer Decision Pipeline

> Sprint 24 重构. 把横向 (按功能域: research / portfolio / execution / governor / meta) 改成**纵向交易决策流水线**.
> 110 个 .ts 不物理移动, 通过 `layers/L*/index.ts` barrel re-export 暴露逻辑分层.
> 新代码用 `import { foo } from '../layers/L4_construction'`, 旧 import 路径继续工作.

## 决策流水线图

```
       ┌──────────────────────────────────────────────────────────┐
       │                  Trade Decision Pipeline                 │
       └──────────────────────────────────────────────────────────┘
              │
              ▼
   ┌──────────────────────┐
   │  L1 — Data           │  DailyBar / Fundamental / Northbound / Limit-up
   │  数据接入             │  PIT (财务发布期限 / 指数成分历史) / Quality
   └──────────────────────┘
              │ (raw bars + factors)
              ▼
   ┌──────────────────────┐
   │  L2 — Signal         │  30+ Strategies (Minervini/VCP/Turtle/Donchian/etc)
   │  策略 + 因子 + 形态   │  Patterns (Sprint 13/21 — 15 Bulkowski patterns)
   │                      │  Factors (Barra-CN / Fama-French / Alpha 101)
   │                      │  ML foundation (RF/GB/AdaBoost/ARp)
   └──────────────────────┘
              │ (strategy scores + factor scores)
              ▼
   ┌──────────────────────┐
   │  L3 — Meta Decision  │  MetaLabelService (二阶分类器决定是否下注)
   │  元决策 + 仓位        │  Bet Sizing (AFML Ch.10 — Eq.10.3/10.4)
   │                      │  Triple Barrier labeling + Purged K-Fold CV
   │                      │  Sample weights (uniqueness / time-decay)
   │                      │  Online learning (SGD / Hoeffding)
   └──────────────────────┘
              │ (signed bet size, fractional position)
              ▼
   ┌──────────────────────┐
   │  L4 — Construction   │  PortfolioConstructionService facade
   │  组合权重 + 风险预算   │  HRP / NCO / Black-Litterman / Risk Parity
   │                      │  Brinson Attribution + MCR + Style Cap
   │                      │  Crowding score + Vol Targeting
   │                      │  Convex (LP/QP/SOCP/SDP) + OSQP solver
   │                      │  Thompson sampling (strategy weight allocation)
   └──────────────────────┘
              │ (target portfolio weights)
              ▼
   ┌──────────────────────┐
   │  L5 — Feasibility    │  ExecutionFeasibilityService facade
   │  执行可行性           │  Almgren-Chriss / Bouchaud sqrt impact
   │                      │  Microstructure: Kyle Lambda, Glosten-Milgrom, PIN
   │                      │  Call auction / iceberg / TCA
   │                      │  RL execution scheduling
   └──────────────────────┘
              │ (fillable_score, executable quantity)
              ▼
   ┌──────────────────────┐
   │  L6 — Risk Layer     │  9 Pre/Post-trade Guards (US-047..US-089)
   │  风控 + 防御          │  DrawdownCircuitBreaker / BlackSwanWatchdog
   │                      │  HMM regime detection (v5)
   │                      │  Strategy capacity + Alpha decay monitor
   └──────────────────────┘
              │ (block / allow / warn)
              ▼
   ┌──────────────────────┐
   │  L7 — Governor       │  EquityCurveGovernorService facade
   │  资金曲线治理         │  Carver: forecast scaling + FDM + vol target
   │                      │  Vince: optimal-f + leverage space + risk of ruin
   │                      │  DQS + Freeman-Shor + Pre-mortem (Sprint 10)
   │                      │  Trader Mind Deep: Reason Triplet + 5 Wizards (Sprint 22)
   └──────────────────────┘
              │ (sizing multiplier, kill switch)
              ▼
   ┌──────────────────────┐
   │  L8 — Reflection     │  ResearchIntegrityService facade (PBO / DSR)
   │  复盘 + 归因          │  MLfAM Ch.2-8 (NCO / VI / ONC / Trend Scanning)
   │                      │  Aronson (Bonferroni / White RC / FDR)
   │                      │  CPCV + Bootstrap CI for PBO
   │                      │  Causal inference (DML / PSM / IV)
   │                      │  PCA + Fama-French + GARCH/EGARCH/HAR-RV
   │                      │  TradeComplianceChecker (Sprint 24 hook)
   └──────────────────────┘
              │
              └─→ 反馈 kill_switch / param_tuning 回 L2 / L3
```

## 8 层职责一句话总结

| Layer | 职责 | 主要消费者 |
|-------|------|----------|
| **L1 Data** | 数据接入 + PIT 合规 + 质量检查 | L2..L8 |
| **L2 Signal** | 策略 / 因子 / 形态识别 → raw signals | L3..L8 |
| **L3 Meta** | 二阶过滤 + 标签 + bet sizing → "做不做 + 做多大" | L4..L8 |
| **L4 Construction** | 风险预算 + 权重分配 → target portfolio | L5..L8 |
| **L5 Feasibility** | 涨跌停 / 流动性 / 冲击成本 → executable order | L6..L7 |
| **L6 Risk** | Pre/Post-trade 9 guards + circuit breakers | L7..L8 |
| **L7 Governor** | 资金曲线监控 → 动态升降风险, kelly fractional | L8 |
| **L8 Reflection** | 复盘 + DQS + Wizard 合规 + 研究严谨性审计 | (反馈 L2/L3) |

## 依赖方向约束

**单向流: L1 → L2 → L3 → L4 → L5 → L6 → L7 → L8**

- 任何 L_i 可以读 L_1..L_{i-1} 的导出
- L_i **不可以**读 L_{i+1}..L_8 的导出 (反向依赖 = 循环风险)
- 同 layer 内 service 之间可自由互相 import (内部解耦)

例外:
- L1 (PIT 数据合规) 同时被 L6 用作"事后风控分析" — 这是 layer 内重 export, 不违反方向
- L6 HMM regime detection 既可读 L1 数据, 也被 L2 strategy 反向用于 regime-aware multiplier — 这是 layer-skip read, 通过 `inferLocalRegime` (Sprint 24) 抽到 L2 内, 不绕回 L6

## 如何使用 layer barrels

```ts
// ✅ 推荐 — 新代码用 layer barrel
import { ncoComplete, brinsonAttribution, portfolioVolTargeting } from '../layers/L4_construction';
import { vcpPatternMultiplier, inferLocalRegime } from '../layers/L2_signal';
import { computeQuantPostmortemScore } from '../layers/L7_governor';

// ⚠️ 也支持 — 旧代码不必改, 直接路径 import 继续工作
import { ncoComplete } from '../services/research/mlfam-afml-complete';
```

## 决策树: 新功能应该放哪一层?

```
新功能要做什么?
├── 拉/清洗外部数据                              → L1
├── 从数据算 score / signal / pattern            → L2
├── 用模型决定 "信号要不要做" / 算仓位            → L3
├── 多 signal → portfolio weights / 风险预算     → L4
├── 算 "这笔订单能不能成交 / 滑点多少"            → L5
├── 实时阻止违规订单 / 写 RiskAlert              → L6 (放 portfolio/risk/)
├── 监控资金曲线 → 自动升降风险                  → L7
└── 复盘单笔 / 整体研究质量审计                   → L8
```

## 物理 migration roadmap (未来, 不在 Sprint 24 scope)

当前: 110 个 .ts 物理位置不动 + 8 个 layer barrel re-export.

未来 (单独 PR):
1. 移动 `services/research/*.ts` 中纯研究函数 → `layers/L8_reflection/internal/`
2. 移动 `services/portfolio/*.ts` → `layers/L4_construction/internal/`
3. 移动 `services/meta/*.ts` → `layers/L3_meta/internal/`
4. 移动 `services/execution/*.ts` → `layers/L5_feasibility/internal/`
5. 移动 `services/governor/*.ts` → `layers/L7_governor/internal/`
6. `sed` 批量改 `import` 路径
7. ESLint `no-restricted-imports` rule 强制 L_i 只能 import 自 layers/L_{j<=i} 子目录

直到那时为止, ARCHITECTURE.md + 8 个 barrel 是 layer 边界的**唯一文档化来源**.
新代码 review 应检查: "这个 import 是从更下层 layer 进来的吗?"
