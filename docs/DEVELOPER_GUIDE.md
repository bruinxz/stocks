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
# 1. 启动数据库与 Redis；Compose 密码必须与后端 DB_PASSWORD 一致
export POSTGRES_PASSWORD='<choose-a-local-dev-password>'
docker compose up -d
cp backend/.env.example backend/.env
# 编辑 backend/.env：填写 DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD

# 2. 安装依赖
cd backend && npm ci
cd ../frontend && npm ci --legacy-peer-deps

# 3. 迁移数据库
cd backend && npm run db:migrate

# 4. 启动后端（port 3000）
npm run dev

# 5. 另开终端启动前端（port 3001）
cd frontend
cat > .env.development.local <<'EOF'
REACT_APP_API_BASE_URL=http://localhost:3000/api
EOF
PORT=3001 npm start
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
│   │   └── library/           ← A 股横截面因子库
│   ├── etf/                   ← ETF 四因子计算、成分展开与排名
│   └── strategies/            ← ETF 轮动等策略入口
├── services/
│   ├── etf/ETFRotationService.ts     ← Core bucket 月度换仓计算
│   ├── theme/ThemeEventFanoutService.ts ← Satellite bucket 信号分发
│   ├── cash/CashAllocationService.ts ← Cash bucket 管理
│   └── calibration/ConfidenceCalibrationService.ts ← Wilson 置信度校准
└── scripts/                   ← CLI 入口（sync-* / compute:factors 等）

frontend/src/
├── App.tsx                    ← 路由单一事实源
├── pages/catdesk/             ← 牛牛研究台与八个业务页
├── pages/workspace/           ← 旧工作区及管理页
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

### 3.2 后端：扩展 ETF 因子服务

ETF 因子不走 A 股横截面的 `FactorRegistry`。当前单一实现位于
`backend/src/quant/etf/ETFFactorService.ts`。新增因子时必须在同一批修改：

1. `ETFFactorWeights` 与 `ETFFactorScore` 类型；
2. `ETFFactorDataSource` 的输入契约和默认实现；
3. `computeForUniverse()` 的横截面标准化与缺失值处理；
4. 综合分公式及 `reasons`；
5. `ETFRotationStrategy`、`ETFRankingService` 和对应测试。

### 3.3 加入权重配置

```typescript
// backend/src/quant/etf/ETFFactorService.ts
export const ETF_FACTOR_WEIGHTS_V0 = {
  value: 0.35,
  quality: 0.25,
  lowvol: 0.25,
  dividend: 0.10,
  momentum: 0.00,  // shadow 永不参与合成分
};
```

### 3.4 更新前端显示

在 `frontend/src/pages/workspace/FactorWorkspace.tsx` 的 `CATEGORY_DISPLAY` 对象中追加：

```typescript
dividend: { label: '股息', color: 'green' },
```

---

## 4. 新增卫星 Detector

卫星信号由 `backend/src/services/BullishEventDetectorService.ts`、
`backend/src/services/ThemeFermentationDetector.ts` 等检测器产生，再由
`backend/src/services/theme/ThemeEventFanoutService.ts` 扇出。新增来源时要定义稳定的
`source_type`，接入相应 detector/fan-out，并在 `SchedulerService` 与
`constants/cronRegistry.ts` 同时登记任务。

### 4.3 EV gate 规则（不可绕过）

- Wilson 下界置信度：按 `source_type` 分组，用真实历史平仓胜率校准（见 `backend/src/services/calibration/ConfidenceCalibrationService.ts`）
- EV = wilsonLower(winRate, n, z=1.645) × payoffRatio - tradingCost
- EV 决策见 `backend/src/services/meta-v2/EVDecisionService.ts`；实际下单门禁在 `PaperTradingAutomationService` 执行
- 冷启动或样本不足时保持纸面模式，不得伪装成已通过 EV gate

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

把定时任务 dispatch 加入 `backend/src/services/SchedulerService.ts`，同时在
`backend/src/constants/cronRegistry.ts` 和 `ensureDefaultTasks()` 登记，并更新相关运维文档。

---

## 6. 编写测试

后端既有自定义 TypeScript 测试入口，也有 Jest 用例；前端使用 React Scripts/Jest。
优先通过仓库脚本运行全量测试，定位单文件时再用 `ts-node`：

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
cd backend
npm test
npx ts-node --transpile-only tests/etf/dividend-factor.test.ts

cd ../frontend
CI=true npm test -- --runInBand --watch=false
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
# 更新 A 股横截面因子底座
cd backend && npm run compute:factors -- --date=YYYY-MM-DD

# ETF 因子轮动没有独立的 compute:etf-factors 脚本；
# 在调度任务页手动执行 ETF_FACTOR_ROTATION_REBALANCE，并检查 task_execution_logs。
```

### 9.2 卫星 EV 校准调试

```bash
# 相关实现与日志入口
rg -n "ConfidenceCalibration|EV gate" backend/src/services backend/src/portfolio
```

### 9.3 常见问题速查

| 现象 | 排查步骤 |
|---|---|
| ETF 排名表空 | 检查日 K、成分股、估值和财务数据水位；手动执行 `ETF_FACTOR_ROTATION_REBALANCE` 并查看任务日志 |
| 卫星信号未进入实盘 | 检查 `ConfidenceCalibrationService` 输出、样本量和 `PaperTradingAutomationService` 的 EV gate 日志 |
| 后端 500 / DB 连接失败 | 检查 `.env` 的 DB 连接配置；用 `psql` 验证连通性 |
| 前端编译错误增加 | 用 `npx tsc --noEmit 2>&1 | grep error` 定位具体文件 |
| 定时任务不触发 | 检查 Redis 连通性（Bull queue 依赖 Redis）；查 `workspace/data → 调度任务` tab |

---

*如有更复杂的扩展需求，先在 `docs/SIGNAL_FIRST_PLAN.md` 记录决策理由，再写代码。文档是架构的单一事实源。*
