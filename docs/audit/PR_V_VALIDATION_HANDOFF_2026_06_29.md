# PR-V — 部署后 5 维度回测验证 handoff

> 上游: PR-P (#58) merged at 2026-06-29 18:48 UTC. 13 PR (PR-A/B/C/D/E/F/H/L/M1/M2/M3/M4/N/O2/O3/O5/P) 全部 merge 到 main.
> 当前 main HEAD: `0ac4cda` (= PR-P merge commit)
> 本文档目的: 给后续验证 agent (PR-V) 一份独立可执行的 handoff, 不依赖本 session 的对话历史.

## 任务概览

部署 (PR-P 内) 因 prod SSH 锁住延后到下一窗口. 当 deploy 完成后, PR-V agent 跑以下 **5 维度验证**, 输出报告到 `docs/audit/post_deployment_validation_2026_06_29.md` (覆写或新建).

如果部署未完成 → PR-V 先验证 main 分支代码而非 prod 行为, 用本地数据回填.

## 验证 5 维度

### 维度 1: PR-K 30 天回测 — 胜率提升

PR-L 内 PR-K 回测确认 **当前系统胜率 32%, 在亏钱** (paper auto 已紧急停 + conf gate 加 + UI warn 加).

PR-V 要回答: **新加 4 detector (PR-M2/M3/O2/O3/O5) 后, 真实胜率提升到了多少?**

**步骤**:
1. 跑 `backend/src/scripts/backtest-recent-recommendations.ts` 或同款脚本 (在 PR-K 回测里找一遍, 复用)
2. 回测窗口: 2026-05-29 ~ 2026-06-29 (30 天) — 与 PR-K 同窗口
3. 输出按 3 维分桶:
   - **by timing_tag**: opening_rush / afternoon_kick / closing_grab / overnight / intraday_anomaly
   - **by source_type**: opening_rush_detector / limit_up_board / theme_fermentation / industry_sentiment_aggregate / intraday_reversal / intraday_momentum / intraday_price_volume_anomaly / last_hour_momentum / (旧 source: ai_signal / quant_pipeline / etc.)
   - **by confidence_score 分桶** (含 SourceTypeWinRateAdjuster 修正后): [0, 0.5), [0.5, 0.6), [0.6, 0.7), [0.7, 0.8), [0.8, 1.0]
4. 算每桶 win% + avg_return_pct + total signals

**接收标准 (AC)**:
- 整体 win% > 50% → 系统好
- 整体 win% ∈ [40%, 50%) → 进步显著但仍亏钱, 改 conf gate 阈值再开 paper auto
- 整体 win% < 40% → 维持紧急停损 + 写第二轮诊断

### 维度 2: PR-J 存储模块 (11 只) — 真抓到了吗?

PR-J 之前对存储板块的覆盖率 **0/11**. 经 PR-N (修 3 层数据盲区: universe 含 sh.688/sz.001/sz.301 + daily_bars sync 全 A + realtime_quotes 板块多样性), 现在能抓到了吗?

**步骤**:
1. 在 `stocks` 表 + `daily_bars` + `realtime_quotes` 三层各跑一遍 11 只存储票的 universe coverage check
2. 11 只清单: PR-J 报告中应有具体列表, grep `docs/audit/` 找
3. 输出: 每只是否在 universe / daily_bars / realtime_quotes 三层覆盖

**AC**: 11/11 全部 3 层覆盖.

### 维度 3: 6 个新 detector 在今日真实 prod 数据上的命中数

跑下面每个 detector 一次 (dry_run=true), 看每个返多少 hit:

| Detector | 期望 trade_date | 期望 hit/day |
|---------|---------------|------------|
| OpeningRushDetector | 2026-06-29 | 5~30 |
| IntradayPriceVolumeAnomalyDetector | 2026-06-29 | 10~50 (6 type × 5~10 avg) |
| LastHourMomentumDetector | 2026-06-29 | 5~20 |
| LimitUpBoardDetector | 2026-06-29 | 50~150 (20 pattern × 4~7 avg) |
| ThemeFermentationDetector | 2026-06-29 | 0~3 (主线切换事件) + 全部板块分类 |
| IndustrySentimentAggregator | 2026-06-29 | 30~70 板块 |

调用例:
```bash
cd /opt/stocks/current/backend
node -e "
(async()=>{
  const o = require('./dist/services/OpeningRushDetector').openingRushDetector;
  const r = await o.runOnce({dry_run:true, force:true});
  console.log('OpeningRush:', r.scanned, 'matched=', r.matched, 'by_pattern=', JSON.stringify(r.by_pattern));
})();
"
# 同款 6 次
```

**AC**: 6 detector 至少 4 个有 ≥ 5 hit (说明 detector 接通了 + 真数据有触发).

### 维度 4: 5 timing × 战法库映射真验证 (PR-I-v2 Part E)

PR-I-v2 报告战法库总落地率 = 14.8%. 经 PR-O2/O3/O5 + PR-M2/M3 + PR-P cron 接通, 现在多少?

**步骤**:
1. 读 `docs/research/strategy-library-overview.md` (PR-I-v2 报告) Part E 矩阵
2. 对每个 timing × 战法格子, 验证 **真消费**:
   - opening_rush 真消费 overnight_signals + auction_snapshots? (查 OpeningRushDetector 源码 import + 跑出来)
   - intraday_anomaly 真有价量 detector 输出? (查 IntradayPriceVolumeAnomalyDetector 源码 + 跑出来)
   - closing_grab 真用 last hour momentum? (查 LastHourMomentumDetector 源码 + 跑出来)
   - 5 timing × 122 战法的落地数 / 总数 = ?%
3. **战法库落地率从 14.8% → ?%** — 关键 KPI

**AC**: 落地率 > 30% (翻倍).

### 维度 5: Paper trading 模拟

假设把 paper trading auto_trade_enabled 再开一周 (基于新模型新 detector), 预估 PnL.

**步骤**:
1. 用维度 1 的 30 天历史回测结果, 算 sliding window 7 天的 avg_return + sharpe + max_drawdown
2. 按维度 4 的落地率 + 维度 1 的胜率推算未来 7 天 expected PnL 区间
3. 输出 expected PnL 区间 ± 1σ

**AC**: P10 (悲观) > -2%, P50 > 0%, P90 > +3% → 可恢复 auto_trade; 否则继续紧急停.

## 输出格式

写到 `docs/audit/post_deployment_validation_2026_06_29.md`, 包含:

```markdown
# Post-deployment validation (2026-06-29)

## 0. 部署状态
- SSH unlocked? Y/N
- 5 张新表创建? Y/N (列表)
- 7 个新 cron 注册并 active? Y/N (列表)
- /home 200? Y/N

## 1. PR-K 30 天回测 — 胜率
- 整体 win%: 旧 32% → 新 X%
- 按 timing 分桶 (表)
- 按 source 分桶 (表)
- 按 conf 分桶 (表)
- AC: PASS / FAIL

## 2. PR-J 存储 11 只 — 覆盖率
- 11 只覆盖率: 旧 0/11 → 新 X/11
- AC: PASS / FAIL

## 3. 6 detector 今日命中
- (表)
- AC: PASS / FAIL

## 4. 战法库落地率
- 旧 14.8% → 新 X%
- AC: PASS / FAIL

## 5. Paper trading 预估
- 7 天 PnL P10/P50/P90
- AC: PASS / FAIL

## 综合结论 + 下一步建议
```

## 启动方式 (PR-V agent 入口)

新启一个会话, 把本文件路径喂给它即可:

```
请按 docs/audit/PR_V_VALIDATION_HANDOFF_2026_06_29.md 跑 5 维度验证, 写报告到
docs/audit/post_deployment_validation_2026_06_29.md.

agent: 90 min+ 无 progress → 退出 + 写部分结果.
不引新 npm. 跑回测优先 reuse 现有 backtest-recent-recommendations.ts.
```
