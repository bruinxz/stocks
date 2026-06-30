# PR-T — 紧急停损解除评估 (2026-06-30)

**结论: 保持 PR-L 紧急停损 (paper auto-trade off + 前端警示 banner + "手动评估" 按钮)**

PR-S 修复了 4 个表面 P0 bug, 但**未触及 PR-K 30 天回测发现的"模型反向 + 实盘亏损"根因**.
回测/实盘数据继续支持 fail-closed.

---

## 1. 数据评估

### 1.1 验证窗口 & 数据可用性

- **PR-S merge 时间**: 2026-06-30 14:33 +0800 (merge commit ab7505c, deploy 06:23 UTC ≈ 14:23 +0800)
- **评估时间**: 2026-06-30 15:00 +0800
- **窗口 1 (PR-S 部署后 ~40 分钟)**: 5 条 signal (全部 `intraday_price_volume_anomaly`, BUY, conf 72-82)
- **窗口 2 (最近 24h)**: 110 条 signal (79 PVAnomaly + 31 quant_recommendation)
- **窗口 3 (30d 基线, 与 PR-K 同口径)**: 219 条 BUY-like signal 有 T+1 close 数据

### 1.2 24h / 30d 信号层 win% (T+1 close vs signal_date close)

| 窗口 | n | win% | avg_ret | avg_conf |
|---|---|---|---|---|
| 14 天 (BUY-like, 2026-06-15 ~ 2026-06-29) | 15 | **60.0%** | +0.57% | 69.4 |
| 30 天 (PR-K 同口径) | 219 | **48.4%** | +0.28% | — |
| → quant_recommendation | 167 | 47.3% | +0.28% | — |
| → tradingagents | 52 | 51.9% | +0.30% | — |
| → confidence ∈ [80,100) | 77 | **44.2%** ⚠️ | — | — |
| → confidence ∈ [70,80) | 66 | 53.0% | — | — |

**关键发现**:
- **高置信度 (≥80) win% 反而最低 (44.2%)** — PR-K 报告的"反向偏差"仍然存在.
- 信号层 30 天 win% = 48.4% (PR-K 当时报 32%, 略有改善但仍 < 50%).
- 14 天小窗 win% = 60% 但样本只 15 条, **样本量严重不足**.

### 1.3 实盘 (paper trading) 表现

- **已平仓 95 笔**: **0 笔盈利** (0% win rate), avg PnL -8.04%
- **未平仓 67 笔**: 13 浮盈 / 54 浮亏, avg -0.82%
- **94 / 95 平仓原因 = "触发止损"**, 仅 1 笔触发移动止盈
- 所有 portfolio 当前 `auto_trade_enabled = false` (PR-L 已生效)

### 1.4 PR-S 4 个 bug 在 prod 的验证

| Bug | 验证 | 通过 |
|---|---|---|
| B1 推荐重复 (sh.600113 ×4) | 部署后 5 条 signal, 0 重复; (symbol, source_type, source_id) UNIQUE | ✅ |
| B2 跌票推 BUY | 部署后 0 条 BUY + `price_change_pct<0` 反例 | ✅ (但样本太少, `price_change_pct` 列今日全 NULL — 不能用此列结论, 看代码 guard 已生效) |
| B3 V3 dedup | 未直接打 endpoint (需 token); 单测 43/43 pass | ✅ (代码层) |
| B4 卡片箭头跳转 | 前端代码已合, prod assets 含编译产物 | ✅ (代码层) |

---

## 2. 判定逻辑 vs 任务定义

任务要求:
> 总 win% >= 50% AND PVAnomaly 跌票为 0 → **建议解除 PR-L**

实际情况:
- 总 win% (30d, 与 PR-K 同口径): 48.4% < 50% → **不达标**
- 高 conf win% (44.2%): 反向偏差仍在
- 实盘平仓 95 笔 0 盈利, 全部止损出场: **生产硬证据**
- PR-S 部署仅 40 分钟, 实盘验证窗口 = 0
- 14 天小窗 60% 看起来好, 但 n=15 (低于 20 阈值) → 任务定义为"数据不足"

**结论**: 三条判定线全部指向"保持停损":
1. 信号 win% < 50%
2. 实盘 win% = 0% (95/95 止损)
3. 部署后样本 n=5, 严重不足

---

## 3. 还要解决的问题 (解除前)

PR-S 修的 4 个 bug 是**数据展示层**, **不是模型层**. 真正引起 PR-K 32% win 的根因仍未触及:

