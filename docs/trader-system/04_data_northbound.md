# 04 — 北向资金

## A. 操盘手心智

北向是 A 股 **"聪明钱"** 之一（外资），由沪深港通通道流入。优势：
- 外资风格更"价值偏成长"，对大白马票（茅指数、宁组合）权重高
- 配置周期长（≥ 6 个月），方向性强：连续 5+ 日大幅净流出，往往是趋势级别拐点
- 信息相对干净（受境外监管 + 信披）

我每天看的北向维度：
- **全市场净流入/净流出（日级）**：判断今日外资态度
- **单股北向持股比例**（hold_ratio %）：识别外资重仓 vs 减仓股
- **单股北向变动（1 日 / 5 日 / 20 日）**：抓"外资加仓/减仓"信号
- **沪股通 vs 深股通分开**：识别 SH 偏蓝筹 vs SZ 偏成长的资金风格差异

**3 个典型 use case**：
1. **NorthboundFollow 策略**：北向连续 5 日加仓 + hold_ratio 5 日变化 > +0.5% → 跟随买入
2. **撤离预警**：持仓股北向 3 日净流出 > 5% 流通股 → 减仓
3. **大盘择时**：北向单日全市场 < -100 亿 + 三日累计 < -200 亿 → 触发 RegimePolicy "降仓位"

**不看北向**：错过外资风格切换的时点；做错"白马股估值修复 vs 长期持有"

---

## B. 系统设计

### B.1 schema 推荐

**NorthboundHolding**（现有 [`backend/src/models/NorthboundHolding.ts`](../../backend/src/models/NorthboundHolding.ts) 108 行）：
- PK: `(trade_date, stock_code)`
- 字段：hold_volume / hold_amount / hold_ratio / market_type ∈ {SH, SZ}
- ✅ 已包含 SH/SZ 区分

### B.2 6 项硬要求

1. **T+1 同步**：港交所 T+1 早 9:00 披露昨日数据；cron 09:30 拉
2. **沪深通通道区分**：market_type 必须正确填 SH/SZ（**或并集**：'北向'）
3. **历史回填**：至少 2 年回填，便于因子 IC 计算
4. **变动衍生计算**：1 日 / 5 日 / 20 日 hold_ratio 变动 不进表，**因子层临时算**（避免冗余 + 重算成本）
5. **QFII vs 陆股通区分（可选）**：QFII 是另一通道，目前仓内只覆盖陆股通；QFII 需另接（暂缺）
6. **缺数据回填**：港交所节假日会缺，service 应自动检测并 +1 日回填

### B.3 衍生信号

由 `NorthboundFactor` ([`backend/src/quant/factors/library/NorthboundFactor.ts`](../../backend/src/quant/factors/library/NorthboundFactor.ts)) 算 20 日 hold_ratio 变化：
- 因子在 `factors/CLAUDE.md` 表中归类 flow 类
- 失效条件：当日无数据 或 窗口内仅 1 条

---

## C. 现状 review

### C.1 已实现

| 项 | 文件:行 | 状态 |
|---|---|---|
| NorthboundHolding model | [`NorthboundHolding.ts`](../../backend/src/models/NorthboundHolding.ts) | ✅ 完整 |
| NorthboundSyncService | [`NorthboundSyncService.ts`](../../backend/src/data/services/NorthboundSyncService.ts) 170 行 | ✅ 含 syncDate / syncRange / skipExisting |
| NorthboundFactor | [`library/NorthboundFactor.ts`](../../backend/src/quant/factors/library/NorthboundFactor.ts) | ✅ 因子已上线 |
| NorthboundFollow 策略 | grep "NorthboundFollow" backend/src/quant/strategies/ | ✅ 待勘探 |
| Python helper | [`akshare_helper.py:785-895`](../../backend/python/akshare_helper.py) `get_northbound_holdings` | ✅ |

### C.2 关键缺口

