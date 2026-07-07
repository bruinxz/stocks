# ADR-0009 · Baostock GPL Isolation（降级为工程良好实践建议）

**状态**：Accepted（降级简化版 · License 政策放宽令 v1 后）
**签发日期**：2026-07-08
**签发人**：Orchestrator（自签 · li-yiming msg=bf74c64c 全权授权）
**Owner**：QADocs 主 · DataPipeline 副
**关联**：License 政策放宽令 v1（msg=656c8cf4）· ADR-0007 quality-factor-fallback · 决策 2 = B（Baostock 唯一 Quality 源）

---

## 一 · 背景与决策语义

### 1.1 原语义（License 合规硬门禁位）

- Baostock 采用 GPL License · 传染性开源协议
- 若与我方非 GPL 代码同进程 · 存在 GPL 传染风险
- 硬门禁：subprocess 隔离 · 4 条硬字段强制约束

### 1.2 新语义（License 政策放宽令 v1 后 · 降级为工程良好实践）

**降级依据**：
- 项目自用不上线（li-yiming msg=4f6d2466）· 无对外分发场景
- GPL 传染性只在**代码分发场景**触发 · 自用无触发条件
- 但**工程良好实践**保留：subprocess 隔离减少进程内存耦合 · 便于未来切换 Tushare Pro 时最小改动

**非 CI 硬门禁**（License 放宽后）：
- 4 条硬字段作**最佳实践建议保留**
- CI 层**不设 red 断言**
- QADocs 侧 Task #23 保留但降级为**信息化断言**（非门禁位）

---

## 二 · 工程良好实践 · 4 条硬字段建议

### 2.1 硬字段清单

| 字段 | 语义 | 建议值 |
|------|------|--------|
| `BAOSTOCK_SUBPROCESS_ISOLATION` | Baostock client 隔离模式 | `'subprocess'` |
| `BAOSTOCK_SUBPROCESS_TIMEOUT_MS` | 单次 subprocess 调用超时 | `30000` |
| `BAOSTOCK_SUBPROCESS_RETRY_COUNT` | 失败重试次数 | `3` |
| `BAOSTOCK_SUBPROCESS_LOG_LEVEL` | 日志级别 | `'info'` |

### 2.2 实现建议路径

**M2 独占窗口后**（Cleanup 独占执行）：
- `packages/data-pipeline/baostock-worker/quality_worker.py` · Python subprocess 独立进程
- 主进程 Node.js 通过 stdin/stdout JSON 协议通信
- 无进程内 Python interpreter 加载 · 无 GPL 传染风险

**M2 前**（当前）：
- `market_data_helper.py` 现状已符合建议（DataPipeline msg=040320d8 §.9 承接确认）
- 无需额外改造

---

## 三 · QA 断言（Task #23 · 降级为信息化）

**Task #22** · `test_baostock_gpl_subprocess_isolation.test.ts`

**4 断言（信息化 · 非门禁）**：
- A. 检查 `BAOSTOCK_SUBPROCESS_*` 4 环境变量存在（`process.env` grep 命中）
- B. 检查 Baostock client 调用路径不直接 `require('baostock')` 进程内加载
- C. 检查 `market_data_helper.py` 独立进程语义（subprocess.Popen 或 python-shell）
- D. 检查 log 中 Baostock 相关错误不阻断主进程（进程隔离即容错）

**CI 层行为**：
- 断言失败 = **⚠ warning**（不阻塞 PR merge）
- 建议 fix 但不强制
- License 政策放宽令 v1 前为硬 red 断言 · 放宽后降级

---

## 四 · Fallback 路径与 ADR-0007 联动

- ADR-0007 §3.2 断供三级响应中 · Baostock 服务临时中断走 24h response cache · 无需依赖 subprocess 隔离作 fallback 路径
- ADR-0007 §5 rollback 三条路径中 · A/B/C 三条路径切换 Tushare Pro / MERGED · subprocess 隔离设计使切换代价最小（只换 subprocess Python module 不动主进程）

---

## 五 · Cross-References

- License 政策放宽令 v1 msg=656c8cf4
- Orchestrator msg=bf74c64c 全权授权
- Orchestrator msg=c2b28c7c 自主推进边界令 v1
- ADR-0007 quality-factor-fallback（同批 landing）
- DataPipeline msg=040320d8 §.9 · Baostock workspace §.9 承接
- QADocs msg=77149660 §2 · Task #22 v1.1 队列位（降级承接）
- Strategy §Q7-fundamental-pit v1 · `data_source='BAOSTOCK'` 默认

---

**End of ADR-0009 v1（降级简化版）**
