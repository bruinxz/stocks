# 20 · 参考项目通读报告（`yespsam/a-share-us-catalyst`）

**版本**：v1.0（M-Draft 输入）
**Owner**：@Research
**上位规范**：`00-anchor.md`（li-yiming brief msg=afe6236a "参考项目(理想态)代码库"）
**签字锚**：li-yiming M-Draft
**证据基线**：`https://github.com/yespsam/a-share-us-catalyst` @ HEAD `main`（git clone `2026-07-07`；仓库创建 `2026-07-06T18:55:42Z`，last push `2026-07-06T18:55:57Z`，size 4891 KB，主语言 Python）；在线站 `https://catalyst-900-qohfq.netlify.app/`（Netlify 静态部署）

---

## 0 · TL;DR

参考项目 **≠** 我方项目的"理想同构态"。它是一个 **~6.5K LOC 的 Python 单体日报工具**（CatDesk 9 · "九点猫研"），**不是一个可交易系统**。价值在于：

- **催化剂(catalyst) → A 股映射打分算法**（`scoring.py:score_candidate` · 5 因子加权 100 分制 · 明确 methodology）——这是 li-yiming 提到的"理想态"具体锚点，值得系统性借鉴
- **数据源"直连优先 + AkShare 慢回退"策略** —— 与我方 20+ client + Python spawn 的复杂度形成鲜明对比
- **单页应用 tab 化 workspace + 中文 UX + "研究口径 ≠ 投资建议"合规口吻** —— 交 @Frontend / @QADocs 可借鉴
- **点评侧写(analyst_profile) + 场景/入场计划(entry_plan / scenario) + 证据(risk_flags / positive_flags)** —— "可解释输出"落地样本，对 Strategy 层可解释性有直接借鉴价值

**License 结论 · 🔴 红线**：仓库**无 LICENSE 文件**（`gh api` 返回 `license: null`；仓库根目录 `find -iname 'license*'` 零命中）。**默认版权 = 全权保留（All Rights Reserved）**——**禁止照搬源码到我方仓库**（合规风险）。可"参考、借鉴、独立实现"，不可复制文本 / 结构 / 特定命名（详见 §5）。

---

## 1 · 定义 · 核心特性

### 1.1 产品定义

引 README（`/tmp/research-refs/a-share-us-catalyst/README.md:1-14`）：

> # 九点猫研 CatDesk 9
> 每天 9 点，猫一眼市场机会。
> 每天早上 9 点生成一份"昨夜美股 -> 今日 A 股候选"的早报。它把美股主题涨跌、A 股历史次日表现、个股动量、新闻催化和风险提示合成一个评分，输出每个板块 5 只候选股。
> > 输出是研究候选和风险提示，不是无条件买入指令。真实交易还需要结合账户风险承受能力、仓位、止损、流动性和当天开盘价格。

**定位**：**T+1 隔夜催化剂研究日报**（非实盘 · 非高频 · 非组合管理）
**核心用户动作**：09:00 前打开一份 Markdown 或网页版，看今天关注哪些板块 · 各板块前 5 只 · 每只的评分/因子拆解/入场计划/风险点
**输出物 3 份**：`reports/YYYY-MM-DD-morning.md` + `reports/YYYY-MM-DD-morning.json` + `dist/data/*.json`（静态站消费）

### 1.2 核心特性五项

引 `web/index.html:22-51` 主导航 tabs：

| Tab | 功能 | 后端模块 |
|---|---|---|
| **A股早报** | 美股前夜主题 → A 股板块 / 个股候选（默认视图） | `scoring.py` + `config/themes.json` |
| **美股优选** | 按质量/成长/估值/护城河/趋势/风险筛选美股 | `us_quality.py` + `config/us_quality.json` |
| **日韩市场** | 覆盖日本、韩国核心资产（汇率/政策/财报/跨境交易风险） | `asia_markets.py` + `config/asia_markets.json` |
| **高倍潜力** | 早期美股 multibagger 挖掘（optionality/催化剂） | `multibagger.py` + `config/multibagger.json` |
| **回测证据** | ashare + us quality 两侧的 forward 1/3/5 日 close-to-close 收益率回测 | `backtest.py` |
| **每日日报** | Markdown 完整报告（可一键复制） | `report.py:render_markdown` |
| **报告历史** | `reports/` 目录归档索引 | `web.py` |

