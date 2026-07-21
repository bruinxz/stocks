# 股票系统整体模块审计与全球科技市场收口（2026-07-22）

审计范围：前端产品入口、后端 API、行情数据、推荐/因子、回测、AI、组合与模拟盘、实盘桥接、调度、通知、数据库、部署和可观测性。生产只读证据采集时间为 2026-07-22 02:47–02:49（Asia/Shanghai），代码基线为 `main@52e8eb90`，生产 release 为 `20260722023429-main`。

## 完成度结论

用户要求的全球科技市场口径已经完成并在线：

- 美股首屏固定为“6 个科技板块涨幅 → 12 只突出科技股 → 6 只高关注科技 ETF”；不再使用 A 股映射候选，也不展示全市场其他个股。
- 韩股默认只展示 8 只科技代表股和 4 个科技板块涨幅；日本仅保留为次级参考入口。
- 美股数据更新至 2026-07-21，共 20 个标的、280 条日行情；韩股代表股更新至 2026-07-21，共 8 个标的。
- 桌面 1440px 与窄屏 390px 已在生产页面验收；窄屏文档宽度与视口一致，无全局横向溢出。

整体项目仍有明确缺口。下表中的问题是审计结果，不表示美股/韩股交付未生效。

## 功能模块逐项审计

| 模块 | 当前状态 | 仍存在的问题 | 优先级 |
| --- | --- | --- | --- |
| 产品入口与导航 | CatDesk 10 个主页签 + 6 个专业工作台可用 | CatDesk、`/workspace/*` 与 `/legacy/backtest/:id` 仍有术语和能力重叠；`/api/v1/screener` 仍是公开的 501 占位接口 | P1 |
| 身份认证与权限 | Access + Refresh Session、登录限流、管理员路由鉴权已实现 | 生产 `DEFAULT_ADMIN_AUTO_LOGIN=true`，任何能访问站点的人都可请求默认管理员会话；仅适合有独立网络边界的 kiosk 部署。应用数据库角色仍是 `postgres`，未落实最小权限 | P0/P1 |
| A 股行情与数据源 | `daily_bars` 最新 2026-07-21，页面 fresh；动态数据源路由已实现 | 7 个数据源仅 2 healthy：Baostock unhealthy，AKShare/EastMoney/Tencent degraded；多个 provider 的基础资料、指数成分或交易日方法仍返回空/未实现 | P1 |
| A 股早报/日报/档案 | 三页可用 | 都复用 `ai_recommendation_snapshot/cn_a` 水位，最新为 2026-07-20，无法区分“推荐生成、日报投影、报告归档”是否分别成功 | P1 |
| 自动荐股与信号反馈 | 后验、质量日报、参数维护链路健康 | 自动荐股链路为 critical：缺少“量化策略全市场扫描”，且“全市场荐股闭环”已停用；因此后验链路可能健康但没有稳定新增样本 | P0/P1 |
| 美股科技 | 6 板块、12 代表股、6 ETF，页面 fresh | Yahoo public chart 是单一外部来源；尚无备用源或交易所日历，休市日仍借用 A 股参考交易日判断 freshness | P2 |
| 韩股科技/日本参考 | KR 默认 8 股、4 板块，页面 fresh；JP 为次级入口 | 韩股数据使用 Naver public 单一来源；板块为代表股等权收益，不等同于交易所行业指数；JP 与 KR 仍共用一个历史 API 模块 | P2 |
| 高倍潜力 | 页面可用 | 最新快照 2026-07-16，落后 3 个交易日且状态 delayed；生成任务和源数据没有保持每日水位 | P1 |
| 回测引擎 | 事件驱动回测、量化回测、PIT 快照均有测试覆盖 | 存在两套回测路径；组合级策略若没有 `precomputed_composite_signals` 会退化为 hold/零交易；`same_close` 仍保留兼容路径，虽已警告但容易误用 | P1 |
| 因子与策略研究 | 因子计算、IC、参数版本、Walk Forward 等能力齐全 | 最近 7 天“因子 IC 自动计算”和“每日因子分数计算”各失败 4 次；大服务/控制器集中，变更风险高 | P1 |
| AI 分析/TradingAgents | 本地 vendored 服务健康，provider、模型、内部 API 和数据库均 ready | `/api/ai/analyze/stream` 与 `/api/ai/analyze-stock/stream` 未鉴权；匿名请求可触发最长 20 分钟分析，后者还会落匿名报告。数据源健康表中的 TradingAgents 最近成功时间仍停在 2026-06-01，与真实服务健康不一致 | P0/P1 |
| 我的持仓/模拟盘/风控 | 多组合账本、风控、归因、退出和自动跟单已实现 | 自动跟单链路缺少“推荐信号模拟盘跟单”；买入防重仍是单进程内存 TTL marker，多实例会失效；组合收益模拟的 weighted 分配明确未实现 | P1 |
| 实盘交易桥接 | QMT 能力矩阵与 HMAC/nonce 桥接存在，默认保持受控 | PTrade 仍是 stub，读账户、持仓、委托和交易均未实现；上线前仍需完成 launch checklist，不应把“桥接服务可启动”当成“券商交易可用” | P1 |
| 定时任务与队列 | 100 个任务、78 个启用；当前无 RUNNING/stuck 任务 | 最近 7 天 3660 次执行中 52 次 FAILED；失败集中于全球市场旧手动任务、黑天鹅、因子、组合调仓、雪球、龙虎榜、新维度和模拟盘 snapshot | P1 |
| 通知与告警 | 飞书已使用持久化 outbox，具备重试、dead、管理员查询/重投；用户消息可正常发送 | outbox 当前 `critical`：38 dead、6 sent、1 suppressed。36 条 dead 发生在最近 24 小时，原因是 `OPS_ALERT_FEISHU_WEBHOOK` 未配置；因此系统日报、数据新鲜度和重大公告运维通知没有送达 | P0 |
| 数据库与迁移 | 运行时 schema 探针通过；全球科技行情迁移已应用 | 应用以 PostgreSQL 超级用户 `postgres` 运行；99 个迁移文件与启动期修复并存，仍需统一版本表和回滚演练 | P1 |
| 部署与容量 | release 健康门禁已改为轮询；3 GB 前端构建堆在 8 GB 主机验证通过；当前磁盘 74%、剩余 16 GB | 主机无 swap，4 GB 构建堆曾触发 OOM；release 目录约 6 GB、备份约 4.3 GB，缺少明确的备份与 source-only release 保留策略 | P1/P2 |
| 可观测性与质量门禁 | 后端、前端、OpenAPI、架构、弱密钥和枚举门禁均在 CI；生产两服务 health 正常 | “服务进程健康”“业务链路健康”“通知已送达”仍是分散信号；例如服务 health 为绿而自动荐股和通知均为 critical | P1 |
| 可维护性 | snake_case、契约测试和模块目录边界已有约束 | 后端 235K LOC；`PaperTradingAutomationService` 7497 行、`SchedulerService` 7440 行。前端 `EasyQuantWorkspace` 2807 行、`FactorWorkspace` 2004 行，形成明显 god object | P2 |

