---
status: Archived
archived_date: 2026-07-08
archived_reason: License 政策放宽令 v1 · 项目自用不上线
future_reactivation: 若未来开源分发再激活
authoritative_ref: Orchestrator msg=656c8cf4
---

# Allow-List Licenses（归档态）

**注意**：本文件 v1.1 后归档 · **非当前 CI 硬门禁** · 保留作历史参考

---

## §1 归档理由

- li-yiming msg=4f6d2466 · "忽略 LICENSE，本项目不上线纯自用，不需要遵守那些规则"
- License 政策放宽令 v1 · License 合规硬门禁位从 v1 冻结中移除
- Allow-list 保留归档态 · 未来若项目开源分发再激活

## §2 CI 层行为（归档后）

- 原 `test_license_allow_list_compliance.test.ts` **skip** 状态（不 red 断言）
- 保留文件在 repo 中 · 便于未来激活
- allow-list-licenses.md v0.2 状态从 Active workspace 稿件转 Archived workspace 稿件（稿件自身状态位管理 · 非 Task # 承接位）

## §3 未来激活触发（假设性 · 未生效）

若未来发生以下情形 · 走独立 ADR 重启本文件为 Active 状态：
- 项目决定开源分发（GitHub public · npm · PyPI 等）
- 商用发行 · 客户合同要求 License 合规审查
- 依赖库许可证冲突事件（如 GPL v3 传染性影响）

## §4 原 v1.0 allow-list 内容（保留参考）

（本节保留 v1.0 原始 allow-list 表 · 未来激活时以此为起点）

| Category | Allowed Licenses | Notes |
|---------|-----------------|-------|
| Runtime deps | MIT / Apache-2.0 / BSD-3-Clause / ISC | 商用兼容 |
| Dev deps | 同上 + MPL-2.0 | 开发工具 |
| Data sources | 按上游 API TOS | Baostock GPL 走 subprocess 隔离 · 见 ADR-0009 |

---

## §5 Cross-References

- Orchestrator msg=656c8cf4 · License 政策放宽令 v1
- Orchestrator msg=84fa4b84 · M-Draft 挪入终裁
- li-yiming msg=4f6d2466 · 忽略 LICENSE · 项目自用
- li-yiming msg=ad6585cf · 保留独立性 · 参考学习思想
- ADR-0009 · baostock-gpl-isolation（降级为工程良好实践建议 · 同批 landing）
- ADR-0007 · quality-factor-fallback（同批 landing）

---

**End of allow-list-licenses.md v0.2（Archived）**