### 1.3 Catalyst 逻辑（**核心借鉴对象**）

来自 `scoring.py:225-275` 的 `score_candidate`（100 分制，5 因子加权）：

| 因子 | 权重 | 语义 | 计算依据 |
|---|---|---|---|
| **signal**（美股主题信号） | 0.34 | 美股当日 主题 tickers 加权涨跌 + 广度 | `current_theme_signal`：`avg_pct*9 + breadth*10`（`scoring.py:143-170`） |
| **history**（历史联动） | 0.32 | A 股次日对美股主题的历史响应（hit_rate / avg_after_signal / corr / beta） | `historical_stats`（`scoring.py:191-222`）；对齐 `t-1` 已完成美股 session |
| **momentum** | 0.12 | 当日涨跌幅 + 换手率 | `snapshot.pct + turnover_rate`（`scoring.py:249-252`） |
| **liquidity** | 0.08 | 市值分档（100B+ / <8B 加/减分） | `market_cap` bucket（`scoring.py:254-261`） |
| **news** | 0.10 | 新闻关键词命中（15 正 + 11 负） | `POSITIVE_NEWS_WORDS` / `NEGATIVE_NEWS_WORDS`（`scoring.py:26-56`） |
| **risk_penalty**（惩罚项） | 减法 | 停牌 / ST / 高估值 / 高换手 / 涨停等 | `risk_penalty_points` |

**"以昨夜美股完整交易日为信号源" 的时间锚**（重要）：`scoring.py:200`

```python
a["signal_cutoff"] = a["date"] - pd.Timedelta(days=1)
merged = pd.merge_asof(a, us, left_on="signal_cutoff", right_on="date", direction="backward", suffixes=("_a", "_us"))
```

→ A 股当日反应"最近一次已完成的美股 session"，**天然对齐 PIT `available_at` 语义**——这是我方 ADR-0001 §10 数据契约 `available_at` UTC 定义的**现成参考实现**。

### 1.4 主题池 · 板块层设计（**可借鉴**）

`config/themes.json`（我读到 50 行）：11 只美股 tickers × 权重 + 11 只 A 股候选 × industry + rationale。以 `ai_compute_semis` 板块为例（`config/themes.json:11-38`）：

- **美股信号驱动组**（`us_tickers`）：NVDA/AMD/AVGO/MU/MRVL/ARM/ASML/AMAT/LRCX（加权，NVDA 2.0 最高）
- **A 股映射候选**（`candidates`）：中际旭创 / 新易盛 / 天孚通信 / 沪电股份 / 工业富联 / 浪潮信息 / 海光信息 / 寒武纪 / 北方华创 / 中微公司 / 兆易创新 —— 每只带 `industry` + `rationale`（可解释）

**借鉴价值**：**板块 = 美股 driver 池 + A 股映射池 + rationale 三元组**，比我方现在的多因子无板块中间层更接近人的思考粒度。@Strategy 可评估是否引入"主题层"作为因子上一级。

### 1.5 可解释输出（`analyst_profile`）

来自 `scoring.py:278-316`：每只候选给出

```json
{
  "rating": "……",
  "conviction": 0-100,
  "risk_gate": "……",
  "entry_plan": "……",
  "scenario": "……",
  "dimensions": {
    "catalyst": 0-100, "history_edge": 0-100, "quality_proxy": 0-100,
    "momentum": 0-100, "news": 0-100, "risk": 0-100
  },
  "positive_flags": [...],
  "risk_flags": [...],
  "method": "Top-down catalyst + historical edge + liquidity/quality proxy + momentum + event/risk gate"
}
```

