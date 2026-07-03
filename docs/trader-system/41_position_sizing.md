# 41 — 仓位算法（Position Sizing）

> 本文档已随重构改写，对齐核心 70% / 卫星 20% / 现金 10% 主线。核心 ETF 的仓位由**因子分比例缩放 + 硬顶封顶**决定（不用 Kelly/ATR 三轨那套个股逻辑）；卫星题材股才走 confidence 降权 + 硬上限。依据 `SIGNAL_FIRST_PLAN.md` §4.1 / §5.1 / §5.2。

---

## A. 操盘手心智

「信号告诉我买什么，仓位告诉我下多少钱。」但核心和卫星的下注逻辑完全不同：

- **核心 ETF**：ETF 本身已分散，波动小，不需要按单标的凯利/ATR 精算。直接**按因子分比例分配 → 缩放到核心总仓 70% → 单只封顶 15%**。简单、机械、可复现。
- **卫星题材股**：个股崩得快，必须严控。单只硬顶 5%，且用**校准后的 confidence（Wilson 下界）降权**——样本少、盈亏比差的 detector 自动小仓位甚至不下单（EV gate 拦截）。

核心不追求「每只精算最优仓位」，追求「守住 70% 硬顶 + 分散 4-6 只」；卫星不追求「打满 20%」，追求「亏得起、能被熔断兜住」。

---

## B. 系统设计

### B.1 核心 ETF 仓位（`ETFRankingService`）

```
raw_w_i    = etf_total_score_i / Σ(选中 ETF 的 score)
scaled_w_i = raw_w_i × 0.70        # CORE_TOTAL_CAP_PCT
final_w_i  = min(scaled_w_i, 0.15) # SINGLE_ETF_CAP_PCT
# 封顶溢出按分数再分配给未封顶 ETF（一轮再归一）
```

- 举例：选中 5 只、分数接近 → 每只约 14%（总 70%），都未碰 15% 顶
- 举例：某只分极高 scaled 到 18% → 封到 15%，多出 3% 分给其余 4 只
- total_score 可为负 → 分配前 shift 使 min ≥ 0，保证权重非负
- 遵 §0.4「规范 > 快」，不靠「持仓数碰巧」兑现 70% 上限

### B.2 卫星题材股仓位

- **硬上限**：单只 ≤ 5%，卫星总仓 ≤ 20%
- **confidence 降权**：`ConfidenceCalibrationService` 给每个 source_type 算 Wilson 下界 confidence + reliability bucket，低可信度桶降权 / 冷启动进纸面模式
- **EV gate 前置（§5.2 L4）**：`EV = confidence × avg_win_pct − (1−confidence) × avg_loss_pct`，EV > 0.5% 才下单（锚定手续费 0.13%×2 + 滑点 0.2-0.5%）
  - 例：胜率 40%、赚 15%、亏 8% → EV = 1.2% → 下单
  - 例：胜率 60%、赚 3%、亏 5% → EV = −0.2% → 拒绝（胜率高但赚小亏大）

### B.3 现金桶

- 5% 应急现金（货币基金，年化 ~2%）
- 5% 收益现金（国债 ETF 511010 / 短融 ETF 511360，年化 ~3%）
- 不做股票短线（压舱石）

### B.4 相关代码

| 模块 | 路径 | 职责 |
|---|---|---|
| `ETFRankingService` | `quant/etf/` | 核心 ETF 目标权重（比例缩放 + 封顶） |
| `ConfidenceCalibrationService` | `services/calibration/` | 卫星 confidence（Wilson 下界）+ 校准指标 |
| `SignalDrivenSizing` / `PositionSizingPolicy` | `portfolio/sizing/` `portfolio/` | 落地下单量计算（接 EV gate 结论） |
| `SizingPolicyService` / `SizingLimitConsistency` | `portfolio/risk/` | sizing 策略配置 + 上限一致性校验 |

---

## C. 边界

- 核心 ETF **不设单笔止损止盈**（波动小，月度换仓 + 组合级 PR-L 足够）。
- 旧的 Kelly / ATR / VolTarget「三轨取最小」个股仓位算法已不作为核心主逻辑；如仍保留于 `PositionSizingPolicy`，仅供卫星个股或回测复用，不驱动核心。
- 所有硬上限在 `risk_gate`（§5.2 L2）二次校验，sizing 违规会被 gate 拦下。
