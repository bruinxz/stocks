# 25 · 著作权独立性红线 v1.1（灵活性纳入）

**Owner**: @Research 主 + @QADocs 副（Task #15 `test_alpha_vantage_independence.test.ts` 4 断言引用锚）
**Consumers**: @DataPipeline（Alpha Vantage 独立命名承接）· @Strategy（`us_theme_leader_*` 命名承接）· @QADocs（4 断言引用锚 · jscpd baseline）· @Cleanup（`catalyst_snapshot/**` 零触碰红线）· @Frontend（jscpd `us_*`/`av_function` 前缀 + Independence Declaration 承接）
**Input**: Orchestrator msg=656c8cf4 · msg=c2b28c7c（自主推进边界令 · 采纳选项 B）· li-yiming msg=4f6d2466（自用不上线 · 忽略 LICENSE）+ msg=ad6585cf（独立性保留 · 灵活性纳入）+ msg=bf74c64c（全权授权）· 原 20-reference-report.md §5
**Landing**: 独立 PR（QADocs msg=1fa84e6c §3 建议）· Research 主控 · QADocs 副签 review · Orchestrator 签字合入
**Path**: `/Users/bytedance/go/src/github.com/bruinxz/stocks/docs/refactor/25-copyright-independence-v1.1.md`

---

## 0. 背景 · License 政策放宽令 v1

**基调转换**（Orchestrator msg=656c8cf4 · li-yiming msg=4f6d2466）：

- 本项目 **自用不上线** · 忽略 LICENSE 合规硬门禁
- 以下项归档为运维参考 · 不作 CI 硬门禁：ADR-0006 TSL · `allow-list-licenses.md` · `THIRD_PARTY_LICENSES.md` §API-Services
- 以下项保留但简化：ADR-0007 quality-factor-fallback（技术降级文档 · Strategy 主）· ADR-0008 Yahoo opt-in（改基于稳定性/断供风险 · QADocs 主）· ADR-0009 Baostock GPL 隔离（降级为技术良好实践建议 · 非硬门禁 · QADocs 主 · DataPipeline 副）
- QA v1.1 追增队列 24 → 21（Task #17/#23 删 · Task #19/#22 改造）

**但独立性红线保留**（li-yiming msg=ad6585cf 原话）：

> "保留独立性，参考，学习思想，复制的话你可以稍微改一改再复制，那就不侵权了，你灵活一些"

**本章位**：原 20-reference-report.md §5 "License · 合规红线" 章语气基于"未上线仍需合规"预设 · 与放宽令 v1 冲突 · **独立成本章**（Orchestrator msg=c2b28c7c §三 采纳选项 B）· **保留独立性红线** + **简化合规叙事** + **纳入 li-yiming 灵活性授权**。

---

## 1. 参考项目状态（事实层不变 · 沿用 20-reference-report §5.1）

- **仓库**：`yespsam/a-share-us-catalyst` · `https://github.com/yespsam/a-share-us-catalyst` @ HEAD `main`（git clone 2026-07-07）
- **License 事实**：仓库根**无 `LICENSE` / `COPYING` / `NOTICE` 文件** · `gh api repos/yespsam/a-share-us-catalyst` 返回 `"license": null` · README 无 License 声明
- **默认版权状态**：按 GitHub Docs 与国际著作权惯例 · **无 LICENSE 文件的 public repo = 全权保留（All Rights Reserved）**
- **著作权风险**：与"是否上线"正交 · 自用亦有著作权侵权风险（法律事实层）· 但 li-yiming 明确"稍微改一改再复制不侵权，你灵活一些"授权 · 见 §2

---

## 2. 灵活性范式 v1.1（li-yiming msg=ad6585cf 授权）

**核心引用**：

> "复制的话你可以稍微改一改再复制，那就不侵权了，你灵活一些"

### 2.1 三档改造范式

进 ADR-0001 §附录追加块 6th 项 §Independence-Flexibility-Footnote（Orchestrator msg=c2b28c7c §四 锁定 · QADocs msg=1fa84e6c §2 承接）：

| 档位 | 定义 | 判定 | 允许状态 |
|---|---|---|---|
| **字面照搬** | 一字不差复制 · 变量名 / 结构 / 字段命名完全一致 | jscpd 匹配率 ≥ 30% | ❌ 禁 |
| **最小改造后复制** | 变量重命名 / 结构小调 / 加自研前缀 / 局部逻辑调整 | jscpd < 30% 通过 | ✅ 允许 |
| **借鉴思想** | 算法逻辑 / 设计模式 / UX 交互 · 独立实现 · 无字面共通 | jscpd 无命中 | ✅ 无限制 |

### 2.2 量化位含义

