# ADR-0007 · Quality Factor Fallback（简化技术降级文档）

**状态**：Accepted（简化版 · License 政策放宽令 v1 后）
**签发日期**：2026-07-08
**签发人**：Orchestrator（自签合入 · li-yiming msg=bf74c64c 全权授权）
**Owner**：Strategy 主起草 · DataPipeline reviewer · Orchestrator 定稿
**关联**：License 政策放宽令 v1（msg=656c8cf4）· 决策 2 = B（Baostock 唯一 Quality 源）· ADR-0008 / ADR-0009

---

## §1 背景与决策

### §1.1 前置决策链

- **决策 2 = B**（Orchestrator msg=656c8cf4 §五 · li-yiming msg=4f6d2466/ad6585cf 授权）
  - Baostock 免费主链 **唯一** Quality 数据源
  - Tushare Pro Token **不申请**（付费 200 元/月不启用）
  - `data_source` 3 值枚举保留（BAOSTOCK/TUSHARE_PRO/MERGED · TUSHARE_PRO v1 空 slot）

### §1.2 ADR 语义降级（License 政策放宽令 v1）

- **原语义**（License 硬门禁位）：Tushare Pro GPL 合规审查 · 双源分歧 > 5pp 阻塞合入 · 合规专责裁定
- **新语义**（技术降级方案位）：数据源覆盖度与派生精度技术评估 · 单源稳定性与断供应急响应 · 未来数据源演进技术前向兼容规划

---

## §2 Baostock Quality 覆盖度技术评估

### §2.1 因子覆盖矩阵（DataPipeline msg=be46f8bb 副签修正）

| Quality 因子 | Baostock 可用性 | 派生方式 | 精度可信度 |
|-------------|----------------|---------|-----------|
| ROE | ✅ 直接提供 (`roeAvg` via `query_profit_data`) | 透传 | ⭐⭐⭐⭐⭐ |
| 资产负债率 | ✅ 直接提供 (`liabilityToAsset` via `query_balance_data`) | 透传 | ⭐⭐⭐⭐⭐ |
| ROA | ⚠️ 无直接字段 · 派生覆盖 (`netProfit / totalAssets` 组合两 API join) | Baostock 派生 | ⭐⭐⭐⭐ |
| 毛利率 | ✅ 直接提供（`query_profit_data` MB 派生） | 透传/派生 | ⭐⭐⭐⭐ |

**结论**：Baostock 单源覆盖 V0 §11.1 Quality 权重 0.30 所需 4 因子（ROE 直接 + ROA 派生 + 资产负债率直接 + 毛利率直接）· 精度可信度 4+ 星 · 满足生产要求

### §2.2 精度一致性保证

- Baostock 无 `q_ROA` 直接字段（DataPipeline workspace `notes/70-quality-factor-fallback-baostock.md` §Quality-Factor-Fallback.2 权威表）
- ROA 走本地派生：`query_profit_data.netProfit / query_balance_data.totalAssets` · join by `(code, year, quarter)`
- `total_assets = 0` 或 NULL 保护 → `roa = NULL`（非 0/0 除零 · QADocs `test_fundamental_pit_schema_v1_1.py` 断言 D 覆盖）
- Baostock 财报数据延迟：季报公告后 T+1 到位 · 与 A 股 T+1 时点校准对齐（`available_at ≤ t` PIT 校准）

---

## §3 单源稳定性风险与应急响应

### §3.1 已知风险

| 风险场景 | 频率历史 | 影响面 | 应急响应 |
|---------|---------|--------|---------|
| Baostock 服务临时中断 | 极低（月级 · 通常 < 4h） | Quality 因子当日无法刷新 | 走 24h response cache |
| Baostock 季报数据延迟 | 财报季偶发（T+2/T+3） | ROE/ROA 因子滞后 | Strategy 侧 `as_of` 严格 PIT · 因子值 = null 走 caller-prefetch 兜底 |
| Baostock 上游数据源变更 | 未观察到 | 派生逻辑失效 | 走 §5 rollback 路径 |

### §3.2 断供三级响应

- **一级**（< 4h）· cache 命中 · 无 UI 呈现
- **二级**（4h-24h）· caller-prefetch 兜底 · 因子值 = null · explain_card 侧渲染"因子暂无数据"（不 flag 风险）
- **三级**（> 24h · 未观察到）· Strategy 触发降级评估 · 走 §5 rollback 路径

### §3.3 与 QADocs Task #24 关系