**借鉴价值极高**：
- **6 维雷达图数据结构** —— 与 Strategy 交付物 B（`50-strategy-design.md`）的"可解释输出契约"直接匹配
- **`method` 字段自解释**（"用了哪些因子做的判断"）—— UX 侧解决"AI 给的结果为什么信"这一 li-yiming brief §7 硬性原则"可解释性优先"
- **`positive_flags` / `risk_flags`** 来自新闻文本命中（`POSITIVE_NEWS_WORDS` / `NEGATIVE_NEWS_WORDS`）—— 事件驱动的证据链落地样本

---

## 2 · 技术栈

### 2.1 编程语言 · 主体

| 系统 | 语言 | 关键文件 | LOC |
|---|---|---|---|
| 数据/评分/回测/CLI | **Python 3** | `src/ashare_us_catalyst/**` | ~3070 |
| 静态网页 UI | **原生 JS + HTML + CSS**（无框架 · 无构建） | `web/app.js` + `web/index.html` + `web/styles.css` | 2879（1127 + 324 + 1428） |
| Netlify Functions（实时行情代理） | Node ESM | `netlify/functions/*.mjs` | ~200 |
| 静态站构建 | Python | `scripts/build_static_site.py` | 60+ |
| **合计**（含 config/tests/scripts） | | | **~6476** |

### 2.2 依赖清单 · **极简**

**Python**（`requirements.txt` 5 行）：
```
akshare>=1.18.0    # 数据（慢回退，非默认）
pandas>=2.0.0      # 数值/分析
numpy>=1.24.0      # 数值
requests>=2.31.0   # HTTP
python-dotenv>=1.0.0  # .env
```
**Node**（`netlify/functions/live-quotes.mjs`）：仅 Netlify runtime + `fetch`，**零 npm 依赖**（`package.json` 不在项目根，仅 `video/catdesk9-intro/` 视频工具用）

**前端**：**零 npm 依赖 / 零构建工具 / 零 React / 零 antd / 零 MUI / 零 echarts / 零 lightweight-charts** —— 只有原生 `<svg>` 内联 + `document.querySelector` + `fetch`

### 2.3 数据源层（**核心借鉴 · 与我方 20+ client 形成对比**）

引 README §数据源：

> 默认优先使用轻量直连接口，并保留 AkShare 作为显式备用：
> - 美股日线：新浪单 ticker 静态日线，Yahoo chart 备用
> - A 股实时行情：东方财富轻量 JSON
> - A 股历史日线：东方财富轻量 JSON
> - 个股新闻：东方财富新闻搜索 JSONP
> - AkShare：默认不启用慢回退；需要诊断时加 `--allow-akshare-fallback`

对应实现在 `providers/akshare_provider.py`（628 行）—— **一个类打天下**（直连 curl + 磁盘缓存 + AkShare 慢回退开关），无 21 个 sourceClient 分层。

### 2.4 部署 / 调度

| 场景 | 手段 |
|---|---|
| macOS 本地 09:00 每交易日 | `scripts/install_launchd.sh` + launchd job |
| 公网 Netlify 定时发布 | `scripts/install_public_launchd.sh` + `npx netlify deploy` 每周一至周五 09:00 |
| 网页版 | `scripts/run_web.sh` → `python -m ashare_us_catalyst.web`（`web.py` 231 行，简单 HTTP 服务） |
| 静态站 | `scripts/build_static_site.py` → `dist/` → Netlify（`netlify.toml`） |

**未使用**：Docker / Redis / Bull / PostgreSQL / TimescaleDB / Sequelize / Kubernetes / CI/CD 复杂化

---

## 3 · 模块拆解 + 数据流

