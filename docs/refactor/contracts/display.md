# 展示契约（contracts/display）

**版本**：v0（M0 骨架）
**Owner**：Orchestrator（吸收 Frontend 输入）
**上位规范**：`../adr/0001-layering-and-collab.md`
**冻结依赖**：`contracts/data.md` v1 + `contracts/strategy.md` v1

---

## 1. 展示层职责边界

- Frontend 只消费 backend `/api/**` 已有 BFF；本轮**不新增 backend/src/api/** 路由**（Phase 1 决策）
- Frontend 展示 = 荐股 + 因子解释 + 回测报告 + K线 + 组合表现
- 展示层不做业务判断：融券资格、T+1、复权基准日均由数据/策略层写死后透出
- 产品文案禁绝对收益承诺；风险提示常驻页脚 + 高风险控件 tooltip（原则 7）

---

## 2. 关键页面清单（v0 骨架，Frontend + QADocs M3 联合定案）

- **L1 首页 · 荐股清单**：signal + confidence + top-3 factor_snapshot + `available_at`
- **L2 个股详情**：K线（引入 lightweight-charts）+ 因子雷达 + 相似历史 + 回测报告
- **L2.5 组合视图**：仓位 / 分层归因 / 换手 / 现金比
- **L3 策略实验**：walk-forward / 参数扰动 / regime 分层可视化（回测 7 关 P0 报告面板）
- **L4 数据健康**：quantHealthMonitor 面板（缺失率、PIT 违规告警、复权因子一致性）

冻结前 Frontend 出**关键页面矩阵**（页面 × 消费字段 × 权威 API），QADocs 联合定案覆盖率清单。

---

## 3. 字段消费契约（Frontend 从 backend 消费）

- **strict 只读**：`signal.confidence / factor_snapshot / available_at / adj_base_date / daily_tradability`
- **禁前端计算**：涨跌停、可动位、复权、confidence — 均以数据/策略层为准
- **前端可派生**：颜色 / 图例 / 排序 / 组合可视化布局

**字段契约 v1 起草**：Frontend M0.5 出 `frontend-baseline.md` 字段矩阵（页面 × 字段 × 类型 × 空值语义） → 与 `contracts/data.md` §2 三态语义对齐 → 我签字。

---

## 4. UX 原则

- **可解释性优先**：signal 必带 factor_snapshot；回测报告必带 gate 通过/失败对照
- **风险提示**：不做绝对收益承诺（原则 7）；高风险控件（如"实盘一键复制"）必带二次确认 + 免责声明
- **不引入手机 push**（US-C7）；飞书通知走 backend/services 走既定通道
- **可复现按钮**：每个回测 / 策略实验带 `seed + rerun_script` 展示（US-038 呼应）

---

## 5. K 线组件

- 引入 `lightweight-charts`（非"迁移"，是**首次引入**；见 Frontend msg=2b31cd63）
- 与既有 chart 库并存 / 逐步替换由 Frontend 决策，Orchestrator 只关切与 factor_snapshot 联动
- License 需过 Q3 白名单校验（`Apache-2.0`；预校验 pass）

---

## 6. 前端保护 glob（→ `contracts/protect.md`）

- `frontend/src/pages/**`（关键页面 M3 前收敛）
- `frontend/src/components/charts/**`
- `frontend/server.js`（BFF 入口）
- `docs/EASY_QUANT_UI_DESIGN_GUIDELINES.md`
- `docs/FRONTEND_ARCHITECTURE.md`

---

## 7. QA 校验位（对齐 ADR-0001 §9）

- 关键页面单测 + E2E 覆盖率清单（M3 前 Frontend + QADocs 联合定，我签字）
- 前端禁用 `Math.random()`（US-038 全项目）
- 前端禁前端计算涨跌停 / 复权 / confidence（静态 lint + code review 项）
- 展示文案禁绝对收益承诺（QADocs 起草文案红线列表）

---

## 8. v1 冻结前 TODO（Frontend 主控）

- [ ] `frontend-baseline.md` v0（M0.5 快照）
- [ ] 关键页面矩阵 + 字段契约 v1
- [ ] BFF/API 需求单（提请 Orchestrator 走 backend/src/api/）
- [ ] lightweight-charts 引入 ADR（Frontend 起草，Orchestrator 签字）
- [ ] Open Questions 打包
