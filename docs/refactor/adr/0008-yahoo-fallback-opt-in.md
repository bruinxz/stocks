# ADR-0008 · Yahoo Finance Opt-in Fallback（简化版）

**状态**：Accepted（简化版 · License 政策放宽令 v1 后）
**签发日期**：2026-07-08
**签发人**：Orchestrator（自签 · li-yiming msg=bf74c64c 全权授权）
**Owner**：QADocs 主 · DataPipeline 副
**关联**：License 政策放宽令 v1（msg=656c8cf4）· ADR-0007 quality-factor-fallback · 决策 3 = A（Alpha Vantage 主链）

---

## 一 · 背景与决策

**决策链**：
- 决策 3 = A：Alpha Vantage 免费 tier 25 req/day 作 US 数据主链（Orchestrator msg=656c8cf4）
- Yahoo Finance = **应急 opt-in fallback**（`ALLOW_YAHOO_FALLBACK=false` 默认关闭）
- IEX = 弃用（License + 商业条款不适配）

**语义变更**（License 政策放宽令 v1 后）：
- **原语义**（License 合规硬门禁位）：Yahoo Finance API License 兼容性合规审查
- **新语义**（技术稳定性 opt-in 位）：Yahoo Finance opt-in flag 基于**稳定性 / 反爬灰区 / 断供风险**（非 License 合规）

---

## 二 · Opt-in 决策依据

### 2.1 稳定性

- Yahoo Finance 无官方公开 API · 走 `yahoo-finance2` 库爬取 · 反爬机制不定期更新
- 历史观察：单次断供 > 3 天记录多次（2024-2025 期间）
- 与 Alpha Vantage 官方 API（免费 tier 25 req/day）稳定性不可比

### 2.2 反爬灰区

- `yahoo-finance2` 通过反向工程调用非公开 endpoint · 灰色地带
- 一旦 Yahoo 变更反爬策略 · 库需数天到数周修复
- 非生产可靠数据源

### 2.3 断供风险

- Yahoo 商业化战略未来演进不可控（可能付费化 / 关闭 / 变限流）
- 作为主链 = 单点断供风险高
- 作为 opt-in fallback = 有可控风险边界

---

## 三 · 实现约定

### 3.1 环境变量

```
ALLOW_YAHOO_FALLBACK=false  # 默认关闭
```

- v1 冻结时：默认 `false` · Yahoo Finance 不作为 fallback 生效
- 未来 li-yiming 授权后：可设 `true` · Yahoo Finance 作为 Alpha Vantage 断供时的应急 fallback

### 3.2 触发条件（若 `ALLOW_YAHOO_FALLBACK=true`）

- Alpha Vantage 24h 内失败 > 3 次
- Alpha Vantage 单次 request > 60s timeout
- Alpha Vantage 返回 rate limit error（429）> 5 次连续

### 3.3 Fallback 行为

- 只作为**观察层降级**（explain_card 展示 Alpha Vantage 数据 stale 提示）
- 不作为策略层信号切换（`ENABLE_US_DRIVER_SIGNAL` 走独立 gate · §Q7.4）
- 数据入库单独 tag `data_source_secondary='yahoo_finance'` · 与 Alpha Vantage 数据独立存储

---

## 四 · QA 断言（Task #20）

**Task #16** · `test_yahoo_finance_opt_in_flag_default_false.test.ts`

**4 断言**：
1. `process.env.ALLOW_YAHOO_FALLBACK !== 'true'` 默认态断言（v1 冻结时）
2. Yahoo Finance client 初始化路径 grep：`ALLOW_YAHOO_FALLBACK === 'true'` 前置守卫存在
3. 无 Yahoo Finance 数据直接进 `data_source_primary` 字段的 CI grep
4. Yahoo Finance 错误 log 不误报到 Alpha Vantage error metric（隔离）

---

## 五 · Rollback 路径

若未来 li-yiming 授权 `ALLOW_YAHOO_FALLBACK=true`：
- 走独立 ADR 修订说明启用理由
- QA 侧激活 Yahoo Finance 稳定性观察断言
- Frontend 侧考虑是否在 explain_card 层展示 Yahoo Finance 数据（当前默认不展示）

---

## 六 · Cross-References

- License 政策放宽令 v1 msg=656c8cf4
- Orchestrator msg=bf74c64c 全权授权
- Orchestrator msg=c2b28c7c 自主推进边界令 v1
- ADR-0007 quality-factor-fallback（同批 landing）
- QADocs msg=6642107e / msg=89fcc676 · License 二审
- DataPipeline msg=f99277d7 · 技术评估六维矩阵
- Strategy §Q7.4 切换开关 `ENABLE_US_DRIVER_SIGNAL`（与 Yahoo opt-in 正交）

---

**End of ADR-0008 v1**
