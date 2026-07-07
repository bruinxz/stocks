# 40 · Quality Gates（质量门禁）

**Owner**：QADocs 主 · Orchestrator 融合定稿
**关联**：ADR-0001 §10.8-satellite-footnote · ADR-0002 US-038 · ADR-0003 backtest-7-gates · Strategy §Q7 双态权重 · Data v1.1 §3 E4

---

## §Gate Negative Coverage v0.3 · 卫星层扩展

**签发依据**：QADocs v1.1 追增队列第 4 位 · Task #27 `test_gate_negative_coverage_v0_3.test.ts`（追增位）

**语义**：Gate 负例覆盖度纪律扩展至卫星层 5-slot / 4-slot 权重合规验证

### 主态 5-slot 负例矩阵（`ENABLE_US_DRIVER_SIGNAL=true`）

| 反例 # | 场景 | 期望 gate 触发 | 期望结果 |
|-------|------|--------------|---------|
| N-1 | `us_driver` 权重被误设为 0.20（非 0.30） | §Q7.1 权重校验 | 单测 fail |
| N-2 | 权重和 != 1.000（e.g. 0.30/0.25/0.15/0.15/0.10 = 0.95） | 归一化断言 | 单测 fail |
| N-3 | Alpha Vantage 24h 内失败 4 次 · gate 未触发切态 | `US_DRIVER_SOURCE_HEALTHY` gate | 断言 unhealthy |
| N-4 | `fixture_ref_*` 出现在 §11.1 权重合规验证 import 侧 | §10.8 静态扫描 | 静态断言 fail |

### 回落态 4-slot 负例矩阵（`ENABLE_US_DRIVER_SIGNAL=false`）

| 反例 # | 场景 | 期望 gate 触发 | 期望结果 |
|-------|------|--------------|---------|
| N-5 | 4-slot 权重和 != 1.000（tie-break +0.001 未加） | 归一化断言 | 单测 fail |
| N-6 | tie-break +0.001 落在 `history_response`（非 `news_evidence`） | §Rounding-Tie-Break 断言 | 单测 fail |
| N-7 | `data_source` 写入 `TUSHARE_PRO` 或 `MERGED`（v1 冻结期） | 写侧 gate | throw error |
| N-8 | `total_assets = 0` 时 `roa` 未 NULL | 保护逻辑 | 单测 fail |

### Q8 词表负例矩阵

| 反例 # | 场景 | 期望 gate 触发 | 期望结果 |
|-------|------|--------------|---------|
| N-9 | 新增 slug 未走 CODEOWNERS Strategy + QADocs 双签 | pre-commit / CI | PR reject |
| N-10 | 词条字面命中 catalyst 词典 baseline | jscpd baseline 强制 | PR reject |
| N-11 | 移除 `us_driver_source_unavailable_watch` slug | schema shape 断言 | 单测 fail |

**CI 门禁位**：`test_gate_negative_coverage_v0_3.test.ts`（**硬门禁**）· QADocs Task #27（v1.1 追增队列 20 → 24 项 · 新追 4 位承接 §Gate-Negative-Coverage-v0.3 / §Backtest-7-Gates-Cluster / §No-Math-Random-US-038 / §Gitleaks-Baseline-Guard）

---

## Cross-References

- Orchestrator msg=84fa4b84 · M-Draft 挪入终裁
- Orchestrator msg=656c8cf4 · License 政策放宽令 v1
- ADR-0001 §附录 §10.8-satellite-footnote
- ADR-0002 US-038 Math.random Lint Rule
- ADR-0003 Backtest 7 Gates
- ADR-0007 quality-factor-fallback
- Strategy §Q7 双态权重表
- Data v1.1 §3 E4
