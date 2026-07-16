# 前端架构与信息架构

更新时间：2026-07-17。本文描述当前 `frontend/src`，不是历史 `/home` 蓝色后台版本。

## 1. 默认入口与会话

- `/`、`/login` 与旧工作区入口最终进入公开可浏览体验；主入口为 `/catdesk`。
- `App.tsx` 启动时通过 `authService.defaultLogin()` 自动建立默认管理员会话。
- 页面不要求用户手工填写登录表单；API 仍使用合法 Bearer Token，自动会话不是后端鉴权后门。
- 自动会话失败必须显示连接/服务错误，不允许伪造数据继续渲染。

## 2. CatDesk 信息架构

`CatDeskLayout` 是主布局，使用暖纸风、陶土橙、手绘牛牛与克制动效。

| Tab key | 页面 | 组件 |
|---|---|---|
| `market` | A 股市场 | `tabs/a-share-market/AShareMarket` |
| `morning` | A 股早报 | `tabs/AShareMorningBrief` |
| `us` | 美股优选 | `tabs/USStockPicks` |
| `jpkr` | 日韩市场 | `tabs/jpkr/JpKrMarket` |
| `multi` | 高倍潜力 | `tabs/multibagger/HighMultipotential` |
| `backtest` | 回测证据 | `tabs/backtest/BacktestEvidence` |
| `daily` | 每日日报 | `tabs/daily-report/DailyReportContainer` |
| `history` | 报告历史 | `tabs/report-history/ReportHistoryContainer` |

路由使用 query 参数切 Tab，内容组件懒加载。Tab 请求必须使用 AbortSignal，切换页面时取消旧请求，避免早报催化等交互发生竞态或卡死。

## 3. 数据时间

`PageFreshnessStamp` 在所有 Tab 共用布局中调用 `GET /api/data/page-freshness`，显示当前页面真实数据日期、最后写入时间和延迟状态，每 5 分钟刷新一次。

页面自己的 KPI 时间仍保留；全局水位用于回答“这一页实际看到的是哪天的数据”。禁止用浏览器当前日期替代 API 水位。

## 4. 日报层级

- A 股是详细主报告：保留个股证据清单、评分、确信度、风险门禁与仓位提示。
- 美股、日本、韩国只在 `GlobalCatalystSummary` 输出整体评分、指数方向、上涨覆盖率及 A 股板块映射。
- 报告历史默认筛选 `us_preferred/cn_a`，可显式切换海外大势档案。

## 5. 数据访问

- 通用认证请求：`services/api.ts` 的 `authenticatedFetch` / Axios 实例。
- 推荐契约：`tabs/recommendationCandidates.ts` 与 `daily-report/recommendationAdapter.ts`。
- 日报/历史：`daily-report/tab67Api.ts`，继续执行严格 v0.3.1 契约和指纹校验。
- 日韩：`jpkr/useJpKrData.ts`，市场数据与推荐快照并发加载。
- A 股行情：`/api/stocks` + `/api/market/history/:symbol`。

不得在组件内写生产地址、凭据或供应商密钥。

## 6. 视觉约束

- CatDesk：暖纸、黑墨、陶土橙、薄荷绿/淡紫作为状态色，牛牛只做功能性陪伴。
- 简易版 `/workspace/easy`：遵循 `docs/EASY_QUANT_UI_DESIGN_GUIDELINES.md`。
- 移动端退化为自然单列滚动；表格允许横向滚动。
- 同一屏最多一个深色主 CTA。
- 新状态必须覆盖 loading / empty / unavailable / error，禁止用 mock 数据填空。

## 7. 质量门

```bash
cd frontend
CI=true npm test -- --runInBand --watch=false
npm run build
npm run lint
```

改动 CatDesk Tab 时至少覆盖：快速切换取消请求、自动会话、不显示登录表单、数据水位、空快照和后端不可用状态。