1. **评分模型反向偏差** (PR-K 主结论): conf ≥ 80 的票 win% **比随机还低**, 提示 factor weight 符号或截面正负反了. 需要 alpha 团队复盘 factor IC / regime mismatch.
2. **止损逻辑过紧**: 95/95 平仓全因止损, 暗示 entry 价位或 stop 距离设置在波动正常区间内 → 几乎必然被打.
3. **执行价位 vs 信号价位偏差**: 实盘 entry 比信号高的话, 即使 signal 层 win% 50% 也无法在实盘盈利. 需要重做 PR-K 的执行偏差归因.
4. **`price_change_pct` 字段写入缺失**: 06-30 80 条 signal 该字段全 NULL — B2 修复依赖该字段的 caller path 之外的写入逻辑, 但 storage 端没保存值. 不阻塞 PR-T, 但下个迭代要补.
5. **样本量**: 解除前需要至少 1-2 个完整交易日 (≥ 50 条 BUY signal + T+1 close 数据) 才能复测 win%.

---

## 4. PR-T 决定

| 项 | 决定 |
|---|---|
| 前端 emergency banner | **保留** |
| 推荐卡 "手动评估 (暂停一键跟单)" 按钮 | **保留** |
| 后端 `EMERGENCY_CONF_GATE = true` | **保留** |
| `paper_trading_portfolios.auto_trade_enabled` | 全部 `false` (保留) |
| 新建 PR | **不需要** (无代码变更) |

---

## 5. 用户下次 `/home` 应看到的变化

**与 6-29 完全一致 (无变化)**:
- 顶部紫色 warning banner: "推荐系统处于评估期 — 仅供参考, 不要直接跟单"
- 每张推荐卡 CTA: 灰底 "手动评估 (暂停一键跟单)"
- 点击 CTA → 风险评估 Modal (引用 32% / -10,798 元) → "我已了解, 继续手动买入" 才走原下单流程
- 推荐卡整体可点 (B1/B3/B4 修复后 — 每只票只出 1 张卡, 右上角箭头可跳 `/stock/:symbol`)

下次解除条件 (复测建议):
- 等 1-2 个完整交易日, 累计 ≥ 50 条 BUY signal 有 T+1 close
- 同步看 paper portfolio 平仓 win% (不是只看信号 win%)
- conf ≥ 80 子集 win% ≥ 50% 是关键 gate (反向偏差消失的证据)

---

## 附录: 数据查询语句

```sql
-- 24h 信号 win% (PR-S 部署后, 实际 prod 数据查证)
WITH buys AS (
  SELECT id, source_type, symbol, signal_date, confidence_score, decision, created_at
  FROM ai_investment_signals
  WHERE UPPER(decision) IN ('BUY','STRONG_BUY','买入','看多')
    AND signal_date <= '2026-06-29'
    AND signal_date > '2026-05-30'
),
with_t0 AS (
  SELECT b.*, s.id AS stock_id, db0.close AS c0
  FROM buys b
  JOIN stocks s ON s.symbol = b.symbol
  JOIN daily_bars db0 ON db0.stock_id = s.id AND DATE(db0.time) = b.signal_date
),
with_t1 AS (
  SELECT wt0.*, (
    SELECT db1.close FROM daily_bars db1
    WHERE db1.stock_id = wt0.stock_id
      AND DATE(db1.time) > wt0.signal_date
      AND DATE(db1.time) <= wt0.signal_date + INTERVAL '10 days'
    ORDER BY db1.time ASC LIMIT 1
  ) AS c1
  FROM with_t0 wt0
)
SELECT source_type, COUNT(*), SUM(CASE WHEN c1 > c0 THEN 1 ELSE 0 END)::float / COUNT(*) as win_pct
FROM with_t1 WHERE c1 IS NOT NULL
GROUP BY source_type;

-- 实盘平仓胜率 (硬证据)
SELECT COUNT(*) as tot,
       SUM(CASE WHEN exit_price > entry_price THEN 1 ELSE 0 END) as wins,
       AVG((exit_price-entry_price)/entry_price*100) as avg_pct
FROM recommendation_trade_outcomes
WHERE exit_price IS NOT NULL AND entry_price > 0;
-- → tot=95 wins=0 avg=-8.04%

-- PR-S B1 dedup 验证 (post-deploy)
SELECT symbol, COUNT(*) FROM ai_investment_signals
WHERE signal_date='2026-06-30' AND created_at > TIMESTAMP '2026-06-30 06:23:51'
GROUP BY symbol HAVING COUNT(*) > 1;
-- → 0 rows (无重复)
```

—
Author: PR-T evaluation
Date: 2026-06-30 15:00 +0800
Branch: claude/pr-s-fix-4-p0-bugs (no code change — docs only)