```
                              ┌─────────────────────┐
                              │  config/*.json      │
                              │  themes / us_quality│
                              │  asia / multibagger │
                              └──────────┬──────────┘
                                         ↓
                          ┌──────────────────────────────┐
                          │      cli.py (argparse)       │
                          │  --sample-data / --top / … │
                          └───────┬──────────┬───────────┘
                                  │          │
                    ┌─────────────▼───┐  ┌──▼─────────────┐
                    │ SampleProvider  │  │ AkshareProvider│
                    │ (离线单测/演示) │  │ (curl 直连 + 缓 │
                    │                 │  │  存 + AkShare  │
                    │                 │  │  慢回退开关)   │
                    └────────┬────────┘  └──────┬──────────┘
                             │  (共享 MarketProvider Protocol)
                             ▼
       ┌──────────────────────────────────────────────────────┐
       │            scoring.py (核心 catalyst 打分)          │
       │  rank_report → rank_theme → score_candidate         │
       │  + analyst_profile (可解释输出 6 维)                │
       └──────────┬────────────────────┬────────────────────┘
                  │                    │
                  ▼                    ▼
        ┌──────────────────┐  ┌──────────────────┐
        │  report.py       │  │  us_quality.py   │
        │  render_markdown │  │  screen_us_quality│
        │  write_outputs   │  │  (含技术指标)    │
        └───────┬──────────┘  └──────┬───────────┘
                │                    │
                │                    ▼
                │           ┌──────────────────┐
                │           │  asia_markets.py │
                │           │  screen_asia_… │
                │           └──────┬───────────┘
                │                  │
                │                  ▼
                │           ┌──────────────────┐
                │           │  multibagger.py  │
                │           │  discover_multi… │
                │           └──────┬───────────┘
                │                  │
                │                  ▼
                │           ┌──────────────────┐
                │           │  backtest.py     │
                │           │  run_backtest    │
                │           │  (forward 1/3/5) │
                │           └──────┬───────────┘
                ▼                  ▼
       reports/*.md       dist/data/*.json → web/app.js → 静态 UI
                          reports/*.json ────┘
                ▲
                │
       notifier.py → Telegram（可选）
```

**关键设计点**：

- **`MarketProvider` = Protocol**（`scoring.py:14-23` PEP 544 typing.Protocol） —— 依赖倒置 · 6 方法 `us_quote / us_history / a_snapshot / a_history / stock_news`；`SampleProvider`（85 行）和 `AkshareProvider`（628 行）双实现 —— **与我方 DataSource DI 六范式的思路一致，但只 1 个 Protocol 对 5 个 domain 方法**（我方是 6 个独立 Protocol）
- **Provider 层里做缓存 + 降级**（不是上层做）—— 单一职责集中在 provider
- **Signal cutoff 语义**（`scoring.py:200-202`）—— 在 provider 与 scoring 之间用 `signal_cutoff = date - 1day` 显式表达时点对齐，防未来函数

---

## 4 · 数据模型

**无数据库**（！）—— 全 in-memory `pandas.DataFrame` + `dataclass` + JSON 文件缓存。

### 4.1 主要数据结构

引 `config.py:1-68` + `us_quality.py:22-33`：

```python
@dataclass(frozen=True)
class UsTicker:
    ticker: str
    name: str
    weight: float           # 0-2.0 权重

@dataclass(frozen=True)
class Candidate:
    code: str               # A 股 6 位代码
    name: str
    industry: str           # 行业标签
    rationale: str          # 为什么选这只（可解释文本）

@dataclass(frozen=True)
class Theme:
    id: str
    name: str
    logic: str              # 板块投研逻辑 · 中文长文本
    us_tickers: list[UsTicker]
    candidates: list[Candidate]

@dataclass(frozen=True)
class UsQualityCandidate:
    ticker: str; name: str; sector: str; market_cap_bucket: str
    quality: float; growth: float; valuation: float; moat: float; catalyst: float
    thesis: str
    risks: list[str]
```

