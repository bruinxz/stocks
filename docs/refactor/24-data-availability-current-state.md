# 24 · 数据可得性现状表 (Data Availability Current State · Bonus)

**Owner**: @Research（read-only 审计输出 · 独占 20-24-*.md）
**Consumers**: @DataPipeline（`70-data-sources-consolidation.md` v1 数据源选型附录 · Data Contract v1 冻结前置输入） · @Strategy（§11.1 因子底表数据源依赖）
**Input**: `21-current-audit.md` §5.1（20 Python spawn client 详表 · 已核实为 22 个 client）· @Orchestrator msg=168b6275 Part 4 · A/B/C 三态定义 · @DataPipeline msg=b9bf7286 v0.2 数据源分层策略
**Path**: `/Users/bytedance/go/src/github.com/bruinxz/stocks/docs/refactor/24-data-availability-current-state.md`

---

## 0. 说明

- **本表 = Research 只读审计结果** · 不含线上凭证 / token / 密钥字面 · 不 dump `.env*`
- **样本口径**：`backend/src/data/sources/*.ts` 22 个 client · 静态代码扫描（`grep spawn/token/rateLimit/delay`）· 未跑真实请求（生产验证走 DataPipeline SSH B-2 深化）
- **A/B/C 三态定义**（@Orchestrator msg=168b6275 Part 4）：
  - **A · 直可用** · 无 token / 无限速 / 无反爬 · 优先接入 P0
  - **B · 需治理** · token 配额 / 限速降级 / user-agent 伪装 / 代理池 · 走 ADR 前置论证 · P1
  - **C · 高风险** · 合规灰 / 反爬强 / 单点依赖 · 默认弃用 · 需 li-yiming 显式授权
- **License 独立性红线**：本表**不移植**参考项目 `yespsam/a-share-us-catalyst` 的数据源实现 · 参考项目 License = `null` (all rights reserved) · 我方独立实现
- **重要**：本表**不是生产准入表** · 是**代码内声明的能力** vs **实际可用性**的静态盘点 · 生产准入需 DataPipeline SSH B-2 深化跑真实 429/timeout/quota 验证后落 `70-data-sources-consolidation.md` v1

---

## 1. 完整清单（22 client · 22 = 21 §5.1 20 + 补 EastMoneyClient + CombinedDataSource + MarketDataProvider 中 CombinedDataSource + MarketDataProvider 属聚合器）

**分类**：
- **原始 client**（19）· 一对一映射数据源
- **聚合器**（3）· `CombinedDataSource.ts` `MarketDataProvider.ts` `EastMoneyClient.ts`（EastMoney 属原始 + 半聚合）

### 1.1 一览表（22 项 · A/B/C 建议 · Research 静态判定 · 待 DataPipeline 生产验证）

