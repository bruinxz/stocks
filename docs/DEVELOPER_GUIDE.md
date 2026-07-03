# 开发者指南：扩展 QuantX

> Signal-First + ETF Core-Satellite 主线版本（重构后，2026-07）
>
> 读完本文档后，你能：
> (a) **新增 ETF 四因子扩展**（新增第 5 个因子或调整现有因子口径）；
> (b) **新增卫星 Detector**（新增 EV gate 接入的事件/题材信号源）；
> (c) **新增数据源**（AKShare 拉取 → 落库 → CLI + scheduler）；
> (d) **写干净的单元测试**（项目内置 mock 框架）；
> (e) 按项目约定**提交代码**通过 CI 闸门。
>
> **已删内容**：旧版"新增策略（个股）"、"新增因子（个股横截面）"、"Kelly+ATR 仓位"等指南已整体移除，对应代码已物理删除。

---

## 目录

1. [环境搭建](#1-环境搭建)
2. [项目结构速查](#2-项目结构速查)
3. [新增 ETF 因子](#3-新增-etf-因子)
4. [新增卫星 Detector](#4-新增卫星-detector)
5. [新增数据源](#5-新增数据源)
6. [编写测试](#6-编写测试)
7. [前端扩展约定](#7-前端扩展约定)
8. [提交与 CI 规范](#8-提交与-ci-规范)
9. [调试技巧](#9-调试技巧)

---

## 1. 环境搭建

### 1.1 依赖

- Node 18+（后端 TypeScript、前端 React）
- Postgres 14+（主 DB）
- Redis 6+（Bull queue、session cache）
- Python 3.9+（AKShare 数据采集，`backend/python/akshare_helper.py`）

### 1.2 本地启动

```bash
# 1. 复制 env
cp backend/.env.example backend/.env  # 填写 DB_HOST / DB_PORT / DB_NAME / DB_USER / PGPASSWORD

# 2. 安装依赖
cd backend && npm install
cd ../frontend && npm install

# 3. 迁移数据库
cd backend && npm run db:migrate

# 4. 启动后端（port 3001）
npm run dev

# 5. 启动前端（port 3000）
cd ../frontend && npm run dev
```

### 1.3 编译健康基线

```bash
# 前端 — 目标 ≤93 错误（历史遗留类型问题）
cd frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"

# 后端 — 目标 0 错误
cd backend && npx tsc --noEmit
```

每次 PR 前确认编译数不退步。

---

## 2. 项目结构速查

```
backend/src/
├── api/controllers/           ← HTTP handler（只编排不写业务）
├── api/routes/                ← Express 路由注册
├── config/database.ts         ← Sequelize 初始化 + model 注册
├── data/sources/              ← Python helper 的 TS 包装层
├── data/services/             ← DB 写入 + 断点续传
├── jobs/                      ← 定时任务（ETF 因子计算、日K线同步等）
├── models/                    ← Sequelize-typescript 实体
├── quant/
│   ├── factors/
│   │   ├── types.ts           ← Factor / FactorContext 契约
│   │   ├── FactorRegistry.ts  ← 全局单例
│   │   ├── FactorPipeline.ts  ← 横截面 winsorize→zscore→percentile
│   │   └── etf/               ← ETF 四因子实现（Value/Quality/LowVol/Momentum）
│   └── satellites/            ← 卫星 Detector（EV gate 接入）
├── services/
│   ├── ETFRotationService.ts  ← Core bucket 月度换仓计算
│   ├── ThemeEventFanoutService.ts ← Satellite bucket 信号分发
│   └── CashAllocationService.ts  ← Cash bucket 管理
└── scripts/                   ← CLI 入口（sync-* / compute-etf-factors）

frontend/src/
├── App.tsx                    ← 路由单一事实源
├── pages/HomeWorkspace.tsx
├── pages/workspace/           ← 各 Workspace 主文件 + sub-tab helpers
├── components/layout/WorkspaceLayout.tsx
└── services/                  ← API client（unwrap {success,data} envelope）
```

---

## 3. 新增 ETF 因子

ETF 四因子当前为 Value / Quality / LowVol / Momentum（Shadow）。如需新增第 5 个因子（例：Dividend 股息因子）：

### 3.1 决策记录先行

在 `docs/SIGNAL_FIRST_PLAN.md` §4.1 新增一行版本条目：

| 因子 | 权重 | 状态 | 加入版本 | 经济学锚 |
|---|---|---|---|---|
| Dividend | 0.10 | V1（2026-Q3）| ... | 高股息 + 低波协同 |

> 先记录，后写代码。没有文档的权重变更视为无效。

### 3.2 后端：实现 FactorCalculator

```typescript
// backend/src/quant/factors/etf/DividendFactor.ts
import { ETFFactorCalculator } from "../types";

export class DividendFactor implements ETFFactorCalculator {
  readonly key = "dividend";
  readonly category = "yield";

  async compute(etfCode: string, context: ETFFactorContext): Promise<number | null> {
    // 展开成分股 → 加权平均股息率
    // 返回 null 表示数据不足，该 ETF 当月被剔除
    return weightedAvgDividendYield(etfCode, context.components);
  }
}
```

### 3.3 注册到 FactorRegistry

```typescript
// backend/src/quant/factors/FactorRegistry.ts — 在 registerAll() 里追加
this.register(new DividendFactor());
```

### 3.4 加入权重配置

```typescript
// backend/src/config/factorWeights.ts
export const ETF_FACTOR_WEIGHTS = {
  value: 0.35,
  quality: 0.25,
  lowvol: 0.25,
  dividend: 0.10,
  momentum: 0.00,  // shadow 永不参与合成分
};
```

### 3.5 更新前端显示

在 `frontend/src/pages/workspace/FactorWorkspace.tsx` 的 `CATEGORY_DISPLAY` 对象中追加：

```typescript
dividend: { label: '股息', color: 'green' },
```

---

## 4. 新增卫星 Detector

卫星 Detector 是产生题材/事件机会信号的模块。每个 Detector 对应一个 `source_type`（如 `earnings_surprise`、`sector_rotation_theme`）。

### 4.1 实现 SatelliteDetector 接口

```typescript
// backend/src/quant/satellites/EarningsSurpriseDetector.ts
import { SatelliteDetector, SatelliteSignal } from "./types";

export class EarningsSurpriseDetector implements SatelliteDetector {
  readonly sourceType = "earnings_surprise";

  async detect(context: DetectorContext): Promise<SatelliteSignal[]> {
    // 1. 从 DB 拿近期财报超预期股票
    // 2. 计算 EV = wilsonLowerBound(winRate, n) * payoffRatio - cost
    // 3. 只返回 ev > 0 的信号
    return signals.filter(s => s.ev > 0);
  }
}
```

### 4.2 注册到 ThemeEventFanoutService

```typescript
// backend/src/services/ThemeEventFanoutService.ts
this.detectors.push(new EarningsSurpriseDetector());
```

### 4.3 EV gate 规则（不可绕过）

- Wilson 下界置信度：按 `source_type` 分组，用真实历史平仓胜率校准（见 `backend/src/jobs/evCalibrationJob.ts`）
- EV = wilsonLower(winRate, n, z=1.645) × payoffRatio - tradingCost
- 只有 EV > 0 的信号才能进入 satellite bucket
- 新 Detector 前 20 次信号自动降权（样本量保护）

### 4.4 退出规则继承

所有 Detector 统一遵循 `SIGNAL_FIRST_PLAN.md` §4.2 退出表（−15% 硬止损 / +20% 止盈 / 21d 时间退出），无需单独配置。

---

## 5. 新增数据源

### 5.1 Python 层（AKShare）

```python
# backend/python/akshare_helper.py — 在对应 section 追加
def fetch_dividend_history(stock_code: str) -> list:
    """获取股票历史分红记录，用于 Dividend 因子计算"""
    df = ak.stock_dividend_cninfo(symbol=stock_code)
    return df.to_dict(orient="records")
```

### 5.2 TS 包装层

```typescript
// backend/src/data/sources/DividendClient.ts
export class DividendClient {
  async fetchHistory(stockCode: string) {
    return callPython("fetch_dividend_history", { stock_code: stockCode });
  }
}
```

### 5.3 SyncService + DB 写入

```typescript
// backend/src/data/services/DividendSyncService.ts
// 标准断点续传模式：
// 1. 查最新已有日期
// 2. 只拉 delta
// 3. upsert（on conflict do update）
```

### 5.4 添加 CLI + scheduler

```bash
# backend/src/scripts/sync-dividend.ts — 注册新 script
# 然后在 package.json scripts 里加：
# "sync:dividend": "ts-node src/scripts/sync-dividend.ts"
```

把定时任务加入 `backend/src/jobs/` 对应文件，并在 `FUNCTION_GUIDE_AND_OPERATION_MANUAL.md` §11 更新任务表。

---

## 6. 编写测试

项目单测采用 **IIFE + process.exit** 模式（不依赖 jest，无需 test runner 配置）：

```typescript
// backend/tests/etf/dividend-factor.test.ts
(async () => {
  const factor = new DividendFactor();
  const result = await factor.compute("159919", mockContext);
  if (result === null || result < 0) {
    console.error("FAIL: dividend factor returned invalid value", result);
    process.exit(1);
  }
  console.log("PASS: dividend factor =", result);
  process.exit(0);
})();
```

```bash
ts-node backend/tests/etf/dividend-factor.test.ts
```

### Mock 约定

- DB mock：在 `backend/tests/helpers/mockDb.ts` 提供 in-memory stub。
- Python mock：在 `backend/tests/helpers/mockPython.ts` 拦截 `callPython` 调用。
- 不要在单测中真实调用 AKShare API，避免网络依赖和速率限制。

---

## 7. 前端扩展约定

### 7.1 新增 Workspace Tab

在对应 Workspace 文件的 `TABS` 数组中追加条目：

```typescript
{ key: 'dividend', label: '股息视图', icon: <FundOutlined /> },
```

然后在 `renderTabContent()` 对应 `case` 里渲染内容。

### 7.2 新增 API Service 方法

```typescript
// frontend/src/services/factorService.ts
export async function getDividendFactorData(etfCode: string) {
  const res = await apiClient.get<DividendFactorData>(
    
  );
  return unwrap(res);  // 解包 {success, data} envelope
}
```

### 7.3 编译检查

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep -c "error TS"
# 必须 ≤93（不退步）
```

---

## 8. 提交与 CI 规范

### 8.1 Commit 格式（Conventional Commits）

```
<type>(<scope>): <subject>

type: feat | fix | docs | refactor | test | chore
scope: 批7m | etf-factor | satellite | data-sync | frontend | ...
subject: 中英均可，不加句号
```

示例：

```
feat(etf-factor): 新增 Dividend 因子（V1 权重 0.10）
docs(批7m): DEVELOPER_GUIDE 重写为 ETF Core-Satellite 主线
```

### 8.2 批次约定

- 每个批次 = **一个可回滚 commit**，15 分钟内可 `git revert`。
- 批次号记录在 `docs/REFACTOR_PLAN.md`，完成后更新状态。
- 删表前：`grep -r <TableName> backend/src/` 确认无运行时引用 + `pg_dump` 备份。

### 8.3 禁止行为

- 禁止在 PR 里同时混入功能变更和重构（分批提）
- 禁止绕过 EV gate 直接往 satellite bucket 写信号
- 禁止手动修改因子权重而不更新 `SIGNAL_FIRST_PLAN.md` §4.1
- 禁止删表而不先 grep-confirm + pg_dump 备份

---

## 9. 调试技巧

### 9.1 ETF 因子计算调试

```bash
# 手动触发当月因子计算，输出详细日志
cd backend && npm run compute:etf-factors -- --verbose

# 查看某只 ETF 的因子分解
curl http://localhost:3001/api/factors/etf-picks | jq '.data[] | select(.code == "159919")`
```

### 9.2 卫星 EV 校准调试

```bash
# 查看各 source_type 当前胜率/盈亏比/EV
curl http://localhost:3001/api/signals/ev-calibration | jq .
```

### 9.3 常见问题速查

| 现象 | 排查步骤 |
|---|---|
| ETF 排名表空 | 检查 `etf_factor_scores` 表是否有当月数据；跑 `compute:etf-factors` |
| 卫星信号全部 EV < 0 | 检查 `ev_calibration` 表胜率数据；样本量 < 20 时 Wilson 下界会很低 |
| 后端 500 / DB 连接失败 | 检查 `.env` 的 DB 连接配置；用 `psql` 验证连通性 |
| 前端编译错误增加 | 用 `npx tsc --noEmit 2>&1 | grep error` 定位具体文件 |
| 定时任务不触发 | 检查 Redis 连通性（Bull queue 依赖 Redis）；查 `workspace/data → 调度任务` tab |

---

*如有更复杂的扩展需求，先在 `docs/SIGNAL_FIRST_PLAN.md` 记录决策理由，再写代码。文档是架构的单一事实源。*
