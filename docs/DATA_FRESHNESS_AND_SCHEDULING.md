# 数据水位与定时同步

本文是生产数据新鲜度、页面时间展示和定时任务的事实源。更新时间：2026-07-17。

## 1. 水位原则

1. A 股最近完整交易日是全系统参考日：17:00 前取上一交易日，17:00 后取当日；不能直接使用 `daily_bars.max(time)`，因为盘中可能已存在少量当日日 K。
2. 页面必须展示“实际数据日期/写入时间”，不能用浏览器当前时间冒充数据时间。
3. 美股、日股、韩股是 A 股催化源，允许相对 A 股参考日落后 1 个自然日；A 股行情、因子和日报不允许落后。
4. 周期披露数据（财报、分红）按披露周期判断，不能用日行情阈值误报。
5. `SUCCESS` 只代表任务处理器结束，不等于数据最新；必须同时检查目标表 watermark 和覆盖数。

## 2. 页面水位

`GET /api/data/page-freshness` 返回八个 CatDesk 页面的：

- `latest_data_date`
- `latest_data_at`
- `reference_trade_date`
- `lag_days`
- `status`：`fresh` / `delayed` / `missing`
- `source`

前端每 5 分钟刷新一次该接口，并在页面标题下显示结果。

## 3. 调度基线（Asia/Shanghai）

| 类型 | Cron | 说明 |
|---|---|---|
| `REALTIME_QUOTE_SYNC` | `*/5 9-11,13-14 * * 1-5` | 处理器只在 09:30-11:30、13:00-15:00 真正取数 |
| `GLOBAL_MARKET_DAILY_SYNC` | `0 9 * * *` | 每日 A 股日报、JP/KR 市场、美股/日本催化快照；不受 A 股节假日门禁影响 |
| `DAILY_UPDATE` | `10 17 * * 1-5` | A 股日级增量 |
| `SYNC_HISTORY` | `0 18 * * 1-5` | 全市场历史 K 线补洞 |
| `DATA_FRESHNESS_CHECK` | `30 18 * * 1-5` | 陈旧度告警 |
| `DATA_QUALITY_SCAN` | `0 23 * * *` | 空表、旧数据、漂移深扫 |

A 股工作日任务还会经过交易日历 guard；`GLOBAL_MARKET_DAILY_SYNC` 明确绕过该 guard。服务器重启错过 09:00 后会 catch-up；单次失败还会在进程内每 10 分钟重试，最多两次。

JPX 官方日报是 PDF 数据源。部署流程会将
`scripts/ops/requirements-global-markets.txt` 安装到后端 `PYTHON_PATH` 指向的共享
Python 运行时；该运行时必须对 `stocks_app` 服务用户可读、可执行。

## 4. 只读审计

```bash
node scripts/tests/quant_data_freshness_check.js
```

脚本默认复用后端的节假日感知交易日历。需要复核历史截面时，才显式传入
`EXPECTED_DATA_DATE=YYYY-MM-DD` 覆盖自动参考日。

检查范围包括：A 股日 K、近 10 个交易日覆盖率、股票/指数/ETF 分类覆盖、全市场实时行情覆盖、因子、涨停、公告、A 股日报快照、美股/日本快照、日韩行情、高倍潜力、回测 PIT、旧量化信号以及两条关键 cron 配置。

脚本只读。退出码非 0 表示至少一个关键链路缺失或落后；警告项也会保留在 JSON 输出中，不允许静默忽略。

## 5. 海外每日同步

`scripts/ops/sync_global_markets_daily.py` 顺序执行：

1. 获取 JPX 最近交易日行情与 BOJ 日元水位；
2. 更新韩国观察池行情；
3. 生成 A 股详细日报快照；
4. 生成美股与日本催化快照。

海外内容在日报中只呈现市场趋势、上涨覆盖率及映射到 A 股的板块，不逐只展开海外股票。

## 6. 故障处理

- 任务 `SUCCESS` 但 watermark 不动：检查 `result_summary`、源站空响应和写入覆盖数。
- 实时行情延迟：确认 task cron 为 5 分钟、`is_active=true`、最近运行没有 overlap skip。
- 全球 09:00 任务失败：先查看 `failed_steps` 与两次自动重试结果；修复单个来源后可手动补跑该 task。
- 服务重启后任务未注册：`/health/detail` 的 scheduler active count 必须与数据库 active task 数一致。
- 数据补齐后必须重跑只读审计，并在页面头部确认日期变化。

## 7. 安全

审计与同步脚本只从进程环境或服务器 `shared/backend.env` 读取凭据。日志和 `result_summary` 不得输出密码、令牌、完整连接串或私钥。