| # | Client (TS 文件) | 数据源 | Spawn Python | Token/Key 需求 | 限速/反爬迹象 | 静态判定 (A/B/C) | 主要理由 | DataPipeline v0.2 §2.1 分层 |
|---|-----------------|--------|--------------|---------------|--------------|---------|----------|--------------------------|
| 1 | `TushareClient.ts` (107 LOC) | Tushare Pro | ❌ (TS 直调 Python via env) | ✅ `TUSHARE_TOKEN` / `TUSHARE_PRO_TOKEN` env | 服务端配额（120 min/day 免费 · Pro 需付费）· 静态未见客户端限流 | **B** (Pro token 需付费 · 配额需治理) | Tushare 有明确 quota 与账户等级 · 需 token · 稳定但需治理 | **主链**（v0.2 §5） |
| 2 | `BaostockClient.ts` (80 LOC) | Baostock | ❌ (TS 直调 · 无 spawn) | ❌ (匿名 login) | 服务端限速未文档化 · 客户端无限流 | **A** (匿名可用 · 官方 SDK) | Baostock 开源匿名接入 · 无 quota · 稳定 | **主链**（v0.2 §5） |
| 3 | `AKShareClient.ts` (329 LOC) | AKShare | ✅ spawn `akshare_helper.py` | ❌ | AKShare 是 web scraper 聚合 · **反爬风险随上游站源变化** | **B** (Python 桥 · 慢回退 opt-in · 有反爬风险) | AKShare 靠 East Money / Sina / 交易所页面 scrape · 上游反爬时 client 也失效 | **慢回退 opt-in**（v0.2 §5 · `--allow-akshare-fallback` false 默认） |
| 4 | `SinaFinanceClient.ts` (359 LOC) | Sina Finance | ❌ (TS 直调 HTTP) | ❌ | ✅ 代码 line 276 明写 "Add a tiny delay to avoid rate limiting" · 客户端限流已加 | **B** (客户端限流已加 · 反爬中风险 · 无 token 但依赖 UA 伪装) | Sina 是公开 quote 接口 · 无 token · 但反爬存在 · 已内嵌 delay | **快照/实时**（v0.2 §2 快照通道） |
| 5 | `TencentFinanceClient.ts` (162 LOC) | Tencent (`qt.gtimg.cn`) | ❌ (TS 直调 HTTP) | ❌ | 未见客户端限流 · 未 flag 429 处理 | **B** (无 token · 反爬中风险 · 需 DataPipeline 生产验证限流) | Tencent qt 接口公开 quote · 与 Sina 同源竞态 · 需限流治理 | **快照/实时**（备用） |
| 6 | `EastMoneyClient.ts` (610 LOC) | East Money 综合 | ❌ (TS 直调 HTTP) | ⚠ 代码内 comment 明写 "该接口不需要 token，适合作为 Tushare 未配置时的 <轻量增强>" (line 363) | 未见客户端限流 · 内嵌"Tushare 未配置时的轻量增强"策略 | **B** (无 token · 但大量字段依赖 · 反爬中风险) | EastMoney 综合数据 · 覆盖 K 线 + 基本面 + 行业 · 大 LOC 610 · 生产验证需大量真实调用 | **主链兜底/回退**（v0.2 §5 备选） |
| 7 | `AnalystForecastClient.ts` (161 LOC) | 分析师预测（源未确） | ✅ Python bridge | ❌ | 未 flag | **B** (源未确 · 需 Python 生产验证) | 21 §5.1 归类"AnalystForecast" · 数据源 unclear · 静态判 B | 待 v0.2 §3 决策矩阵决 |
| 8 | `AnnouncementClient.ts` (141 LOC) | 上市公告 | ✅ Python bridge | ❌ | 未 flag | **B** | 公告数据源可能是巨潮/AKShare · 需生产验证 | 待 v0.2 §3 |
| 9 | `BlackSwanClient.ts` (256 LOC) | 黑天鹅事件（源未确） | ✅ Python bridge | ❌ | 未 flag · 但 21-current-audit §3.3 `/api/black-swan` undocumented | **B**（可能 C · 若源单点依赖）| 黑天鹅事件源不明确 · 需 DataPipeline 揭源 · 21 §3.3 路由 undocumented | 待揭源 |
| 10 | `DragonTigerClient.ts` (132 LOC) | 龙虎榜 | ✅ Python bridge | ❌ | 未 flag | **B** | 龙虎榜官方 · AKShare `stock_lhb_*` · 反爬中风险 | 待 v0.2 §3 |
| 11 | `ETFFlowClient.ts` (155 LOC) | ETF 资金流 | ✅ Python bridge | ❌ | 未 flag | **B** | ETF 资金流数据源 · AKShare `fund_etf_*` 系列 · 生产验证 | 待 v0.2 §3 |
| 12 | `EarningsForecastClient.ts` (139 LOC) | 业绩预测 | ✅ Python bridge | ❌ | 未 flag | **B** | 业绩预测 · Tushare `forecast_vip` or AKShare · 需揭源 | 待 v0.2 §3 |
| 13 | `IndexComponentClient.ts` (134 LOC) | 指数成分股 | ✅ Python bridge | ❌ | 未 flag | **A** (若走 Tushare/Baostock · 主链) 或 **B** (若走 AKShare 反爬) | 指数成分数据源多份 · Strategy §11.1 底表依赖 · **需明确主链** | **主链**（v0.2 §5） |
| 14 | `IndustryFlowClient.ts` (145 LOC) | 行业资金流 | ✅ Python bridge | ❌ | 未 flag | **B** | 行业资金流 · AKShare `stock_sector_fund_flow_*` · 反爬中 | 待 v0.2 §3 |
| 15 | `LimitDownClient.ts` (124 LOC) | 跌停股 | ✅ Python bridge | ❌ | 未 flag | **B** | AKShare `stock_zt_pool_*` · 反爬中 · 时点敏感 | 待 v0.2 §3 |
| 16 | `LimitUpClient.ts` (129 LOC) | 涨停股 | ✅ Python bridge | ❌ | 未 flag | **B** | 同 LimitDown · AKShare `stock_zt_pool_*` | 待 v0.2 §3 |
| 17 | `MarginBalanceClient.ts` (129 LOC) | 融资融券余额 | ✅ Python bridge | ❌ | 未 flag | **B** | AKShare `stock_margin_*` 或 Tushare · 需揭源 · 涉 §11.1 卫星层 | 待 v0.2 §3 |
| 18 | `NorthboundDataClient.ts` (154 LOC) | 北向资金 | ✅ Python bridge | ❌ | 未 flag | **B** | AKShare `stock_hsgt_*` · 反爬中 · 官方 HKEX 港交所可信 | 待 v0.2 §3 |
| 19 | `PythonMarketDataClient.ts` (97 LOC) | Market Data 通用（源未确） | ✅ spawn `market_data_helper.py` | ❌ | 未 flag | **B** (通用 · 需揭源) | 通用 market data 桥 · 源不明确 | 待揭源 |
| 20 | `RestrictedShareClient.ts` (161 LOC) | 限售解禁 | ✅ Python bridge | ❌ | 未 flag | **B** | AKShare `stock_restricted_*` · 官方 · 反爬中 · Strategy §11.1 卫星 catalyst 相关 | 待 v0.2 §3 |
| 21 | `SnowballHotKeywordClient.ts` (135 LOC) | 雪球热词 | ✅ Python bridge | ❌ (但雪球有 cookie/session 反爬) | 未 flag · **雪球对匿名/高频调用反爬强** | **C** (合规灰 · 反爬强 · 单点依赖 · 需 li-yiming 授权) | 雪球是社区平台 · 匿名调用受限 · 高频反爬 · 属"热度信号"辅助数据不核心 | 建议 **弃用** or **降级到 sentiment 辅助** |
| 22 | `StockQAClient.ts` (158 LOC) | 股票 Q&A（源未确） | ✅ Python bridge | ❌ | 未 flag · 源未确 | **C**（若走雪球/东财股吧则反爬强 · 若走其他社区则合规灰） | Q&A 数据源多为社区论坛 · 反爬强 · 合规灰 · 与 §11.1 主线因子无关 | 建议 **弃用**（Strategy §11.1 无依赖） |

