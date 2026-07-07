# 保护清单契约（contracts/protect）

**版本**：v0（M0 骨架）
**Owner**：Orchestrator（累积吸收 Strategy + Frontend + DataPipeline + Research 输入）
**上位规范**：`../adr/0001-layering-and-collab.md` §5

---

## 1. 保护清单机制

**语义**：保护 glob 内的路径 = Cleanup 独占期禁删/禁改；豁免必须走 §5 豁免流程。

**豁免流程**（对齐 ADR-0001 §5）：
1. Cleanup 在 #stocks 发豁免申请（路径 + 依据 + 影响半径 + 测试兜底）
2. Orchestrator @ 相关 owner 24h 内 ack / block
3. Orchestrator 签字放行 → 执行 → `30-cleanup-log.md` 单批记录

**核心资产（PR-L 例外通道 · 4 项）**：即便按流程走豁免，动这 4 项须**双签**（相关 owner + Orchestrator + li-yiming 同批复认）：
- **momentum_reversal 策略**
- **AShareConstraintEngine**
- **FactorRegistry + Pipeline**
- **权重锚 §11.1**（Value 0.40 / Quality 0.30 / LowVol 0.30 / Momentum 0.0）

---

## 2. 保护 glob 累积集（v0 骨架 · 待 Research 21 事实基线收敛后 v1 冻结）

### 2.1 策略层（Strategy 提议，`notes/existing-conventions.md`）

- `backend/src/{quant,backtest,portfolio,metrics}/**`
- `backend/src/services/{factor,analysis-engine,regime,attribution}/**`
- `backend/src/models/`（策略类模型）
- `backend/tests/{factor,factors,backtest,quant,strategies}/**`
- `backend/tests/**/*real*`
- `ai/tradingagents-app/**`
- `docs/SIGNAL_FIRST_PLAN.md`（若存在）
- `docs/PROJECT_COMPASS.md`（若存在）

### 2.2 数据层（DataPipeline）

- `backend/scripts/migrations/**`
- `backend/src/data/migrations/**`（若存在）
- 现有采集器主线（**Research 21 通读后收敛具体路径**）

### 2.3 展示层（Frontend）

- `frontend/src/pages/**`（关键页面 M3 前 Frontend + QADocs 联合收敛）
- `frontend/src/components/charts/**`
- `frontend/server.js`（BFF 入口）
- `docs/EASY_QUANT_UI_DESIGN_GUIDELINES.md`
- `docs/FRONTEND_ARCHITECTURE.md`

### 2.4 文档层

- `docs/refactor/**`（含 `docs/refactor/baseline/**`）
- `docs/{TESTING,DEVELOPER_GUIDE,USER_GUIDE}.md`
- `docs/openapi.json`（冻结前 Orchestrator 只读裁决；冻结后 QADocs 漂移校验）

### 2.5 基线快照层（M0.5 冻结）

- `docs/refactor/baseline/strategy/**`
- `docs/refactor/baseline/frontend/**`
- `docs/refactor/baseline/data/**`
- `docs/refactor/baseline/scripts/**`
- `docs/refactor/baseline/security/**`

### 2.6 治理层

- `.github/**`（QADocs 独占）
- `docs/refactor/allow-list-licenses.md`（QADocs）

---

## 3. 明确**不保护**（本轮 Cleanup 授权目标）

- `.verify_token`（本轮已删，C-01）
- `verify.mjs`（本轮已删，C-02）
- `shots/`（Cleanup 豁免归属，本轮暂保留待 Research 22 出证据）
- 零调用、零测试、零文档引用的采集器（Research `22-cleanup-candidates.md` 定案后）
- 死代码 / 无用依赖 / 废弃采集器 / 脏数据（Phase 0 逐批处理）

---

## 4. v1 冻结前 TODO

- [ ] Research `21-current-audit.md` 事实基线出 → 保护路径收紧
- [ ] Strategy 最终 ack 保护 glob（每条对应"为何保护 + 保护 revoke 条件"）
- [ ] Frontend 关键页面清单锁定 → 精确 glob 收敛
- [ ] DataPipeline 现存采集器主线选择 → 精确 glob 收敛
- [ ] QADocs 起草 `保护 glob CI 校验` 规则（PR diff 触碰保护 glob 自动拒合入）
- [ ] Cleanup ack 豁免流程走稳 → M2 Phase 0 独占启动令生效
