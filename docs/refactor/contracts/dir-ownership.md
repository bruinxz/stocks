# 目录归属契约（contracts/dir-ownership）

**版本**：v0（M0 骨架）
**Owner**：Orchestrator
**上位规范**：`../adr/0001-layering-and-collab.md` §1.1 + §12

---

## 1. Owner 写权限矩阵

| 目录 | 写 owner | 只读 |
|---|---|---|
| `docs/refactor/00-*.md` ~ `19-*.md` | Orchestrator | 全员 |
| `docs/refactor/adr/**` | Orchestrator | 全员 |
| `docs/refactor/contracts/**` | Orchestrator | 全员 |
| `docs/refactor/20-*.md` ~ `29-*.md` | Research | 全员 |
| `docs/refactor/30-*.md` ~ `39-*.md` | Cleanup | 全员 |
| `docs/refactor/40-*.md` ~ `49-*.md` | QADocs | 全员 |
| `docs/refactor/50-*.md` ~ `59-*.md` | Strategy | 全员 |
| `docs/refactor/60-*.md` ~ `69-*.md` | Frontend | 全员 |
| `docs/refactor/70-*.md` ~ `79-*.md` | DataPipeline | 全员 |
| `docs/refactor/baseline/strategy/**` | Strategy | 全员 |
| `docs/refactor/baseline/frontend/**` | Frontend | 全员 |
| `docs/refactor/baseline/data/**` | DataPipeline | 全员 |
| `docs/refactor/baseline/scripts/**` | Cleanup + Research 联合 | 全员 |
| `docs/refactor/baseline/security/**` | QADocs | 全员 |
| `docs/refactor/allow-list-licenses.md` | QADocs | 全员 |
| `docs/{TESTING,DEVELOPER_GUIDE,USER_GUIDE}.md` | QADocs | 全员 |
| `docs/EASY_QUANT_UI_DESIGN_GUIDELINES.md` | Frontend | 全员 |
| `docs/FRONTEND_ARCHITECTURE.md` | Frontend | 全员 |
| `docs/SIGNAL_FIRST_PLAN.md` | Strategy | 全员 |
| `docs/PROJECT_COMPASS.md` | Strategy | 全员 |
| `docs/openapi.json` | Orchestrator（冻结前只读裁决） / QADocs（冻结后漂移校验） | 全员 |
| `backend/src/{quant,backtest,portfolio,metrics}/**` | Strategy | 全员 |
| `backend/src/services/{factor,analysis-engine,regime,attribution}/**` | Strategy | 全员 |
| `backend/src/models/` 策略类 | Strategy | 全员 |
| `backend/src/models/` 数据类 | DataPipeline | 全员 |
| `backend/src/{data,jobs,realtime,scripts}/**` | DataPipeline | 全员 |
| `backend/python/**` | DataPipeline | 全员 |
| `backend/src/api/**` | Orchestrator 裁决（冻结前）→ Frontend/Backend 分工（冻结后） | 全员 |
| `frontend/**`（含 `frontend/server.js`） | Frontend | 全员 |
| `ai/tradingagents-app/**` | Strategy | 全员 |
| `.github/**` | QADocs | 全员 |
| `backend/tests/**` | QADocs（主）+ 各 owner（其目录测试） | 全员 |
| `backend/tests/backtest/gates/refs/**` [1] | QADocs 独占 | 全员 |
| `frontend/tests/**` | QADocs（主）+ Frontend | 全员 |

[1] **`refs/**` 双子层**（Orchestrator msg=90f087a8 定；ADR-0001 §10.2a 展开表）：
- `refs/base/**` = 基础 7 gate 反例 + `fixture_ref_alpha` 教具
- `refs/weight_scheme/**` = §11.1 4 因子槽反例（`fixture_ref_weight_scheme_{value,quality,lowvol,momentum}_*`）
- 元测 `test_gate_matrix_completeness.test.ts` 独立扫描两层，缺任一 → 拒 PR
- 仅测试用途，不进生产 `backend/src/backtest/strategies/`

---

## 2. 豁免归属（无明确 owner 的仓库根工具）

- `verify.mjs`、`.verify_token`、`shots/` → Orchestrator 豁免归 Cleanup 处理（C-01/C-02 已处理 `.verify_token` + `verify.mjs`）
- 未来同类根级工具 → Orchestrator 每次单独裁决 owner

---

## 3. 跨界写入规则

- **原则**：owner 目录内独占写；跨界必须提请 Orchestrator
- **例外**：QADocs 横切参与 gate 验收，可在其他目录发起 test 起草 PR，须相关 owner ack
- **Phase 0 独占窗口**：Cleanup 独占全仓写权限；本轮**不进入 Phase 0**，此独占窗口未开启
- **本轮范围内**：`.verify_token` + `verify.mjs` 是安全例外（Orchestrator 单独授权 Cleanup）

---

## 4. 变更流程

- 单个文件 owner 变更 → `#stocks` 发提议 + 相关 owner ack → Orchestrator 签字 → 本文件 CHANGELOG 追加
- 大范围 owner 变更（目录级） → 走 ADR
- 豁免归属新增 → Orchestrator 单独 ack

---

## 5. v1 冻结前 TODO

- [ ] Research 事实基线看到实际目录后 → 未覆盖目录归属补齐
- [ ] `backend/src/api/**` 冻结前 → 明确 Frontend BFF vs Backend Handler 分界
- [ ] `backend/tests/**` 归属细则 → QADocs 主 + 各 owner 副