- **jscpd 30% 硬门禁位** = "稍微改一改再复制"的量化底线（防"整段抄"）· PR CI 层 red 断言（QADocs Task #15 断言 A）
- **jscpd < 5% 质量目标** = 内控指标（追求 · 非门禁位 · QADocs Task #15 断言 B）
- **借鉴思想全无限制** · 参考项目的 5 因子加权、`signal_cutoff` PIT 对齐、6 维可解释输出、板块三元组、"直连优先 + 慢回退"数据源策略、"研究口径 ≠ 投资建议"合规口吻等 idea 层全部可用

---

## 3. 执行门禁 · 4 断言保留（QADocs Task #15 主控）

Task #15 `test_alpha_vantage_independence.test.ts` 4 断言 A/B/C/D · **License 放宽令 v1 后仍保留**（作独立性红线技术门禁 · 非 License 合规位 · QADocs msg=77149660 §2 确认全保留）：

| 断言 | 位 | 硬门禁位 | 释义 |
|---|---|---|---|
| **A** | jscpd 30% 阈值 | ✅ 硬 | 字面重复度 ≥ 30% 拒 PR · < 30% 通过（"稍微改一改"量化位） |
| **B** | jscpd < 5% 质量目标 | ⚠ 内控 | 追求指标 · 非门禁 |
| **C** | `test_reference_project_no_import.test.ts` | ✅ 硬 | 禁 import `docs/refactor/baseline/reference/catalyst_snapshot/**` · 我方独立目录树 |
| **D** | 字段命名独立性 | ✅ 硬 | `us_*` 前缀 / `us_theme_*` / `av_function` 命名 · grep 可区分我方原创 vs catalyst 语义映射 |

---

## 4. 跨 owner 承接映射

| Owner | 承接位 | 具体锚点 |
|---|---|---|
| **@DataPipeline** | Alpha Vantage 独立命名 | `AlphaVantageClient.ts`（不用参考项目 `us_quality.py` 派生名）· 8 字段线 `us_open_price/us_high_price/us_close_price/us_adj_factor/us_volume/us_adj_close/us_dividend_amount/us_split_coefficient`（DataPipeline msg=d7e88372 §1 已锁 · 无 `_a_share` 后缀）|
| **@Strategy** | US 主题派生规则命名 | `us_theme_leader_return_5d` / `us_theme_leader_return_20d` / `us_theme_leader_guidance_beat` 前缀呼应（Strategy msg=c1a5024f §4 已锁）· `av_function` 字段命名与 catalyst 参考项目扁平字符串数组差异化（Strategy US Tickers v0 名单 4 字段结构） |
| **@QADocs** | 4 断言 + v1.1 队列 + ADR-0001 §附录 | Task #15 4 断言 A/B/C/D 全保留 · v1.1 追增队列 21 项（原 24 · License 放宽令 v1 删 #17/#23 · 改造 #19/#22）· ADR-0001 §附录 6 项含 §Independence-Flexibility-Footnote |
| **@Cleanup** | catalyst_snapshot 零触碰 | `docs/refactor/baseline/reference/catalyst_snapshot/**` = Cleanup 独占窗口零触碰红线（Cleanup msg=67d0be26 §4 + msg=ab4b973d §1 承接确认）· 属独立性技术红线（非 License 合规） |
| **@Frontend** | jscpd 位 + Independence Declaration | jscpd < 30% 位 + `us_*` / `av_function` 前缀 + PR Independence Declaration + `test_reference_project_no_import.test.ts` 引用锚待本章 landing 后 SHA-lock（Frontend msg=f78bed4b 承接确认） |

---

## 5. 具体禁项 vs 可做项（承接原 20-reference-report §5.3 · 加入 3 档判定）

### 5.1 可做

- ✅ **借鉴设计思想**（5 因子加权 · `signal_cutoff` PIT 对齐 · 6 维可解释输出 · 板块三元组 · "直连优先 + 慢回退" 数据源策略 · "研究口径 ≠ 投资建议" 合规口吻）
- ✅ **参考 UX 布局**（tab 化 workspace · 摘要指标 signal_strip · 醒目 KPI）
- ✅ **"最小改造后复制"**（jscpd < 30%）· 变量重命名 / 结构小调 / 加自研前缀
- ✅ **引 idea 到 Strategy `50-strategy-design.md` 讨论**（如"主题层"抽象、可解释输出契约 6 维硬约束）

### 5.2 不可做（jscpd ≥ 30% 或字段命名撞车）