### 1.2 聚合器/工具类

| # | Path | 类型 | 说明 |
|---|------|------|------|
| K1 | `CombinedDataSource.ts` | 聚合器 | 多 client 聚合 · 无独立源 · 无 spawn/token/limit 语义 · 走 Strategy T+1 review |
| K2 | `MarketDataProvider.ts` | 工厂 | 依 env / config 选 client · 无独立源 |

---

## 2. Token/Key 需求汇总

**只依赖 `.env` 环境变量 · Research 不 dump 内容**：

| Env var | Client | 是否付费 | 建议 |
|---------|--------|---------|------|
| `TUSHARE_TOKEN` / `TUSHARE_PRO_TOKEN` | TushareClient | Pro 需付费 · 免费版 120 min/day quota | 主链依赖 · 走 `DataUpdateLog` 登记额度 · **li-yiming 私域裁定 Pro or 免费**|
| `TUSHARE_ENABLED` | TushareClient enable flag | env boolean | Strategy `factor_scores` 底表依赖 · 建议 `true`|
| `PYTHON_PATH` | AKShareClient + 其他 spawn 类 | 无付费 · 本地 python3 | 部署 script `remote_setup.sh` 承接 |
| `--allow-akshare-fallback` | DataPipeline v0.2 §5 | 无付费 | 默认 `false` · opt-in 慢回退 |