### 4.2 与我方数据模型的对比（**Strategy 侧重要输入**）

| 维度 | 参考项目 | 我方现状 | 借鉴 / 放弃 |
|---|---|---|---|
| 数据存储 | 无 DB · 磁盘 CSV/JSON 缓存 | PostgreSQL/TimescaleDB · 94 Sequelize models · migrations | **放弃**（我方规模远超工具型），但**借鉴 provider 层缓存下沉设计** |
| 因子表示 | `dataclass` + JSON config | Sequelize model + `factor_scores` / `stock_*_factors` | **保留我方**，但借鉴**"rationale 字段随因子走"**语义（每因子附一句可解释文本） |
| 主题/板块 | `Theme` = us_drivers + a_candidates + logic 三元组 | 无"板块层"独立实体 | **借鉴**：Strategy 可评估引入"主题/板块"作为因子层 → 组合层之间的中间层 |
| 时间对齐 | `signal_cutoff = date - 1day` + `merge_asof(direction="backward")` | ADR-0001 §10 `available_at` UTC ms | **契合**，`signal_cutoff` = `available_at` 的领域语义化子集 |
| PIT 三时点 | 无（工具型无需） | `report_date ≤ publish_date ≤ available_at` | **我方独有**（Strategy R4 已 v0.5 落 · DataPipeline msg=e6fe61ea） |

---

## 5 · License · 合规红线

### 5.1 参考项目 License 状态

- **仓库根**：**无 `LICENSE` / `COPYING` / `NOTICE` 文件**（`find /tmp/research-refs/a-share-us-catalyst -iname 'license*' -o -iname 'copying*'` 零命中）
- **`gh api repos/yespsam/a-share-us-catalyst`**：`"license": null`
- **README**：无 License 声明
- **`.env.example`**：无 License 声明

### 5.2 结论 · 🔴 高优先风险

按 GitHub Docs 与国际著作权惯例：**"没有 LICENSE 文件的 public repo 默认全权保留（All Rights Reserved）"**。这意味着：

- 允许：查看、阅读、fork（GitHub ToS 授权的 fork/克隆权，不含再分发）
- **禁止**（未经作者书面授权）：
  1. 将源码复制到其它仓库（哪怕注明来源）
  2. 修改后再分发
  3. 商业使用
  4. 保留 "substantial portions" 的代码逻辑 / 特定命名 / 结构

### 5.3 对我方重构的操作红线

按 li-yiming brief msg=afe6236a §7 硬性原则 "**禁止在未确认 License 的情况下照搬参考项目代码**"：

**可做（独立实现路径）**：
- ✅ **借鉴设计思想**（catalyst 5 因子加权、`signal_cutoff` PIT 对齐、`analyst_profile` 6 维、板块三元组、"直连优先 + 慢回退" 数据源策略、"研究口径 ≠ 投资建议" 合规口吻）
- ✅ 参考 UX 布局（tab 化 workspace）
- ✅ 引 idea 到 Strategy `50-strategy-design.md` 讨论

**不可做**：
- ❌ 复制 `scoring.py` / `us_quality.py` / `multibagger.py` 任何整段代码
- ❌ 复制 `config/themes.json` / `config/us_quality.json` / `config/asia_markets.json` 的 universe 内容（这些是"选股清单"，商业价值/研究成本高）
- ❌ 复制中文文案（README + risk_note + 各 `logic` 描述）—— 文字著作权独立
- ❌ 复制 UI 素材（`web/assets/cat-*.png` 猫头像 —— 明显是作者原创）

**推荐操作**：
- 请 @li-yiming DM 联系作者 `yespsam`（GitHub ID 267104686），询问：**能否在明确注明来源的前提下**（a）授权引用 `config/themes.json` universe 或（b）加 MIT/Apache-2.0 License；若拒绝或未回，我方按"仅借鉴设计思想，独立实现"路径推进
- 或：**完全独立实现**（安全路径，无需外部授权）