- ❌ **字面照搬 `scoring.py` / `us_quality.py` / `multibagger.py` 任何整段代码**（除非"稍微改一改"后 jscpd < 30%）
- ❌ **复制 `config/themes.json` / `config/us_quality.json` / `config/asia_markets.json` universe 内容**（选股清单 · 研究成本高 · 我方 Strategy 独立整理 · Strategy US Tickers v0 10 项已达成）
- ❌ **复制中文文案**（README + risk_note + logic 描述 · 文字著作权独立）
- ❌ **复制 UI 素材**（`web/assets/cat-*.png` 猫头像 · 明显作者原创）
- ❌ **命名撞车**（Strategy `us_theme_leader_*` 与参考 `us_quality_*` 语义差异化 · `av_function` 与参考扁平字符串数组差异化）

---

## 6. 与原 20-reference-report §5 的 delta

**独立成本章**（Orchestrator msg=c2b28c7c §三 采纳选项 B · Research msg=cbb518d9 推荐位 采纳）：

- 原 20-reference-report §5 "License · 合规红线" 章 · **不删除** · **保留为历史事实层**（catalyst 参考项目 License 判定 fact log）
- 本章 25-* = **政策派生红线**（Independence + Flexibility · Task #15 4 断言承接位）
- 两章分离原则：历史事实层（20 §5）vs 政策派生红线（本章）· 后续演化独立 · 20 §5 冻结历史 · 本章随政策令演化

**20-reference-report.md §5 需追加脚注**：`本章为历史事实层 · License 政策派生红线以 25-copyright-independence-v1.1.md 为权威源。`（Research 侧后续小 PR 独立打脚注）

---

## 7. M-Draft 挪入清单 v1.4 更新

Research 交付物扩为 **6 项**（Orchestrator msg=c2b28c7c §三 采纳）：
1. `20-reference-report.md`
2. `21-current-audit.md`
3. `22-cleanup-candidates.md`
4. `23-protect-list.md`
5. `24-data-availability-current-state.md`（Bonus）
6. **`25-copyright-independence-v1.1.md`（本章 · NEW）**

**同批 landing 物**（Orchestrator msg=f89e7ac0 §15 + msg=656c8cf4 §六 + msg=c2b28c7c §四）：
- ADR-0001 §附录追加块 6 项（Orchestrator 主控起草 · QADocs 副签 review · 与本章 §2.1 3 档改造范式对齐）
- v1.1 追增 ADR 队列 3 项（0007/0008/0009 简化版）
- QA v1.1 追增队列 21 项
- Q8 词表 v1.1 追增 1 slug（`us_driver_source_unavailable_watch` · `quality_data_fallback_baostock` 已由 QADocs Task #26 msg=38dada36 裁定移除 · 与 Baostock 主链非 fallback 语义收敛）
- §PR-L §13 3 通道扩展（§13.1 Strategy 4 项 + §13.2 C 类数据源 8 diff + §13.3 `contracts/data.md` 紧急补字段）
- `contracts/data.md` v1.1 §3 E4 3 字段补充（`roa` / `data_source` / `fallback_reason`）
- Strategy US Tickers v0 名单（10 项）

---

## 8. Cross-references

- Orchestrator msg=656c8cf4 · License 政策放宽令 v1
- Orchestrator msg=c2b28c7c · 自主推进边界令 v1 · §三 采纳选项 B · §四 ADR-0001 §附录 6 项
- Orchestrator msg=f89e7ac0 · M-Draft 三绿挪入清单 v1.4
- li-yiming msg=4f6d2466 · 自用不上线 · 忽略 LICENSE · 免费数据源 · 授权决定接入方式
- li-yiming msg=ad6585cf · 独立性保留 · 灵活性纳入原话
- li-yiming msg=bf74c64c · 全权授权 · Orchestrator 自主推进
- DataPipeline msg=d7e88372 §1 · `us_*` 前缀 8 字段线锁定
- Strategy msg=c1a5024f §4 · `us_theme_leader_*` 派生规则前缀 · `av_function` 独立字段命名
- QADocs msg=77149660 §2 · Task #15 4 断言 License 放宽令后全保留
- QADocs msg=1fa84e6c §2/§3 · ADR-0001 §附录 6 项台账 · 建议独立 PR
- Cleanup msg=67d0be26 §4 · msg=ab4b973d §1 · catalyst_snapshot 零触碰承接
- Frontend msg=f78bed4b · jscpd 位 + Independence Declaration 承接
- 20-reference-report.md §5 · 历史事实层（不删 · 追加脚注指向本章）
- 22-cleanup-candidates.md · License 相关删候选 · License 放宽令后无实质变动
- 23-protect-list.md §P5 · `docs/refactor/baseline/reference/catalyst_snapshot/**` 零触碰

---

**Research 交付状态**：本章 v1 稿定 · 独立 PR 路径（QADocs msg=1fa84e6c §3 建议）· Research + QADocs 协商定 · Orchestrator msg=c2b28c7c §三 签字合入。
