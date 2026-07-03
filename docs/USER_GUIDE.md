# 用户手册：跑通 ETF 因子轮动 + 题材卫星（QuantX A 股 Signal-First 平台）

> 面向新用户的端到端指南。读完能：启动系统 → 同步 A 股/ETF 数据 → 看懂核心 ETF 因子轮动 → 理解卫星题材机会 → 读持仓复盘 → 用战略镜子做月度自省。
>
> **本平台已收敛为 Signal-First + 核心-卫星主线**（决策依据见 `docs/SIGNAL_FIRST_PLAN.md`）：
>
> - **核心 70% — ETF 因子轮动**：在几十只 ETF 里做机械化因子轮动（Value / Quality / LowVol 三主因子 + Momentum 影子），月度换仓，波动小、不设单笔止损，是收益主要来源。
> - **卫星 20% — 题材/事件驱动**：个股只在卫星层参与，必须过 EV gate + Wilson 下界置信度，单只 ≤5%、总仓 ≤20%，硬止损 / 时间退出。
> - **现金 10%** — 常备缓冲。
>
> 旧的「13+ 个个股策略融合 / 18+ 个个股因子 / Kelly+ATR 三轨 / 每日追涨接力」主线**已整体删除**。这是刻意的减法。

---

## 目录

1. [启动与登录](#1-启动与登录)
2. [数据同步](#2-数据同步)
3. [看懂核心：ETF 因子轮动](#3-看懂核心etf-因子轮动)
4. [理解卫星：题材/事件机会](#4-理解卫星题材事件机会)
5. [持仓与复盘](#5-持仓与复盘)
6. [战略镜子（月度自省）](#6-战略镜子月度自省)
7. [风控边界](#7-风控边界)
8. [常见问题（FAQ）](#8-常见问题faq)

---

## 1. 启动与登录

### 1.1 环境准备

| 工具 | 版本要求 | 用途 |
|------|----------|------|
| Node.js | ≥ v18 | 后端 + 前端运行时 |
| Docker & Docker Compose | 最新 | PostgreSQL（TimescaleDB） + Redis |
| Git | 任意 | 拉代码 |
| Python 3 | ≥ 3.9 | AKShare 数据源 |

### 1.2 启动后端

```bash
git clone <your-repo-url>
cd stocks
docker-compose up -d

cd backend
npm install
cp .env.example .env
npm run check-env
npm run dev
```

访问 <http://localhost:3000/health> 应返回 `{"status":"ok"}`；`/health/detail` 可看 DB / Redis / AKShare 实时状态。

### 1.3 启动前端

```bash
cd frontend
npm install --legacy-peer-deps
cp .env.example .env
PORT=3001 npm start
```

浏览器打开 <http://localhost:3001>，首次点「注册账号」填邮箱 + 密码，自动创建账户 + 默认模拟盘（100 万初始资金）。

### 1.4 主界面：工作区

登录后主视图展示**核心 ETF 因子轮动排名表**（今日 ETF 排名、目标权重、买/卖/持有动作、四因子 z 分）与**卫星题材机会**两块。

| 工作区 | 用途 |
|--------|------|
| 主视图（今日） | 核心 ETF 因子轮动排名 + 卫星题材机会 + 组合快照 |
| 选股因子 | ETF 四因子打分、ETF 调仓清单、行业/宏观/政策辅助 tab |
| 持仓与复盘 | 持仓表、平仓、单笔归因、复盘 |
| 数据中心 | 数据源健康看板、手动同步触发 |
| 账号设置 | 风控阈值、推送通道 |

> 核心 ETF 出现在主视图因子轮动排名表；卫星题材出现在「题材机会」推荐卡片。后端 `core_satellite` 桶字段（core / satellite / cash）保证前端可靠分区。

---

## 2. 数据同步

### 2.1 推荐顺序

```bash
cd backend

# 基础档案（一次性）
npm run sync:stock-basic

# 行情主力（含 ETF 日 K）
npm run sync:daily-bars -- --start=2021-01-01 --end=<today>
npm run sync:financial-report -- --year=2024 --year=2025 --year=2026

# ETF 因子所需
npm run sync:index-components     # 指数成分股 + 权重
npm run sync:fund-top-holdings    # 基金前十持仓（fallback）
```

后端 SchedulerService（cron）自动注册每日盘后同步任务，无需每天手动跑。

### 2.2 UI 内同步

**数据中心 → 数据源健康看板**：核心 ETF 轮动强依赖 `daily_bars`、`index_components` / `fund_top_holdings`、`financial_reports`，这几个务必绿灯。

### 2.3 计算 ETF 因子

因子计算随月度 cron 自动触发（每月末 22:00）。手动跑：

```bash
npm run compute:etf-factors -- --date=<month_end>
```

---

## 3. 看懂核心：ETF 因子轮动

> 核心 70% 只做一件事：**在几十只可交易 ETF 里，按机械因子分排名，月度换仓**，把情绪彻底剥掉。

### 3.1 四个因子（口径见 `SIGNAL_FIRST_PLAN.md` §4.1）

| 因子 | 权重 V0 | 状态 | 经济学锚 |
|---|---|---|---|
| Value（估值）| **0.40** | 主 | Fama-French value premium |
| Quality（质量）| **0.30** | 主 | Asness QMJ，高 ROE / 稳定利润长期跑赢 |
| LowVol（低波）| **0.30** | 主 | 低波异象，MSCI 2025 指出 A 股尤其突出 |
| Momentum（动量）| **0.0 影子** | 只观察 | Hsu 2017 证明 A 股短期动量会反转 |

综合分 = 0.40·z(Value) + 0.30·z(Quality) + 0.30·z(LowVol) + 0.00·z(Momentum)。

Value / Quality：ETF 展开成分股 → 逐股算原始值 → 按权重加权 → ETF 池内 z-score。LowVol / Momentum：直接在 ETF 价格序列上算。

### 3.2 主视图的 ETF 排名表

top 8 排名，每行含：排名、ETF 代码、名称、综合分、目标权重、动作（买/卖/持有）、价值 z / 质量 z / 低波 z。展开可看完整 `reasons` 与四因子 z 明细；数据不全的 ETF 当月被剔除。

### 3.3 换仓规则

- **计算**：每月最后交易日 22:00。
- **执行**：次月第一交易日 9:40 后分批限价 / VWAP。
- **动作**：进 top4 买入、掉出 top6 卖出、其余持有（缓冲带减少换手）。
- **仓位**：核心总仓 70% 硬顶、单只 ETF 15% 封顶。
- **不设单笔止损止盈**：ETF 波动小，月度换仓 + 组合级熔断足够。

---

## 4. 理解卫星：题材/事件机会

> 卫星 20% 是个股唯一的入口，只在「过 EV gate」时才建议。

### 4.1 EV gate 与 Wilson 下界

EV gate 要求信号的期望值（校准胜率 × 盈亏比 − 成本）为正。置信度用 **Wilson 下界**——样本越少压得越低，按 `source_type` 分组用真实平仓胜率持续校准。

### 4.2 卫星退出规则（`SIGNAL_FIRST_PLAN.md` §4.2）

| 触发 | 动作 |
|---|---|
| −15% | 硬止损 |
| +20% | 止盈 |
| 持有 21 交易日 | 时间退出 |
| −7% | 软止损（预警减仓）|
| 60 天滚动亏损超阈值 | 冻结建仓 |
| 连续 3 月 alpha < 0 | 永久停该 detector |

---

## 5. 持仓与复盘

### 5.1 持仓视图结构

**持仓复盘 Workspace** 按 bucket 分两区展示：

| 区 | 内容 | 仓位上限 |
|---|---|---|
| Core（核心）| 当前持有 ETF 列表、入场价、当前综合分、换仓提示 | 70% |
| Satellite（卫星）| 当前持有个股、入场日、退出条件进度、source_type | 20% |
| Cash | 闲置现金、下次换仓倒计时 | 10% |

### 5.2 回测 / 模拟约束

回测引擎遵守以下现实约束，任何参数变更须同步更新  §5：

- **T+1**：当日买入不可当日卖出（A 股限制）。
- **滑点**：默认 0.1%（买卖各一侧），可在 config 覆盖。
- **手续费**：买卖各 0.03%，卖出含 0.1% 印花税（ETF 免印花）。
- **流动性过滤**：卫星买入当日成交额须 ≥ 5000 万，否则跳过信号。

### 5.3 逐笔归因

每笔平仓后自动生成归因记录，含：信号来源（source_type）、持有天数、实际 alpha（vs 沪深 300 同期）、退出触发类型（止盈/止损/时间/信号失效）。  
支持按 regime（趋势 / 区间 / 熊市）切片聚合，帮助判断哪个 detector 在哪种市场有效。

---

## 6. 战略镜子（Strategic Mirror）

> 月度复盘的核心工具。每月生成一份 6 大问、每问 4 层的结构化草稿，强制区分 AI 能填的客观数据与人类必须亲手归因的主观判断。

### 6.1 四层铁律（§8.1）

| 层 | 内容 | 填写人 |
|---|---|---|
| 第 1 层 | 客观数据快照（月度收益、drawdown、换手率等）| **AI 自动填** |
| 第 2 层 | 量化对比（vs 基准、vs 上月目标）| **AI 自动填** |
| 第 3 层 | 归因（为什么对 / 为什么错，至少 1 条亲手写）| **人类必须手写** |
| 第 4 层 | 下月决策签字（策略参数是否调整、是否冻结 detector）| **人类必须签** |

> **AI 不得替人填写第 3、4 层**。草稿里这两层留白，拒绝一切"AI 帮写归因"的请求。

### 6.2 生成草稿

```bash
# 生成当月草稿（已存在则报错 exit 3，保护手写内容）
bash scripts/compass/generate-draft.sh

# 指定月份（补历史）
bash scripts/compass/generate-draft.sh 2026-06

# 强制覆盖（慎用，会丢弃已有手写内容）
bash scripts/compass/generate-draft.sh --force
```

草稿输出至 ；**提交前请先完成第 3、4 层**，再 。

---

## 7. 风控边界

下表是**不可绕过**的硬约束，违反任一条须立即停止操作并记录原因：

| 维度 | Core ETF | Satellite 个股 |
|---|---|---|
| 仓位上限 | 70%（组合）/ 15%（单只）| 20%（组合）/ 5%（单只）|
| 止损 | 无单笔止损（月度换仓机制替代）| 硬止损 −15%，软预警 −7% |
| 止盈 | 无（排名掉出 top6 才卖）| +20% 止盈 |
| 时间退出 | 月末强制重排 | 持有 21 交易日无论盈亏 |
| 组合级熔断 | 月回撤 > 10% → 暂停换仓一个月 | 60 天滚动亏损超阈值 → 冻结建仓 |
| Detector 永久停用 | 不适用 | 连续 3 月 alpha < 0 |
| 现金底仓 | 10% 硬底，不允许满仓 | — |
| 杠杆 | 严禁，含融资融券 | 严禁 |

---

## 8. 常见问题（FAQ）

**Q1：ETF 排名表是空的？**  
A：先跑数据同步：`npm run sync:stock-basic && npm run sync:daily-bars && npm run sync:index-components && npm run compute:etf-factors`。确认 DB 里 `etf_factor_scores` 表有当月数据。

**Q2：为什么没有个股选股列表？**  
A：旧的 13+ 策略个股主线已整体删除。个股建议只来自卫星 detector；若卫星无满足 EV gate 的信号，列表为空是正常状态，代表当前无值得冒险的机会。

**Q3：Momentum 因子权重为 0，还有意义吗？**  
A：有。权重 0 只是当前 V0 校准结果，避免 A 股动量反转陷阱。Shadow 模式持续采集数据，若未来统计显著性改变，可提权至 0.10~0.15。不要手动改权重，须通过 `SIGNAL_FIRST_PLAN.md` §4.1 版本迭代流程记录。

**Q4：某 ETF 显示 `data_incomplete`？**  
A：该 ETF 成分股数据不足（<30 只有效数据），当月自动剔除出排名池。检查 `npm run sync:fund-top-holdings` 是否正常跑完。

**Q5：卫星信号很少，正常吗？**  
A：正常。EV gate 是有意设计的高门槛过滤器——宁可错过，不可乱入。少即是多；如果每天都有大量信号，反而说明 Wilson 置信度校准可能出了问题。

**Q6：月度镜子草稿生成失败，提示数据库连接错误？**  
A：检查环境变量 `DB_HOST / DB_PORT / DB_NAME / DB_USER / PGPASSWORD` 是否正确设置。可先用 `psql -h $DB_HOST -U $DB_USER -d $DB_NAME -c "SELECT 1"` 验证连通性。

**Q7：AI 能帮我写战略镜子第 3、4 层吗？**  
A：不能，也不会。第 3 层归因和第 4 层决策签字是系统的核心约束（§8.1 铁律），AI 只填客观数据层。违反此规则会让镜子退化成自我确认工具。

**Q8：想改月度 cron 时间，怎么操作？**  
A：修改 `backend/src/jobs/` 下对应 job 文件的 cron 表达式，并同步更新 `SIGNAL_FIRST_PLAN.md` §4.1 中的"计算时间"字段，确保文档与代码一致。

---

## 附录：文档索引

| 文档 | 内容定位 |
|---|---|
| `docs/SIGNAL_FIRST_PLAN.md` | 架构决策与设计理由（Signal-First 战略，§1-§9） |
| `docs/REFACTOR_PLAN.md` | 重构执行进度（批次列表、已完成 / 待完成） |
| `docs/trader-system/20_alpha_engine_overview.md` | ETF 因子引擎技术架构 |
| `docs/trader-system/21_alpha_factor_library.md` | 四因子口径定义与计算细节 |
| `docs/trader-system/40_portfolio_construction.md` | 组合构建规则（Core-Satellite 比例） |
| `docs/trader-system/41_position_sizing.md` | 仓位计算方法 |
| `docs/trader-system/42_rebalancing.md` | 换仓流程与缓冲带规则 |
| `docs/FUNCTION_GUIDE_AND_OPERATION_MANUAL.md` | 功能手册（各 Workspace 操作步骤） |
| `docs/DEVELOPER_GUIDE.md` | 开发者指南（新增因子、接口约定） |
| `docs/PROJECT_COMPASS.md` | 战略镜子模板（§8 六大问固定结构） |
| `docs/compass/YYYY-MM.md` | 每月镜子草稿（脚本自动生成，人工补写后提交） |

