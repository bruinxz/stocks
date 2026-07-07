# 契约索引（10-contracts）

**版本**：v0（M0 骨架）
**上位规范**：`00-anchor.md`
**签发人**：Orchestrator

---

## 1. 契约总览

本次重构涉及四大跨层契约 + 两项治理性契约：

| 编号 | 契约名 | 文件 | Owner（起草） | 冻结版本 |
|---|---|---|---|---|
| C1 | 数据契约 | `contracts/data.md` | Orchestrator（吸收 DataPipeline 输入） | v0 骨架 → v1 冻结 |
| C2 | 策略契约 | `contracts/strategy.md` | Orchestrator（吸收 Strategy 输入） | v0 骨架 → v1 冻结 |
| C3 | 展示契约 | `contracts/display.md` | Orchestrator（吸收 Frontend 输入） | v0 骨架 → v1 冻结 |
| C4 | 保护 glob | `contracts/protect.md` | Orchestrator（吸收 Research + Strategy 输入） | v0 骨架 → v1 冻结 |
| C5 | 目录归属 | `contracts/dir-ownership.md` | Orchestrator | v0 骨架 → v1 冻结 |
| C6 | License 白名单 | `allow-list-licenses.md`（后续 QADocs 建） | QADocs | v0 骨架 → v1 冻结 |
| C7 | 测试基础设施 fixture spec | `contracts/data-fixture-spec.md` | DataPipeline 起草 + Strategy 审 + QADocs gate 反例矩阵 → Orchestrator 签字 | v0 骨架（DataPipeline workspace）→ v1 冻结 |

---

## 2. 版本规则

`<layer>-contract v<major>.<minor>`

- **major** 加 1：破坏性变更（字段删除、语义变更、签名变更）——必须补 ADR
- **minor** 加 1：非破坏性追加（新字段、新接口、可选参数默认值）
- **v0**：M0 骨架版，只落框架、待填充
- **v1**：M-Draft 阶段冻结版；冻结后走 CHANGELOG 才能改

---

## 3. 冻结顺序（依赖链）

1. **C1 数据契约 v1** 优先（DataPipeline 输出 + M0.5 数据基线 + Research 21 事实基线三方对齐）
2. **C2 策略契约 v1**（依赖 C1 冻结；Strategy 输出）
3. **C3 展示契约 v1**（依赖 C1 + C2 冻结；Frontend 输出）
4. **C4 / C5 / C6** 与前三条并行，可提前局部冻结

冻结节点由 Orchestrator 签发；QADocs 起草 DoD 门禁项跟随每次冻结更新。

---

## 4. 契约变更流程

1. Owner 提出变更 diff（在 workspace）
2. 影响面梳理（哪些 Agent 受影响、需否 rebase）
3. 相关 Agent ACK / block（24h）
4. Orchestrator 裁决 → 更新 CHANGELOG + 补 ADR（如破坏性）
5. 发布新版本号；QADocs 更新门禁

---

## 5. ADR 索引

- `adr/0001-layering-and-collab.md` — 分层与协作模型 + 现有强约束条款

（后续 ADR 按序编号：0002-*, 0003-*）