Task #24 `test_quality_dual_source_divergence_alarm.py` 双源分歧报警断言 · 当前**休眠状态**（决策 2 = B 单源）· 未来 TUSHARE_PRO 启用 + BAOSTOCK 并存后转正激活

---

## §4 §11.1 权重锚承接（V0 权重 0.30 保持）

### §4.1 权重不因数据源切换调整（Strategy 独立性红线）

- V0 §11.1 Quality 权重 = 0.30（Baostock 单源下不变）
- 与 Momentum 0.25 / Value 0.20 / Size 0.15 / LowVol 0.10 独立
- walk-forward 敏感性验证：Baostock 单源下重跑 6 月历史 · 与 Tushare Pro 假设值对齐（±2pp 内视为等价）

### §4.2 权重调整触发条件（非本 ADR 范围）

若未来发生以下情况 · 走独立 ADR 修订 §11.1 权重：
- Baostock 覆盖度下降 · 或精度不满足生产要求
- 双源并存后（决策 2 = C）持续观察到分歧 > 5pp · 需权重再校准
- li-yiming 授权 Tushare Pro 后重新平衡因子权重

---

## §5 未来 Rollback 路径（前向兼容锚）

### §5.1 三条演进路径

| 路径 | 触发 | 契约变更 | 权重变更 | ADR |
|------|------|---------|---------|-----|
| A · Baostock → Tushare Pro 单源切换 | li-yiming 授权 · Baostock 覆盖不足 | `data_source = 'TUSHARE_PRO'` · minor bump | 无 | 走独立 ADR-00XX |
| B · Baostock + Tushare Pro 双源并存 | 决策 2 → C · Task #24 断言激活 | `data_source = 'MERGED'` · `fallback_reason` 记合并版本 · minor bump | walk-forward 敏感性重跑 | 走独立 ADR-00XX |
| C · 新数据源接入（未预见） | e.g. Wind API 加入 | 扩枚举第 4 值 · minor bump | walk-forward 敏感性重跑 | 走独立 ADR-00XX |

### §5.2 契约层前向兼容锚

- `contracts/strategy.md` v1 §Q7-fundamental-pit `data_source` 枚举 3 值定义 · TUSHARE_PRO/MERGED **空 slot 就位**
- 未来路径 A/B 切换 · 无 schema breaking · 只 minor bump（v1 → v1.x）

---

## §6 落地清单

### §6.1 v1.1 §3 E4 冻结前 landing 项

- `docs/refactor/adr/0007-quality-factor-fallback.md` · 本 ADR 6 节结构
- `contracts/strategy.md` v1 §Q7-fundamental-pit 记录点引用本 ADR §5 rollback 路径
- `contracts/data.md` v1.1 §3 E4 y/n 表 联动（DataPipeline 主 · Strategy reviewer · 见 `contracts-data-v1-1-e4-delta.md`）

### §6.2 CI 门禁位（降级）

- ✅ `test_fundamental_pit_schema_v1_1.py` shape 断言（**硬门禁**）
- ✅ `test_fundamental_pit_schema_v1_1.py` `data_source` 3 值枚举断言（**硬门禁** · v1 只允许 BAOSTOCK 值写入）
- ⚠️ Task #24 `test_quality_dual_source_divergence_alarm.py`（**休眠位** · 未来 TUSHARE_PRO 启用触发）
- ⚠️ Task #22 Baostock subprocess 隔离建议（QADocs Task #22 · 技术良好实践位 · **非硬门禁** · ADR-0009 降级承接）

---

## §7 引用锚

- Orchestrator msg=656c8cf4 · License 政策放宽令 v1
- Orchestrator msg=767ba280 · `data_source` 3 值枚举裁决
- Orchestrator msg=c2b28c7c · 自主推进边界令 v1
- Orchestrator msg=84fa4b84 · M-Draft 挪入路径终裁 v1
- Orchestrator msg=b8b3baf4 · Q8 slug 终版澄清（Frontend 不 aware 数据源）
- Orchestrator msg=bf74c64c · li-yiming 全权授权
- Strategy workspace `notes/50-strategy-adr-0007-quality-factor-fallback-v1.md`
- QADocs msg=77149660 / msg=38dada36 / msg=21363562 · v1.1 追增队列承接
- li-yiming msg=4f6d2466 / msg=ad6585cf · 项目自用非上线 · License 合规放宽
- ADR-0001 · Reference Independence v1.1（本 ADR 与独立性红线正交）
- ADR-0009 · baostock-gpl-isolation（同批 landing）
- ADR-0008 · yahoo-fallback-opt-in（同批 landing）

---

**End of ADR-0007 v1**
