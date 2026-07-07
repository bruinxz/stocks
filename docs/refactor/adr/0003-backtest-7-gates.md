# ADR-0003 · Backtest 7 Gates

**状态**：Accepted（沿用 v1.0 · v1.1 追加卫星子层 gate-negative-coverage v0.3 联动）
**签发日期**：2026-07-08 追加 · 原 v1.0 早于本轮 · Orchestrator 融合定稿
**签发人**：Orchestrator（自签 · li-yiming msg=bf74c64c 全权授权）
**Owner**：QADocs 主
**关联**：§Gate-Negative-Coverage-v0.3 · 40-quality-gates.md

---

## §3.1 7 Gates 目录

| Gate # | 名称 | 断言 | Source |
|--------|------|------|--------|
| G1 | PIT 校准 | `available_at ≤ t` 严格 PIT | fundamental_pit + daily_bars |
| G2 | 权重合规 | §11.1 权重（0.40/0.30/0.30/0.0） | 真实历史 Phase 1 |
| G3 | 转移矩阵有效性 | Regime transition 概率归一化 | markov_state_estimator |
| G4 | 因子稳定性 | SeededRandom · rolling window IC > 0.05 | 因子引擎 |
| G5 | 交易成本模型 | Commission + slippage 合理 | order_execution_sim |
| G6 | Regime 分箱有效性 | VIX 分箱 5 段 · 分布均匀 | regime_gate |
| G7 | Walk-forward 前向验证 | in-sample vs out-of-sample IC 一致 | walk_forward_validator |

## §3.2 v1.1 卫星子层追加（新增 G6 反例扩展）

- G6 regime 分箱有效性 · 追加卫星子层 `ENABLE_US_DRIVER_SIGNAL` 双态转移正确性
- 反例矩阵参照 §Gate Negative Coverage v0.3（`40-quality-gates.md` §Gate Negative Coverage v0.3）
- Task #28 承接 G6 静态断言扩展（v1.1 追增位 §Backtest-7-Gates-Cluster）

## §3.3 Cross-Ref

- QADocs `test_backtest_gate_g1_pit_calibration.py`（G1）· `test_backtest_gate_g2_weight_compliance.py`（G2）· G3-G7 对应 test 文件按本 ADR §3.1 gate # 命名
- Task #28 承接位（§Backtest-7-Gates-Cluster · v1.1 追增队列位）
- ADR-0001 §10.8 权重合规验证锚点 · §附录 §10.8-satellite-footnote
- ADR-0002 · US-038 Math.random Lint Rule（G4 SeededRandom 联动）

---

**End of ADR-0003 v1.1**