### 5.4 参考项目自身依赖 License 快速判断（非阻塞）

| 依赖 | License | 我方判断 |
|---|---|---|
| `akshare` | MIT | ✅ 白名单 |
| `pandas` | BSD-3-Clause | ✅ 白名单 |
| `numpy` | BSD-3-Clause | ✅ 白名单 |
| `requests` | Apache-2.0 | ✅ 白名单 |
| `python-dotenv` | BSD-3-Clause | ✅ 白名单 |

参考项目依赖链本身干净，License 问题只在**参考项目自身代码库无 LICENSE 声明**这一层。

---

## 6 · 借鉴 vs 放弃 · 决策表（**M-Draft 签字锚**）

**说明**：本表是 Research 侧建议。最终采纳由 Strategy / Frontend / DataPipeline / Orchestrator 各领域 owner 签，Research 不代签。

### 6.1 建议借鉴（8 项）

| # | 借鉴对象 | 来源锚点 | 建议 owner | 说明 |
|---|---|---|---|---|
| **B1** | Catalyst 5 因子 100 分制加权打分 | `scoring.py:225-275` | @Strategy | 与我方 §11.1 权重锚（V0.40/Q0.30/L0.30/M0.0）不冲突 · 可作为**信号→个股映射层**的评分模板；实施位置 `backend/src/quant/factors/**` 独立实现 |
| **B2** | 6 维 `analyst_profile` 可解释输出（catalyst / history / quality / momentum / news / risk） | `scoring.py:278-316` | @Strategy + @Frontend | Strategy `50-strategy-design.md` 契约输出结构；Frontend 雷达图组件（recharts 或 echarts） |
| **B3** | 板块/主题三元组（`Theme` = us_drivers + a_candidates + logic） | `config/themes.json` | @Strategy | 评估是否在因子层与组合层之间引入"主题层"；不复制内容，独立整理我方主题库 |
| **B4** | Signal cutoff 时点锚（`t-1` 完成 US 会话对 A 股 `t` 日反应） | `scoring.py:199-202` | @Strategy + @DataPipeline | 与 ADR-0001 §10.4 `available_at` 语义一致；作为 A/US 跨市场对齐的 canonical 实现 |
| **B5** | 数据源"直连优先 + 显式慢回退开关" | `providers/akshare_provider.py:24-46` + README §数据源 | @DataPipeline | 我方现在 20+ Python client + child_process.spawn → 复杂度极高。建议 DataPipeline 评估**直连 JSON 优先** + **AkShare 显式 opt-in fallback** 的降级策略 |
| **B6** | "研究口径 ≠ 投资建议" 合规口吻 + 醒目 risk_note | `config/themes.json:8` + `web/index.html:53-55` | @Frontend + @QADocs | 我方各页 UI 顶部 + report 底部都加显性合规声明；QADocs 加 lint 规则（比如所有 report 类页面必须包含 `disclaimer` 组件） |
| **B7** | Tab 化 workspace 单页 UI + 中文 UX + 可爱吉祥物 | `web/index.html:22-51` | @Frontend | Frontend `HomeWorkspace` 现在也是 tab 化，可借鉴其**简洁度**（原生 JS + 内联 SVG 零依赖 · 与我方 3 UI 库并存形成对比） |
| **B8** | 场景 + 入场计划 + 正/负 flag 分离的证据链 | `scoring.py:298-315` + `POSITIVE_NEWS_WORDS` / `NEGATIVE_NEWS_WORDS` | @Strategy | 我方现在 signal 输出未分离"证据 vs 判断"；建议每 signal 附 `entry_plan` + `scenario` + `flags` 三段独立字段 |

### 6.2 明确放弃 · 不适用（6 项）