| # | 缺什么 | 证据 | 影响 |
|---|---|---|---|
| 04-1 | **市场级"全市场净流入"无独立表** | grep "northbound_market\|north_total\|market_north" backend/src 无结果 | 大盘择时模型要 join 全表 sum 计算，慢 |
| 04-2 | **节假日缺数据无自动回填** | NorthboundSyncService 只在 `skipExisting=false` 时回填 | 港假期后第一天可能要手动跑 |
| 04-3 | **QFII 通道未接入** | grep "qfii\|QFII" backend/src/models 无结果 | 部分外资不通过陆股通的看不到 |
| 04-4 | **变动衍生因子计算重复**：1d / 5d / 20d 在多个因子里各算一遍 | NorthboundFactor + DragonHead 策略都算 | 重算成本，可缓存 |
| 04-5 | **没有"北向单日异常告警"**：单日变动绝对值 > 3% 流通股本应触发预警 | RiskAlert 表无 rule_id='northbound_abnormal' | 异常变动无显式告警 |
| 04-6 | **hold_ratio 数值口径**：AKShare 给的是 "持股市值占A股市值比" vs "持股数量占发行股百分比"，Python helper 取了 setdefault 第一个匹配（[`akshare_helper.py:826-828`](../../backend/python/akshare_helper.py)）— 数值口径偶然性，可能跨日不一致 | 注释 "优先选第一个匹配到的占比列" | hold_ratio 跨期可比性弱 |

---

## D. 改造方案

### D.1 P0

**US-04-1：固定 hold_ratio 口径**
- 描述：在 Python helper 显式选择 "持股市值占A股市值比"（口径稳定）；同时新增列 `hold_pct_of_float`（流通股本占比）；保留 raw_payload 让因子可选
- 验收：随机选 50 只蓝筹股，hold_ratio 计算口径与东财网站一致

**US-04-2：北向异常告警 cron**
- 描述：每日 17:00 跑 `NorthboundAnomalyDetector`：抽 100 只持仓 + 候选股，hold_ratio 单日变化 > 1.5% 写 RiskAlert(rule_id='northbound_abnormal_buy/sell')
- 验收：alert 表能查到示例；飞书弱告警

**US-04-3：节假日自动回填**
- 描述：cron 09:30 跑 + 11:30 再跑一次（兼港交所延迟）；若昨日无数据 +前 7 日逐日检测
- 验收：5 日内无数据缺口；缺口写 `data_quality_alerts`

### D.2 P1

**US-04-4：建立 NorthboundMarketSnapshot 表**
- 描述：每日聚合写一行（trade_date PK）：total_inflow / total_outflow / net / sh_net / sz_net；MarketSentimentIndex 直接 join，避免每次重算
- 验收：择时回测从全表 sum 改为 join 单表，性能 ≥ 5×

**US-04-5：QFII 接入（可选 / 后期）**
- 描述：AKShare `stock_qfii_*` 系列接入；建 `qfii_holdings` 表
- 验收：QFII 季报披露日（窗口 1/4/7/10 月）数据可查

### D.3 P2

**US-04-6：变动衍生因子缓存**
- 描述：建 `northbound_change_summary` 派生表：(trade_date, stock_code, ratio_change_1d, _5d, _20d)；每天 cron 跑一遍
- 验收：因子计算 IC 时延降低

---

## E. 验收口径

1. 任选 30 只白马股（茅指数 + 宁组合），过去 1 年北向数据完整度 = 100%（除港假期）
2. 北向异常告警：手动制造一只股 hold_ratio 1 日变化 > 2% → alert 必出
3. NorthboundFollow 策略 paper trading 1 个月：跟随成功率 ≥ 55%
4. 大盘北向择时：回测 2020-2026，北向连续 3 日 < -100 亿信号触发后 5 日大盘平均跌幅 -1.5% 以上（验证信号有效性）

---

## 引用文件清单

- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/NorthboundHolding.ts](../../backend/src/models/NorthboundHolding.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/NorthboundSyncService.ts](../../backend/src/data/services/NorthboundSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/factors/library/NorthboundFactor.ts](../../backend/src/quant/factors/library/NorthboundFactor.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/python/akshare_helper.py](../../backend/python/akshare_helper.py)（L785-895）