## 生产证据摘要

### 运行与数据水位

- Release：`/opt/stocks/releases/20260722023429-main`
- 后端：`status=ok`；TradingAgents：`ready=true, runtime=vendored`
- 系统盘：58 GB，已用 43 GB，剩余 16 GB（74%）
- 页面水位：A 股 2026-07-21；美股 2026-07-21；韩股 2026-07-21；早报/日报/历史 2026-07-20；高倍潜力与回测证据 2026-07-16
- 调度：100 total / 78 active / 52 failures in 7 days / 0 current stuck
- 数据源：2 healthy / 3 degraded / 1 unhealthy / 1 disabled
- 飞书 outbox：38 dead / 6 sent / 1 suppressed / 0 backlog（没有待重试不等于健康，dead 已终止重试）

### 美股验收证据

| 层级 | 固定范围 | 生产 API 结果 |
| --- | --- | --- |
| 板块代理 | SMH、XLK、BOTZ、FDN、IGV、CIBR | 6 个，按最新日涨幅排序 |
| 科技代表股 | AMD、AVGO、NVDA、AAPL、TSLA、META、GOOGL、ORCL、AMZN、MSFT、PANW、CRWD | 12 只，只返回 `instrument_type=stock && is_focus` |
| 高关注 ETF | QQQ、SOXX、SMH、XLK、IGV、CIBR | 6 只，按最新日成交额排序；页面明确“关注度不等于推荐” |

板块涨幅使用代理 ETF 日涨幅。首屏顺序由 `USStockPicks.tsx` 固定为板块、股票、ETF；旧 `/api/v1/us-select` 和其 A 股映射已删除。

### 韩股验收证据

| 层级 | 固定范围 | 生产 API 结果 |
| --- | --- | --- |
| 科技代表股 | 277810、035420、035720、006400、373220、005930、000660、042700 | 8 只 |
| 科技板块 | AI/机器人、互联网平台、电池、半导体 | 4 个，按代表股等权日涨幅排序 |

KR 是默认视图；API 在 KR 分支用 `KR_TECH_REPRESENTATIVES` 强制过滤，页面不会展示其他韩股。日本按钮仍可手动进入，但不是默认市场。

## 优先处置顺序

1. 配置并验证运维飞书 webhook，重投仍有业务价值的 dead 通知；同时给 webhook 配置缺失增加启动期 fail-fast 或明确 disabled 状态。
2. 为两条 AI SSE 路由增加一次性短期票据或同源 cookie 鉴权与用户级限流，停止匿名长任务和匿名报告落库。
3. 明确 kiosk 网络边界；若无独立访问控制，关闭生产默认管理员自动登录。将应用数据库用户从 `postgres` 降为最小权限角色。
4. 修复自动荐股和模拟跟单缺失任务，再处理 7 天失败最多的因子、组合调仓与数据同步任务。
5. 为全球市场增加各自交易日历和备用行情源；拆分早报、日报、历史的独立水位。
6. 补齐组合策略回测适配、weighted 组合模拟和 PTrade 适配前，不把对应入口标记为完整可用。
7. 拆分两个 7000+ 行后端服务和两个 2000+ 行前端工作台，收敛 legacy 深链与 501 占位路由。

## 结论

“美股/韩股聚焦科技板块与少量代表标的”已完成、合入并在线；项目整体 review 也已覆盖主要产品与运行模块。当前系统可用于研究与模拟，但运维通知、匿名 AI SSE、自动荐股链路、默认管理员会话和数据库最小权限是下一批必须优先处理的问题；PTrade 和部分组合/回测能力仍不能宣称完整生产可用。