| # | 放弃对象 | 原因 |
|---|---|---|
| **D1** | 无 DB · 纯 in-memory + CSV/JSON 缓存 | 我方规模远超工具型（223K LOC + 94 model）· DB 是必须 |
| **D2** | 原生 JS 无框架 UI | 我方 React 18 + 48 页 · 无法回退到静态 HTML |
| **D3** | 单入口 CLI 打日报 | 我方是交互式研究台 · 有 workflow / 回测 / 组合管理 / 实盘桥等场景 CLI 无法承载 |
| **D4** | 单 `MarketProvider` Protocol 5 方法打天下 | 我方需求已明确 6 独立 Protocol（BacktestRunner / RegimeSource / TradeReturnSource / StrategyReturnSource / BenchmarkReturnSource / IndustryDataSource）· 见 Strategy DI 六范式 |
| **D5** | Telegram 通知集成 | li-yiming brief §7 硬性原则 "**禁止移动端 push**"；不适用 |
| **D6** | `config/*.json` universe 内容照搬 | License 红线（§5）+ 我方 universe 有 A + 港美，Strategy 侧自主整理 |

### 6.3 需进一步讨论（3 项）

| # | 讨论项 | 建议下一步 |
|---|---|---|
| **T1** | 是否引入"主题/板块层"作为因子→组合中间抽象 | Strategy 评估现有 `services/theme/**` + `services/event-intelligence/**` 是否已承载 |
| **T2** | forward 1/3/5 日 close-to-close 回测语义（`backtest.py:53-57`）是否契合我方 signals-first | 与 Strategy 的 7 关 gate 对齐 checkpoint |
| **T3** | AkShare 慢回退默认关闭策略 | DataPipeline 评估现有 20+ client 中，多少是"慢回退依赖"、多少是"主链依赖" |

---

## 7 · UX / 交互亮点（Frontend 输入）

（本节仅静态源码检读，未启站现场看）

来自 `web/index.html` + `web/app.js` + `web/styles.css`：

- **Sidebar 主导航 7 tab**（A股早报 / 美股优选 / 日韩市场 / 高倍潜力 / 回测证据 / 每日日报 / 报告历史）· `<nav class="nav-tabs">`（`web/index.html:22-51`）
- **顶栏统一操作三态**（日期选择 · 样例/实时切换 · 刷新按钮）—— 全站共享同一控制条（`web/index.html:66-85`）
- **摘要指标 signal_strip**（A股最强板块 / Catalyst Strength / High Conviction 数量 …）—— 醒目 KPI（`web/index.html:87-100`）
- **每 tab 有搜索 + filter**（`ashareSearch` / `themeFilter` / `usSearch` / `ratingFilter` …）· `web/app.js:47-57`
- **吉祥物插画持续 UX**（`cat-analyst.png` / `cat-box.png` / `cat-happy.png` / `cat-detective.png` / `paw-stamp.png`）—— 品牌统一
- **`copyDailyReport` 一键复制 Markdown**（`web/app.js:47`）—— **QoL 亮点**，Frontend 可借鉴到我方"每日报告"页
- **原生内联 SVG 图标系统**（8 图标 `icons` dict 直接嵌入 `web/app.js:18-26`）· 零 icon 库依赖 —— 与我方 antd + heroicons 并存形成对比

**Frontend 建议**：不必回退到无框架，但**"单页多 tab + 简洁风 + 一键复制 + 醒目 KPI 条"** 4 项可直接引入我方 HomeWorkspace / TodayCommandCenter 页

---

## 8 · 与我方项目现状的**关键差距 & 意图对齐**