**其他 `.env*` 项**：走 22-cleanup §H · li-yiming 私域裁定 · 本表不列。

---

## 3. 反爬 / 限速静态盘点（代码内声明）

| Client | 静态代码痕迹 | 生产验证需求 |
|--------|-------------|-------------|
| SinaFinanceClient:276 | `// Add a tiny delay to avoid rate limiting` | ✅ 已加客户端限流 · DataPipeline 需验证 delay 时长充分性 |
| 其他 21 client | ❌ 未见客户端限流 / 429 handler | ⚠ 生产验证需 DataPipeline SSH B-2 深化跑真实 429/timeout · 加限流器 · v0.2 §5 主链/慢回退分层 |
| Python spawn 类（16 项）| Python 侧 rate limit 在 `akshare_helper.py` / `market_data_helper.py` · Research 未审 Python 代码 | ⚠ DataPipeline v0.2 §5 需明确 Python 层是否加限速 |
| AKShare 上游依赖 | AKShare 本身 wraps 东财/新浪/交易所/等等 · **无统一 SLA** | ⚠ 参考项目 catalyst B5 数据源策略：直连 + 慢回退（我方 v0.2 §5 采纳 · 独立实现） |

---

## 4. A/B/C 三态分布

- **A · 直可用**（2 · 建议 P0 接入）：
  - Baostock（匿名 · 主链候选）
  - IndexComponent（若走 Baostock/Tushare 主链）
- **B · 需治理**（17）：
  - Tushare（token 配额 · 主链）
  - AKShare（慢回退 opt-in）
  - SinaFinance（客户端限流已加 · 反爬中）
  - TencentFinance（无限流 · 生产验证）
  - EastMoney（大 LOC · 反爬中 · 兜底）
  - AnalystForecast / Announcement / DragonTiger / ETFFlow / EarningsForecast / IndustryFlow / LimitDown / LimitUp / MarginBalance / Northbound / PythonMarketData / RestrictedShare
- **C · 高风险**（3 · 默认弃用 · 需 li-yiming 授权）：
  - SnowballHotKeyword（雪球反爬强 · 合规灰）
  - StockQA（社区 Q&A · 反爬强 · Strategy §11.1 无依赖）
  - BlackSwan（源未揭 · 若单点依赖则风险高 · 21 §3.3 undocumented）

---

## 5. Strategy §11.1 因子底表依赖对应

@Strategy msg=678eb3e0 · Strategy 需求：`factor_scores` / `stock_*_factors` 底表数据源终端语义稳定 · **走 tushare/baostock 主链是否覆盖三张表**。

**Research 静态盘点结论**：
- **Value 因子** (V0.4) · PB/PE 需 Tushare `daily_basic` + Baostock 备选 → **A/B 主链覆盖 ✅**
- **Quality 因子** (Q0.3) · ROE/ROA/负债率 · Tushare `fina_indicator` → **B 主链需 Tushare Pro token ⚠**
- **LowVol 因子** (L0.3) · 波动率派生 · 需 Baostock/Tushare 日线 → **A/B 主链覆盖 ✅**
- **Momentum 因子** (M0.0 shadow) · 涨跌幅派生 · 需 Baostock/Tushare 日线 → **A/B 主链覆盖 ✅**
- **卫星层 detector 数据依赖** (Strategy msg=c71a49e0 §1.4.3)：
  - `UsDriverSignalDetector` · 美股主题源 · 需 US 数据源（本表未列 · **单独 gap ⚠**）
  - `HistoryResponseDetector` · A 股响应 · 主链覆盖 ✅
  - `IntradayMomentumDetector` · 当日入场 · 主链日线 + TechnicalIndicators 计算 ✅
  - `QualityProxyDetector` · 基本面 + size · Tushare `fina_indicator` + `stock_basic` ✅
  - `NewsEvidenceDetector` · 新闻词表 · Strategy Q8 自研 + Announcement/DragonTiger client 佐证 ✅

