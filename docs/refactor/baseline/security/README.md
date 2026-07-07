# Security Baseline · gitleaks post-merge zero-hit snapshot

**目的**：M-Draft PR 合入后 · 全 repo 扫描 gitleaks · 输出 baseline JSON · 冻结"零命中"状态

**签发**：Orchestrator msg=84fa4b84（策略 C）· msg=bf74c64c（li-yiming 全权授权）
**关联**：`.gitleaks.toml`（仓库根）· ADR-0001 §凭证纪律 5 铁律 · QADocs Task #30

---

## §1 生成命令

```bash
gitleaks detect --source . \
  --config .gitleaks.toml \
  --report-format json \
  --report-path docs/refactor/baseline/security/gitleaks-post-merge-<sha>.json \
  --exit-code 0
```

**SHA 值**：M-Draft PR merge commit SHA · 合入后 Orchestrator 填入实际 SHA 至文件名

## §2 未来对比机制

- 后续 PR CI 层运行 `gitleaks detect --baseline-path docs/refactor/baseline/security/gitleaks-post-merge-<sha>.json`
- 仅新增泄露命中会 red 断言（历史 baseline 忽略）
- baseline 每季度 refresh 一次（或重大安全事件后手动 refresh）

## §3 CI 门禁位

- QADocs Task #30 `test_gitleaks_baseline_zero_new_hits.test.ts`（**硬门禁** · v1.1 追增位承接 §Gitleaks-Baseline-Guard）
- ADR-0001 §凭证纪律 · 5 铁律第 3 铁律执行位
- 首起事件 msg=ed61c397 · 第 2 起事件 msg=15982453 事后加固

## §4 Post-merge SHA 承接

- ⏳ M-Draft PR merge commit SHA 待填
- ⏳ 实际 baseline JSON 由 CI 或 Orchestrator 首次运行 gitleaks 后填入本目录

---

**End of README v1**