| 维度 | 参考项目 | 我方 | 判断 |
|---|---|---|---|
| **业务范围** | 日报工具（研究候选） | 研究 + 回测 + 组合管理 + 实盘桥 + AI Agent | 我方是**参考项目 × 30 复杂度的产品**；理想态只在"研究候选"这一子集是同构的 |
| **代码规模** | ~6.5K LOC | ~223K + 32K + 8.5K + 12 broker-bridge = **~276K LOC** | 参考项目占我方 **~2.3%** |
| **UI 复杂度** | 单页 + 7 tab · 原生 JS | 48 页 + 43 workspace 子页 · React + 3 UI 库并存 | 借鉴其**简洁**（不回退实现） |
| **数据依赖** | 5 pip 包 · 无 DB | 20+ TS client + Py helper + AI HTTP + broker bridge + PostgreSQL + Redis + Bull | 借鉴其**降级策略**（不回退架构） |
| **可解释性** | 每候选 6 维 dimensions + method 字段 | 部分 signal 有解释，部分是黑盒 AI 输出 | **直接借鉴 B2**（可解释输出契约 · Strategy 硬需求） |
| **合规口吻** | 每报头 + UI 侧边栏均醒目 disclaimer | 分散 · 不统一 · 有些页面完全没 | **直接借鉴 B6** + QADocs lint 规则 |
| **License** | 无 LICENSE（红线） | 无仓库根 LICENSE · backend package.json 声明 MIT · AI 应用 Apache-2.0 vendored | 我方缺根 LICENSE **是独立问题**，需 li-yiming 决定顶层策略；参考项目 License 是**参考不可复制** |

---

## 9 · Research 建议 · 下游 owner 消费清单

- **@Strategy**：读 §1.3 catalyst 5 因子 + §1.5 analyst_profile + §3 signal_cutoff + §6.1 B1/B2/B3/B4/B8。评估**是否在 `50-strategy-design.md` v1 引入"主题层"抽象**（T1）+ **是否将可解释输出契约 6 维作为硬约束**（B2）
- **@DataPipeline**：读 §2.3 数据源 + §6.1 B5（直连优先 + 慢回退开关）。评估我方 20+ client 中哪些可退化为**直连 JSON 主链 + AkShare fallback opt-in**
- **@Frontend**：读 §1.2 tab 层 + §7 UX 亮点 + §6.1 B6/B7。评估 HomeWorkspace / TodayCommandCenter 是否借鉴 "单页多 tab + 醒目 KPI 条 + 一键复制 + 简洁 UX"
- **@QADocs**：读 §5 License + §6.1 B6 合规口吻。评估**独立 lint 规则**：report 类页面必须含 `disclaimer` 组件；参考项目引用**只走 "借鉴 idea 独立实现"，禁止代码复制**（写入 `40-quality-gates.md` 章节）
- **@Orchestrator**：本表 §6.1 8 项借鉴 / §6.2 6 项放弃 / §6.3 3 项讨论，请裁哪几项进入 `50-strategy-design.md` / `60-frontend-design.md` / `40-quality-gates.md` 契约签字轨道（**Frontend 独占段号 = 60-69**，dir-ownership v0）
- **@li-yiming**：§5.3 建议**DM 联系作者 `yespsam` 询问 License 授权**；即使拒绝，我方"仅借鉴设计思想独立实现"路径不受阻

---

## 10 · 交叉引用

- 上位：`00-anchor.md` · li-yiming brief msg=afe6236a "参考项目(理想态)代码库"
- 下位：`21-current-audit.md`（我方现状对照）· `22-cleanup-candidates.md`（清理清单）· `23-protect-list.md`（保护清单）
- 契约：`contracts/data.md` §时点对齐（B4 归口）· `contracts/strategy.md` §可解释输出（B2 归口）· `contracts/display.md` §合规口吻（B6 归口）
- ADR：`adr/0001-layering-and-collab.md` §7 硬性原则 "禁止照搬参考项目代码 / 禁止移动端 push"
- 消息 ID 引用：li-yiming msg=aa4a755c · msg=afe6236a · msg=945470f4；Orchestrator msg=a5e73982 · msg=4b0f5bd4

---

**Doc 版本**：v1.0 · 2026-07-07 · Research 起草
**下一批更新触发**：参考项目 License 若由作者补齐 → 更新 §5；主题层评估结论定 → 更新 §6.3 T1