**关键 gap**：US 数据源 (`UsDriverSignalDetector`) 在本表 22 client 中**无 explicit 支持** · Strategy 卫星层若强依赖 US 数据 · 需 DataPipeline 增加 US client（e.g. `YahooFinanceClient` 或参考项目 catalyst 用的 `us_quality` 数据源 · **参考项目 License 红线 · 我方独立实现**）

---

## 6. 与 DataPipeline v0.2 §5 主链/慢回退分层的对应

| DataPipeline v0.2 §5 分层 | 本表 client | 判定 |
|--------------------------|------------|------|
| **主链（TS 直连）** | TushareClient / BaostockClient / SinaFinanceClient / TencentFinanceClient / EastMoneyClient | ✅ 5 client · 均 TS 直调 · 无 spawn |
| **慢回退 opt-in（Python spawn subprocess）** | AKShareClient + 其余 16 spawn 类 | ⚠ 17 client · Python 层需限速/token 治理 |
| **弃用/合规灰** | SnowballHotKeywordClient / StockQAClient | 建议弃用 · 走 li-yiming 授权 |

**结论**：DataPipeline v0.2 §5 分层与 Research 本表 A/B/C 判定基本对齐 · 唯一 flag = US 数据源 gap（Strategy 卫星层需求）+ 3 项 C 类需 li-yiming 处置。

---

## 7. 建议 (Research 不预判 · 交 DataPipeline + Strategy + Orchestrator)

### 7.1 立即行动（DataPipeline v0.2 §3 决策矩阵纳入）
1. **明确 US 数据源 gap** · Strategy 卫星层 `UsDriverSignalDetector` 需求 · DataPipeline v0.2 §3 增加 US client 决策项（YahooFinance / Alpha Vantage / IEX Cloud / …）
2. **揭源 4 项 unclear client**（AnalystForecast / Announcement / BlackSwan / PythonMarketData）· DataPipeline SSH B-2 深化跑真实调用 · 落 v0.2 §3 决策矩阵注释
3. **Tushare Pro token 决策** · Strategy Quality 因子硬依赖 · li-yiming 私域裁定付费 or 免费降级
4. **雪球/StockQA 处置** · 建议弃用 · 若 Strategy `NewsEvidenceDetector` 词表需要 sentiment · 走 Announcement/DragonTiger 内建源不引雪球

### 7.2 M-Draft 三绿前置
- DataPipeline v0.2 §3 决策矩阵内 · 每 client 明写 A/B/C 判定 + 主链/慢回退分层 + Strategy 因子底表映射
- 本表 Research 静态判定 → DataPipeline 生产验证 → 落 `70-data-sources-consolidation.md` v1 · 一次性收敛
- v0.2 §5 `--allow-akshare-fallback` opt-in flag 默认 `false` + `DataUpdateLog` 登记 · 与本表 17 项 spawn 慢回退呼应

### 7.3 保护清单联动
- 22 client 全部归 §P3 数据契约/底表/采集器保护 glob `backend/src/data/sources/**`
- Cleanup 独占窗口零触碰 · 除非本表 C 类 3 项经 Orchestrator + li-yiming 双签授权删除

---

## 8. 跨引用

- 21-current-audit.md §5.1 · 20 Python spawn client 详表 → 本表 22 client 完整（含 EastMoney/CombinedDataSource/MarketDataProvider 补充）
- @Orchestrator msg=168b6275 Part 4 · A/B/C 三态定义 → 本表 §0 + §4 分布
- @DataPipeline msg=b9bf7286 v0.2 §5 主链/慢回退分层 → 本表 §6 对应
- @Strategy msg=678eb3e0 · `factor_scores` 底表 · @Strategy msg=c71a49e0 §1.4.3 卫星层 5 detector → 本表 §5 因子映射
- 23-protect-list.md §P3 `backend/src/data/sources/**` → 本表 §7.3 保护联动
- 参考项目 License 红线 · @Orchestrator msg=6df76bdf Part A · 参考项目词表全域禁字面照搬 → 本表 §0 独立性声明

---

**Research 交付状态**：Bonus (`24-data-availability-current-state.md`) v0 · 已提交 DataPipeline + Strategy · 生产验证由 DataPipeline SSH B-2 深化完成后收敛入 `70-data-sources-consolidation.md` v1。
