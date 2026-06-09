# 开发者指南：扩展 QuantX A 股 Alpha 平台

> 面向二次开发者的端到端指南。读完本手册后，你能：(a) 在本仓库内**新增一个数据源**（从 AKShare 拉数据 → 落库 → 暴露 CLI / scheduler）；(b) **新增一个因子**（注册到全局 registry → 接 FactorPipeline → 横截面 zscore 化）；(c) **新增一个策略**（per-stock 或组合级两种形态）；(d) 用项目内置 mock 框架**写干净的单元测试**；(e) 在常见踩坑场景下高效**调试**；(f) 按本仓库**约定提交代码**通过 CI 闸门。
>
> 适用版本：US-001 ~ US-100 重构后的"6 工作区"版本（2026 年 6 月之后）。
>
> 阅读前置：建议先读 [docs/USER_GUIDE.md](./USER_GUIDE.md) 了解产品功能与术语；本文档假设你已经能本地启动 backend / frontend / Postgres / Redis 全栈，能跑 `npm test`。

---

## 目录

1. [项目结构](#1-项目结构)
2. [添加新数据源](#2-添加新数据源)
3. [添加新因子](#3-添加新因子)
4. [添加新策略](#4-添加新策略)
5. [编写测试](#5-编写测试)
6. [调试技巧](#6-调试技巧)
7. [提交规范](#7-提交规范)

---

## 1. 项目结构

整个仓库分 `backend/` + `frontend/` + `docs/` + `scripts/` + `integrations/` 五块；本指南只覆盖 `backend/` + `frontend/`（其余两块面向运维 / 部署）。

### 1.1 后端目录速查

```
backend/
├── python/
│   └── akshare_helper.py          ← AKShare 全部 Python 调用集中此处（US-005+）
├── src/
│   ├── api/
│   │   ├── controllers/           ← HTTP handler；只编排不写业务（US-003 约束）
│   │   └── routes/                ← Express 路由注册；遵循子路径先于 :param（US-015 教训）
│   ├── backtest/                  ← 历史回测引擎（事件驱动）
│   ├── config/
│   │   ├── database.ts            ← Sequelize 初始化 + 全部 model 注册
│   │   └── env.ts                 ← env 加载 + check-env CLI 支持
│   ├── constants/                 ← 业务白名单（famousSeats / etfIndustry 等）
│   ├── data/
│   │   ├── sources/<Source>Client.ts     ← Python helper 的 TS 包装层
│   │   └── services/<Source>SyncService.ts  ← DB 写入 + 断点续传
│   ├── jobs/                       ← Bull queue worker（长时回测 / 全市场同步）
│   ├── live-trading/               ← QMT / Ptrade live trading 适配层
│   ├── metrics/                    ← Prometheus 指标埋点
│   ├── middlewares/                ← JWT auth / 请求日志 / 错误兜底
│   ├── models/<Entity>.ts          ← Sequelize-typescript 实体；register in models/index.ts AND config/database.ts
│   ├── portfolio/
│   │   ├── PaperTradingFacade.ts   ← 模拟盘的 7 个 public method（US-003 收敛）
│   │   └── internal/               ← facade 内部实现，controller 不直接 import
│   ├── quant/
│   │   ├── engine/                 ← StrategyEngine / SignalEngine 调度核心
│   │   ├── factors/
│   │   │   ├── types.ts            ← Factor / FactorContext 契约
│   │   │   ├── FactorRegistry.ts   ← 全局单例
│   │   │   ├── FactorPipeline.ts   ← 横截面 winsorize → zscore → percentile
│   │   │   ├── normalization.ts    ← 横截面工具（**非**时序）
│   │   │   └── library/            ← 全部因子文件，自我登记 import-time
│   │   ├── strategies/             ← 31+ 策略，两种形态共存（见 strategies/CLAUDE.md）
│   │   ├── backtest/               ← 多策略回测 + 优化器（GridSearch / Bayesian / WalkForward）
│   │   ├── performance/            ← Sharpe / MaxDD / IC 等绩效计算
│   │   └── health/                 ← QuantRuntimeHealthService（健康看板）
│   ├── scripts/                    ← CLI 入口（sync-* / compute-factors / cleanup-old-data 等）
│   ├── services/                   ← 跨域 service（AI / Risk / Scheduler / Trading）
│   └── utils/                      ← 日志、ST 名识别、Redis 锁等通用 utility
└── tests/                          ← 单测；IIFE + process.exit 模式（不依赖 jest，见 §5）
```

### 1.2 前端目录速查

```
frontend/src/
├── App.tsx                         ← 路由 + 顶层菜单单一事实源（US-001）
├── pages/workspace/<X>Workspace.tsx ← 6 个工作区主页；用 WorkspaceLayout（US-002）
├── components/
│   ├── layout/WorkspaceLayout.tsx  ← 220px 左侧 tabs + 96px KPI bar + children
│   └── monaco/MonacoSourceViewer.tsx ← 只读代码 viewer（US-093）
├── services/<X>Service.ts          ← API client；unwrap {success,data} envelope（US-015）
├── store/                          ← Redux Toolkit
├── hooks/useIsMobile.ts            ← 响应式 breakpoint（US-095）
└── index.css                       ← 全局样式，工作区相关 css 在文件底部分块
```

### 1.3 三处必读 CLAUDE.md

提交前快速翻 3 处 module-level CLAUDE.md，避免重写已有模式：

| 路径 | 覆盖 |
|------|------|
| `backend/src/quant/CLAUDE.md` | 5 个 quant facade 边界 / 跨层 import 规则 |
| `backend/src/quant/factors/CLAUDE.md` | 因子设计契约 + 标准模板 |
| `backend/src/quant/strategies/CLAUDE.md` | 两种策略形态 + 组合级 5 条约定 |

> 仓库根目录的 `ralph/progress.txt` 顶部"Codebase Patterns"是更宏观的横向 patterns（约 90 条），改大特性前 grep 一下相关关键词。

---

## 2. 添加新数据源

> **目标**：把一个 AKShare endpoint 落库 → 暴露成 CLI + scheduler 定时任务 + （可选）业务查询 endpoint。
>
> **3 个标准范式**（来自 US-005..US-092 共 22 个数据源的累积）：
> - 全市场扫描类（US-005 北向）：每日单 endpoint，写主键 (date, code) 表；
> - 多端点合并类（US-091 融资融券 / US-092 ETF Flow）：跨交易所 / 跨端点拼接，注意"day-to-day diff 推算缺失累计字段"模式；
> - 白名单 universe 类（US-092 ETF Flow）：只拉业务白名单内的 N 个代码，暴露 query controller。

### 2.1 5 文件清单

| 文件 | 职责 | 模板出处 |
|------|------|----------|
| `backend/python/akshare_helper.py` | 新增 `def get_<source>(...)` + 在 `main()` 加 dispatcher case | US-005 `get_northbound_holdings` |
| `backend/src/models/<Source>.ts` | Sequelize 实体；register in `models/index.ts` **AND** `config/database.ts` | US-005 `NorthboundHolding` |
| `backend/src/data/sources/<Source>Client.ts` | spawn Python helper 的 TS 包装 + 类型 | US-005 `NorthboundDataClient` |
| `backend/src/data/services/<Source>SyncService.ts` | DB 写入 + `syncDate(date)` / `syncRange(start, end)` + checkpoint | US-005 `NorthboundSyncService` |
| `backend/src/scripts/sync-<source>.ts` | commander CLI + `--date / --start / --end / --force` | US-005 `sync-northbound.ts` |
| `backend/package.json` | 加 `sync:<source>` npm script | – |

### 2.2 完整代码模板：复制即可

> 以下示例假设你新增 "AKShare 行业 PE 中位数" 数据源（虚构），按 5 文件顺序贴出。

**(1) `backend/python/akshare_helper.py`**：新增函数 + dispatcher case

```python
def get_industry_pe_median(date: str) -> List[Dict[str, Any]]:
    """
    Fetch industry PE-TTM medians for a trade date.

    AKShare endpoint: stock_industry_pe_em (虚构示例)

    Args:
        date: trade date as YYYY-MM-DD or YYYYMMDD.

    Returns:
        [{trade_date, industry_code, industry_name, pe_median, sample_count, raw_payload}, ...]
    """
    # 接受两种日期格式（YYYY-MM-DD / YYYYMMDD）—— akshare 不同 endpoint 偏好不同
    iso_date = _format_iso_date(date)
    akshare_date = iso_date.replace('-', '')

    try:
        df = ak.stock_industry_pe_em(date=akshare_date)
    except Exception as exc:
        print(f"AKShare get_industry_pe_median({date}) failed: {exc}", file=sys.stderr)
        return []  # 返回空列表而非 raise，让 TS 层 checkpoint "tried but empty"

    if df is None or df.empty:
        return []

    # 柔性 col_map：akshare 列名跨版本会变，按可能的 alias 兜底
    col_map = {
        'industry_code':  _first_existing(df, ['行业代码', '板块代码', 'symbol']),
        'industry_name':  _first_existing(df, ['行业名称', '板块名称', 'name']),
        'pe_median':      _first_existing(df, ['市盈率-中位数', 'pe_median', 'pe']),
        'sample_count':   _first_existing(df, ['样本数', '股票数', 'count']),
    }

    out: List[Dict[str, Any]] = []
    for _, row in df.iterrows():
        out.append({
            'trade_date':     iso_date,
            'industry_code':  _cell_str(row.get(col_map['industry_code'])),
            'industry_name':  _cell_str(row.get(col_map['industry_name'])),
            'pe_median':      _cell_float(row.get(col_map['pe_median'])),
            'sample_count':   _cell_int(row.get(col_map['sample_count'])),
            'raw_payload':    _row_to_jsonable(row),  # 保留原始行供审计
        })
    return out


# 在 main() 末尾的 if-elif 链增加：
# elif command == 'get_industry_pe_median':
#     data = get_industry_pe_median(args[0])
#     print(json.dumps(data, ensure_ascii=False, default=str))
```

**(2) `backend/src/models/IndustryPeMedian.ts`**

```typescript
import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 行业 PE-TTM 中位数（每日快照）
 *
 * 主键 (trade_date, industry_code)，单只行业每日只有一条快照。
 * 数据源：AKShare stock_industry_pe_em
 */
@Table({
  tableName: 'industry_pe_medians',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['industry_code'] },
  ],
})
export class IndustryPeMedian extends Model {
  @Column({ type: DataType.DATEONLY, allowNull: false, primaryKey: true, field: 'trade_date' })
  trade_date!: string;

  @Column({ type: DataType.STRING(20), allowNull: false, primaryKey: true, field: 'industry_code' })
  industry_code!: string;

  @Column({ type: DataType.STRING(64), allowNull: true, field: 'industry_name' })
  industry_name!: string | null;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'pe_median' })
  pe_median!: string | null;  // Sequelize raw 取 DECIMAL 是 string，调用方需 Number() 转换

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'sample_count' })
  sample_count!: number | null;

  @Column({ type: DataType.JSONB, allowNull: true, field: 'raw_payload' })
  raw_payload!: Record<string, unknown> | null;

  @CreatedAt
  created_at!: Date;

  @UpdatedAt
  updated_at!: Date;
}
```

> **2 处必须同步注册**：
> - `backend/src/models/index.ts` 加 `export * from './IndustryPeMedian';`
> - `backend/src/config/database.ts` 在 `sequelize.addModels([...])` 数组里追加 `IndustryPeMedian`，否则 Sequelize 不知道这张表。

**(3) `backend/src/data/sources/IndustryPeMedianClient.ts`**

```typescript
import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

export interface IndustryPeMedianRow {
  trade_date: string;
  industry_code: string;
  industry_name: string | null;
  pe_median: number | null;
  sample_count: number | null;
  raw_payload: Record<string, unknown>;
}

export class IndustryPeMedianClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
  }

  async fetchMedians(date: string): Promise<IndustryPeMedianRow[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonPath, [this.scriptPath, 'get_industry_pe_median', date]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => (stdout += d.toString()));
      child.stderr.on('data', d => (stderr += d.toString()));
      child.on('exit', code => {
        if (code !== 0) {
          logger.error(`IndustryPeMedianClient: python exited ${code}, stderr=${stderr}`);
          return reject(new Error(`AKShare helper failed: ${stderr}`));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e}\n${stdout.slice(0, 500)}`));
        }
      });
    });
  }
}

export const industryPeMedianClient = new IndustryPeMedianClient();
```

**(4) `backend/src/data/services/IndustryPeMedianSyncService.ts`**

```typescript
import { IndustryPeMedian } from '../../models/IndustryPeMedian';
import { logger } from '../../utils/logger';
import { IndustryPeMedianClient, industryPeMedianClient } from '../sources/IndustryPeMedianClient';

export interface SyncDateResult {
  trade_date: string;
  fetched: number;
  upserted: number;
  skipped: boolean;
  error?: string;
}

export class IndustryPeMedianSyncService {
  constructor(private client: IndustryPeMedianClient = industryPeMedianClient) {}

  /** 同步单日（幂等：composite PK + updateOnDuplicate） */
  async syncDate(date: string, options: { force?: boolean } = {}): Promise<SyncDateResult> {
    try {
      // 默认断点续传：当日已存在任意行就跳过
      if (!options.force) {
        const existing = await IndustryPeMedian.count({ where: { trade_date: date } });
        if (existing > 0) {
          logger.info(`IndustryPeMedian: ${date} already has ${existing} rows, skipping (use --force to overwrite)`);
          return { trade_date: date, fetched: 0, upserted: 0, skipped: true };
        }
      }

      const rows = await this.client.fetchMedians(date);
      if (rows.length === 0) {
        return { trade_date: date, fetched: 0, upserted: 0, skipped: false };
      }

      const records = rows.map(r => ({
        trade_date: r.trade_date,
        industry_code: r.industry_code,
        industry_name: r.industry_name,
        pe_median: r.pe_median,
        sample_count: r.sample_count,
        raw_payload: r.raw_payload,
      }));

      await IndustryPeMedian.bulkCreate(records as any, {
        updateOnDuplicate: ['industry_name', 'pe_median', 'sample_count', 'raw_payload', 'updated_at'],
      });

      return { trade_date: date, fetched: rows.length, upserted: rows.length, skipped: false };
    } catch (e: any) {
      logger.error(`IndustryPeMedian syncDate(${date}) failed: ${e.message}`);
      return { trade_date: date, fetched: 0, upserted: 0, skipped: false, error: e.message };
    }
  }

  /** 范围同步（按日遍历，单日错误不阻塞后续） */
  async syncRange(start: string, end: string, options: { force?: boolean } = {}) {
    const details: SyncDateResult[] = [];
    let cursor = start;
    while (cursor <= end) {
      details.push(await this.syncDate(cursor, options));
      cursor = isoDateAddDays(cursor, 1);
    }
    return { start, end, details };
  }
}

function isoDateAddDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
```

**(5) `backend/src/scripts/sync-industry-pe-median.ts`**

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { IndustryPeMedianSyncService } from '../data/services/IndustryPeMedianSyncService';

const program = new Command();
program
  .name('sync-industry-pe-median')
  .description('行业 PE-TTM 中位数日度同步 (AKShare stock_industry_pe_em)')
  .option('--date <date>', '单日 (YYYY-MM-DD)')
  .option('--start <start>', '范围起点 (YYYY-MM-DD)')
  .option('--end <end>', '范围终点 (YYYY-MM-DD)')
  .option('--force', '覆盖已存在数据', false)
  .parse(process.argv);

const opts = program.opts();

(async () => {
  try {
    await sequelize.authenticate();
    const svc = new IndustryPeMedianSyncService();

    if (opts.date) {
      const r = await svc.syncDate(opts.date, { force: opts.force });
      logger.info(`Done: ${JSON.stringify(r)}`);
    } else if (opts.start && opts.end) {
      const r = await svc.syncRange(opts.start, opts.end, { force: opts.force });
      const ok = r.details.filter(d => !d.error).length;
      const fail = r.details.length - ok;
      logger.info(`Range done: ${ok} ok, ${fail} failed`);
    } else {
      program.help();
    }
    process.exit(0);
  } catch (e: any) {
    logger.error(`Fatal: ${e.message}`);
    process.exit(1);
  }
})();
```

**(6) `backend/package.json`** 追加：

```json
{
  "scripts": {
    "sync:industry-pe-median": "ts-node --transpile-only src/scripts/sync-industry-pe-median.ts"
  }
}
```

### 2.3 5 个高频踩坑

1. **`Number(null) === 0` 大坑**：Sequelize `raw:true` + DECIMAL nullable 字段取出是 `string` 或 `null`，**先 null/undefined 检查再 Number 转换**（US-088 教训）。
2. **AKShare 日期格式不一致**：`stock_industry_pe_em` 接受 `YYYYMMDD`，`stock_hsgt_hold_stock_em` 接受 `YYYY-MM-DD` —— Python helper 内统一 `_format_iso_date` 转换（US-005 helper 微函数）。
3. **柔性 col_map**：AKShare 跨版本会改列名，必须 `_first_existing(df, [候选 1, 候选 2])` 兜底，否则升级一次 akshare 库就全炸（US-005 教训）。
4. **空数据 return `[]` 而非 raise**：让 TS 层能正确 checkpoint "尝试过但空" 的天（节假日 / 早期无数据），不要让网络偶尔失败和"数据本来就空"混在一起（US-005）。
5. **业务标签 / 历史推算放 TS 不放 Python**：`is_famous_yz` 白名单 / `continuous_days` 连板天数 / `is_new` baseline 比较 这些"规则可能演化"的字段都在 TS 服务层；Python 只是 dumb fetcher（US-006 / US-007 教训）。

### 2.4 如果要暴露成业务 query endpoint

参考 US-092 ETF Flow 模式 `backend/src/api/controllers/DataController.ts` —— 把 sync service 的查询方法包成 controller `GET /api/data/industry-pe-median?date=...`，注意：

- 静态 GET 路由必须**早于** `:source` POST catchall 注册（US-015 / US-088 / US-092 同款教训）。
- normalize 失败（如 industry 不在白名单）返回 `count: 0` 而非 4xx，与前端拉空数据时的渲染保持一致。

---

## 3. 添加新因子

> **目标**：写一个 `Factor` 对象 → 注册到全局 `factorRegistry` → FactorPipeline 调度时自动横截面 zscore 化 → 写入 `factor_scores` 表 → 被 MultiFactorAlphaStrategy / FactorWorkspace 自动消费。
>
> **设计契约（来自 `backend/src/quant/factors/CLAUDE.md` + US-009/010 累积）**：
> 1. 因子输出**未归一化** raw_value Map<stock_code, number|null>。FactorPipeline 做 winsorize → zscore → percentile，因子自己绝不做 zscore（破坏跨因子可比性）。
> 2. 缺数据的股票**不要写 0 也不要写 NaN**，直接不放进 Map（Pipeline 补 raw_value=null + z_score=0 + percentile=0.5 的中性行）。
> 3. `stock_code` **无市场后缀**（"600519"），与 NorthboundHolding / LimitUpStock 等表 key 一致；如果你的因子读 DailyBar / Stock（这俩是 "600519.SH" 形式），用 `_helpers.stripSuffix()`。
> 4. 时序窗口因子必须 **lookahead bias guard**：`if (row_date > as_of_date) continue;`（US-030 教训）。
> 5. 因子 compute() 只读不写；写库统一交给 FactorPipeline。

### 3.1 完整代码模板：复制即可

> 以下示例新增"换手率累计因子" — `turnover_accum`：raw_value = 近 20 自然日累计换手率（量化资金活跃度）。

**`backend/src/quant/factors/library/TurnoverAccumFactor.ts`**

```typescript
/**
 * TurnoverAccumFactor — 累计换手率因子（虚构示例，仿 US-029 LiquidityFactor）
 *
 * 公式：raw_value = Σ DailyBar.turnover_rate[as_of - 20 自然日 .. as_of]
 *   - 累计换手率越高 → 资金面越活跃（散户 / 游资关注度高）
 *   - 与单日换手率比，累计能滤掉单日异动噪音
 *
 * 数据源：DailyBar 表（per-stock 时序）
 *   - DailyBar.symbol 是 "600519.SH" 形式，必须 stripSuffix() 转换
 *
 * 失效：
 *   - 整个窗口内 < MIN_OBS 个有效观测 → 不入 Map
 *   - turnover_rate 为 null / NaN → 跳过该日（不当 0 累加）
 *
 * lookahead bias guard：DailyBar.time > as_of_date 的行不计入（防 DB
 * 装新数据后回放历史时窗口被未来污染，US-030 教训）。
 */

import { Op } from 'sequelize';
import { Factor } from '../types';
import { factorRegistry } from '../FactorRegistry';
import { DailyBar } from '../../../models/DailyBar';
import { isFiniteNumber, lookbackStartDate, loadStocksByCodes, stripSuffix } from './_helpers';

export const WINDOW_DAYS = 20;
export const MIN_OBS = 5;  // 5 个有效交易日才计入；不足视为新股 / 长期停牌

/** 纯函数：从有效 turnover_rate 数组求和。导出供单测覆盖。 */
export function sumTurnover(values: number[]): number {
  let sum = 0;
  for (const v of values) {
    if (isFiniteNumber(v)) sum += v;
  }
  return sum;
}

/** 纯函数：过滤一只股票的窗口 bars → 有效 turnover_rate 数组。导出供单测。 */
export function extractValidTurnovers(
  bars: Array<{ time: Date | string; turnover_rate: any }>,
  asOfDate: string
): number[] {
  const asOf = new Date(asOfDate + 'T23:59:59Z');
  const out: number[] = [];
  for (const b of bars) {
    const t = typeof b.time === 'string' ? new Date(b.time) : b.time;
    if (t > asOf) continue;  // lookahead guard
    const tr = Number(b.turnover_rate);
    if (!isFiniteNumber(tr)) continue;
    out.push(tr);
  }
  return out;
}

export const turnoverAccumFactor: Factor = {
  name: 'turnover_accum',
  description: '近 20 自然日累计换手率（资金活跃度）',
  category: 'flow',

  async compute(ctx) {
    const out = new Map<string, number | null>();
    if (!ctx.universe.length) return out;

    // 1) universe (无后缀) → Stock (带后缀 / 含 id)
    const stockMap = await loadStocksByCodes(ctx.universe, ['id', 'symbol']);
    if (stockMap.size === 0) return out;

    const stockIds = Array.from(stockMap.values()).map(s => s.id);
    const stockIdToCode = new Map<number, string>();
    for (const [code, s] of stockMap) stockIdToCode.set(s.id, code);

    // 2) 拉窗口内全部 DailyBar
    const startDate = lookbackStartDate(ctx.as_of_date, WINDOW_DAYS + 5);  // +5 兜底节假日
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'turnover_rate'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: { [Op.gte]: startDate + 'T00:00:00Z', [Op.lte]: ctx.as_of_date + 'T23:59:59Z' },
      },
      raw: true,
    })) as unknown as Array<{ stock_id: number; time: Date | string; turnover_rate: any }>;

    // 3) 按 stock_id 分组
    const bySid = new Map<number, Array<{ time: Date | string; turnover_rate: any }>>();
    for (const b of bars) {
      const arr = bySid.get(b.stock_id) ?? [];
      arr.push(b);
      bySid.set(b.stock_id, arr);
    }

    // 4) 逐股票求 sum
    for (const [sid, group] of bySid) {
      const code = stockIdToCode.get(sid);
      if (!code) continue;
      const valid = extractValidTurnovers(group, ctx.as_of_date);
      if (valid.length < MIN_OBS) continue;  // 数据太稀，不入 Map → Pipeline 补中性
      out.set(code, sumTurnover(valid));
    }

    return out;
  },
};

factorRegistry.register(turnoverAccumFactor);
```

### 3.2 让全局 import-time 拉到这个因子

修改 `backend/src/quant/factors/library/index.ts`，按字母序追加一行：

```typescript
// ... existing imports ...
import './ShareholderConcentrationFactor';
import './TurnoverAccumFactor';   // ← 新增
import './ValueFactor';
```

> 不要在 `library/index.ts` 里 `export` 因子对象 —— 调用方走 `factorRegistry.get('turnover_accum')` 拿，避免双重事实源（US-010 约定）。

### 3.3 跑因子计算 + 验证写入

```bash
cd backend

# 1) 单日全因子跑一遍（会把 turnover_accum 一起算）
npm run compute:factors -- --date=2026-06-08

# 2) 只跑新因子，方便看输出
npx ts-node --transpile-only -e "
  import('./src/quant/factors/library').then(async () => {
    const { FactorPipeline } = await import('./src/quant/factors/FactorPipeline');
    const stats = await new FactorPipeline().runForDate('2026-06-08', ['turnover_accum']);
    console.log(JSON.stringify(stats, null, 2));
  });
"

# 3) 验证 factor_scores 表
psql -h localhost -U postgres -d stocks -c \
  "SELECT factor_name, COUNT(*), AVG(z_score), STDDEV(z_score) FROM factor_scores
   WHERE factor_name = 'turnover_accum' AND factor_date = '2026-06-08' GROUP BY factor_name;"
# 期望 count ≈ universe size，AVG(z_score) ≈ 0，STDDEV(z_score) ≈ 1
```

### 3.4 让 MultiFactorAlphaStrategy / 前端 FactorWorkspace 自动用上

`MultiFactorAlphaStrategy` 默认按 `factorRegistry.listNames()` 拿全部因子 + 默认等权（US-011），新因子注册即被纳入。如果要给它显式权重，改 `backend/src/quant/strategies/MultiFactorAlphaStrategy.ts` 的 `DEFAULT_FACTOR_WEIGHTS`。

前端 `FactorWorkspace.tsx` 用 `factorService.listFactorsOverview()` 拿全部因子（包括分数 / IC / 相关性 / 详情 drawer），新因子注册即列表自动出现，无需前端改动。

### 3.5 6 个高频踩坑

1. **不要在 compute() 内做 zscore / 标准化**：会破坏跨因子可比性。例外：**横截面参照量**型因子（U 形评分 / 距均值偏离）的 *单点参照变换* 不算（US-029 LiquidityFactor）。
2. **`stock_code` 一定无后缀**：从 DailyBar / Stock 这种 "600519.SH" 表读出后立刻 `stripSuffix()`，与 universe 对齐。
3. **lookahead bias guard 必加**：所有时序窗口因子在 compute() 内显式 `if (row.time > as_of_date) continue;`，单测必须构造一条 "future" 行验证（US-030）。
4. **Number(null) === 0**：DECIMAL nullable 字段读出来必须 `if (x === null || x === undefined) return null;` 再 Number()（US-031 教训）。
5. **稀疏 Map 优于稠密 0 填充**：未触发 / 缺数据的股票不要写 0，会让 z-score 变成 "0 vs 正" 双峰分布破坏标准化（US-010 教训）。
6. **MIN_OBSERVATIONS 按数据频率调**：日级因子 10+；月级 5+；季度披露（FinancialReport / ShareholderCount）= 2；年报 = 2-3（US-035 教训），盲套日级阈值会让低频因子永远空 Map。

### 3.6 因子代理范式（AC 字段不可得时）

如果你的 AC 公式所需字段在当前数据模型不可得（NOPAT / FCF / 投入资本等），按 US-031 引入的 5 步处理：
1. 代理必须有学术或实证依据（ROE↔ROIC 0.85+ 相关性），不要瞎编；
2. `factor.name` 保留 AC 命名（不要悄悄改成 `_proxy` / `_v0` 污染 registry）；
3. `description` 字段显式包含 "代理" 字样；
4. jsdoc 顶部写清四件事：(a) AC 原始公式 (b) 不可得字段 (c) 选定代理 + 系数 (d) 升级路径；
5. TS factor + `backend/src/quant/factors/CLAUDE.md` 同时更新。

参考实现：`backend/src/quant/factors/library/QualityHighFactor.ts`（用 ROE 代理 ROIC）。

---

## 4. 添加新策略

> 项目里**两种策略形态共存**（见 `backend/src/quant/strategies/CLAUDE.md`）：
> - **Per-stock `evaluate(context)`**（17 个历史策略）—— 一只股票一次打分，被 StrategyEngine 按 股票×策略 矩阵循环调用；
> - **组合级 `generateSignals(date)`**（12+ 新策略，US-011 引入）—— 全市场横截面 + top-N + 行业中性，per-stock 表达不出的就用这个。
>
> **判定**：你的策略需不需要"先看全市场所有股票互相比较 / 选 top N / 行业中性"？需要 → 组合级；不需要（每只股票按它自己历史/快照判断）→ per-stock。

### 4.1 完整代码模板：per-stock 形态（简单）

> 示例：`RsiOverboughtStrategy` —— RSI(14) > 80 → SELL，< 20 → BUY，否则 HOLD。

**`backend/src/quant/strategies/RsiOverboughtStrategy.ts`**

```typescript
import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { calculateRSI } from '../engine/QuantMath';

export interface RsiOverboughtParams {
  period: number;          // RSI 周期，默认 14
  overbought: number;      // 超买阈值，默认 80
  oversold: number;        // 超卖阈值，默认 20
}

export const DEFAULT_RSI_OVERBOUGHT_PARAMS: Readonly<Required<RsiOverboughtParams>> = Object.freeze({
  period: 14,
  overbought: 80,
  oversold: 20,
});

/**
 * RsiOverboughtStrategy — RSI 超买超卖反转（虚构示例）
 *
 * 入场：RSI(14) < 20 → BUY
 * 出场：RSI(14) > 80 → SELL
 * 其他：HOLD
 *
 * 数据源：context.bars 内联（StrategyEngine 已喂好最近 N 根 K 线）
 */
export class RsiOverboughtStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    key: 'rsi_overbought',
    name: 'RSI 超买超卖反转',
    description: 'RSI(14) < 20 BUY；> 80 SELL；否则 HOLD',
    category: 'mean_reversion',
    universe: 'market',
    defaultParams: DEFAULT_RSI_OVERBOUGHT_PARAMS as RsiOverboughtParams,
  };

  evaluate(
    context: QuantStockContext,
    options?: QuantStrategyRuntimeOptions
  ): QuantSignalResult {
    const params: RsiOverboughtParams = {
      ...DEFAULT_RSI_OVERBOUGHT_PARAMS,
      ...(options?.params ?? {}),
    };

    const closes = context.bars.map(b => b.close);
    if (closes.length < params.period + 1) {
      return { action: 'hold', reason: `数据不足: 仅 ${closes.length} bar，需 ${params.period + 1}` };
    }

    const rsi = calculateRSI(closes, params.period);
    const latest = rsi[rsi.length - 1];
    if (!Number.isFinite(latest)) {
      return { action: 'hold', reason: `RSI 计算无效 (latest=${latest})` };
    }

    if (latest < params.oversold) {
      return {
        action: 'buy',
        score: (params.oversold - latest) / params.oversold,  // 越超卖分越高
        reason: `RSI(${params.period})=${latest.toFixed(1)} < ${params.oversold} (超卖)`,
        metadata: { rsi: latest },
      };
    }
    if (latest > params.overbought) {
      return {
        action: 'sell',
        score: (latest - params.overbought) / (100 - params.overbought),
        reason: `RSI(${params.period})=${latest.toFixed(1)} > ${params.overbought} (超买)`,
        metadata: { rsi: latest },
      };
    }
    return { action: 'hold', reason: `RSI(${params.period})=${latest.toFixed(1)} 中性区间`, metadata: { rsi: latest } };
  }
}
```

**注册到 `backend/src/quant/engine/StrategyRegistry.ts`**：

```typescript
import { RsiOverboughtStrategy } from '../strategies/RsiOverboughtStrategy';

// 在 constructor 内追加：
this.register(new RsiOverboughtStrategy());
```

### 4.2 完整代码模板：组合级形态（推荐于全市场扫描场景）

> 示例：`TopMomentumStrategy` —— 每月第 1 个交易日选 60 日动量 top 20，行业中性。

**`backend/src/quant/strategies/TopMomentumStrategy.ts`**

```typescript
import { Op } from 'sequelize';
import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
} from '../types/QuantTypes';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';

export interface TopMomentumParams {
  lookbackDays: number;       // 默认 60
  topN: number;               // 默认 20
  maxPerIndustry: number;     // 默认 3（行业中性）
  excludeST: boolean;         // 默认 true
}

export const DEFAULT_TOP_MOMENTUM_PARAMS: Readonly<Required<TopMomentumParams>> = Object.freeze({
  lookbackDays: 60,
  topN: 20,
  maxPerIndustry: 3,
  excludeST: true,
});

/**
 * TopMomentumStrategy — 60 日动量 top 20 月度调仓（虚构示例，仿 MultiFactorAlphaStrategy）
 *
 * 入场 = 月初首个交易日选 close[T] / close[T-60] 排名 top 20 + 每行业最多 3 只 + 排除 ST
 * 出场 = 不在新月度 target 但在 previousSelection → SELL
 * 持有 = target ∩ previousSelection → HOLD
 *
 * 数据访问通过 DataSource 接口注入（US-011 约定 A），方便单测脱 DB。
 */

export interface TopMomentumDataSource {
  loadTradeCalendar(start: string, end: string): Promise<string[]>;
  loadCloseSnapshot(date: string): Promise<Map<string, { close: number; industry: string; name: string }>>;
  loadClosePast(date: string, lookbackDays: number): Promise<Map<string, number>>;
}

export class DefaultTopMomentumDataSource implements TopMomentumDataSource {
  async loadTradeCalendar(start: string, end: string): Promise<string[]> {
    const rows = (await DailyBar.findAll({
      attributes: [[DailyBar.sequelize!.fn('DATE', DailyBar.sequelize!.col('time')), 'd']],
      where: { time: { [Op.between]: [start, end] } },
      group: ['d'],
      raw: true,
    })) as any[];
    return rows.map(r => r.d as string).sort();
  }

  async loadCloseSnapshot(date: string) {
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'close'],
      where: DailyBar.sequelize!.where(DailyBar.sequelize!.fn('DATE', DailyBar.sequelize!.col('time')), date),
      include: [{ model: Stock, attributes: ['symbol', 'name', 'industry'] }],
      raw: true,
      nest: true,
    })) as any[];
    const out = new Map<string, { close: number; industry: string; name: string }>();
    for (const b of bars) {
      const code = b.Stock.symbol.split('.')[0];
      out.set(code, { close: Number(b.close), industry: b.Stock.industry ?? '其他', name: b.Stock.name });
    }
    return out;
  }

  async loadClosePast(date: string, lookbackDays: number) {
    const target = new Date(date);
    target.setDate(target.getDate() - lookbackDays);
    const targetIso = target.toISOString().slice(0, 10);
    return this.loadCloseSnapshot(targetIso).then(m => new Map(Array.from(m, ([k, v]) => [k, v.close])));
  }
}

export const PRODUCTION_DATA_SOURCE: TopMomentumDataSource = new DefaultTopMomentumDataSource();

export interface TopMomentumSignals {
  date: string;
  target_portfolio: string[];   // top N codes
  signals: Array<{ stock_code: string; action: 'buy' | 'sell' | 'hold'; reason: string }>;
  filtered: Array<{ stock_code: string; reason: string }>;
  params: TopMomentumParams;
}

export class TopMomentumStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    key: 'top_momentum',
    name: 'Top 60 日动量月度轮动',
    description: '60 日动量 top 20 + 行业中性 + 月度调仓',
    category: 'momentum',
    universe: 'market',
    defaultParams: DEFAULT_TOP_MOMENTUM_PARAMS as TopMomentumParams,
  };

  constructor(private dataSource: TopMomentumDataSource = PRODUCTION_DATA_SOURCE) {
    super();
  }

  /** per-stock evaluate 退化为信息性 hold（组合级策略真正入口是 generateSignals） */
  evaluate(_context: QuantStockContext): QuantSignalResult {
    return { action: 'hold', reason: 'top_momentum 走组合级 generateSignals(date)' };
  }

  /** 组合级入口：调用方传 date + previousSelection */
  async generateSignals(
    date: string,
    options: { params?: Partial<TopMomentumParams>; previousSelection?: string[] } = {}
  ): Promise<TopMomentumSignals> {
    const params: TopMomentumParams = { ...DEFAULT_TOP_MOMENTUM_PARAMS, ...(options.params ?? {}) };
    const previous = new Set(options.previousSelection ?? []);

    // 1) 是否月初调仓日
    const month = date.slice(0, 7);
    const monthStart = `${month}-01`;
    const monthEnd = `${month}-31`;
    const tradeDays = await this.dataSource.loadTradeCalendar(monthStart, monthEnd);
    const firstDay = tradeDays[0];
    if (date !== firstDay) {
      // 非调仓日：全部 previous → HOLD
      return {
        date,
        target_portfolio: Array.from(previous),
        signals: Array.from(previous).map(c => ({ stock_code: c, action: 'hold' as const, reason: '非月初调仓日' })),
        filtered: [],
        params,
      };
    }

    // 2) 横截面计算 60 日动量
    const snapshotNow = await this.dataSource.loadCloseSnapshot(date);
    const snapshotPast = await this.dataSource.loadClosePast(date, params.lookbackDays);
    const filtered: Array<{ stock_code: string; reason: string }> = [];
    const candidates: Array<{ code: string; momentum: number; industry: string; name: string }> = [];

    for (const [code, now] of snapshotNow) {
      if (params.excludeST && (now.name.includes('ST') || now.name.includes('*ST'))) {
        filtered.push({ stock_code: code, reason: 'ST 排除' });
        continue;
      }
      const past = snapshotPast.get(code);
      if (!Number.isFinite(past) || !past || past <= 0) {
        filtered.push({ stock_code: code, reason: `${params.lookbackDays} 日前价格缺失` });
        continue;
      }
      candidates.push({
        code,
        momentum: now.close / past - 1,
        industry: now.industry,
        name: now.name,
      });
    }

    // 3) 排序 + 行业中性 + top N
    candidates.sort((a, b) => b.momentum - a.momentum || a.code.localeCompare(b.code));
    const perIndustry = new Map<string, number>();
    const target: string[] = [];
    for (const c of candidates) {
      if (target.length >= params.topN) break;
      const cnt = perIndustry.get(c.industry) ?? 0;
      if (cnt >= params.maxPerIndustry) continue;
      target.push(c.code);
      perIndustry.set(c.industry, cnt + 1);
    }

    // 4) 与 previous 做 diff 生成 BUY / SELL / HOLD（US-011 约定 B）
    const targetSet = new Set(target);
    const signals: TopMomentumSignals['signals'] = [];
    for (const code of target) {
      signals.push({
        stock_code: code,
        action: previous.has(code) ? 'hold' : 'buy',
        reason: previous.has(code) ? '继续持有 (target ∩ previous)' : '新入 top 20 (BUY)',
      });
    }
    for (const code of previous) {
      if (!targetSet.has(code)) signals.push({ stock_code: code, action: 'sell', reason: '退出 top 20 (SELL)' });
    }

    return { date, target_portfolio: target, signals, filtered, params };
  }
}
```

**注册同 §4.1**：在 `backend/src/quant/engine/StrategyRegistry.ts` 构造器追加 `this.register(new TopMomentumStrategy());`

### 4.3 5 个组合级策略必守约定（来自 `backend/src/quant/strategies/CLAUDE.md`）

A. **数据访问通过可注入 DataSource 接口**：`<StrategyName>DataSource` interface + `Default<StrategyName>DataSource` 生产实现 + `PRODUCTION_DATA_SOURCE` 单例 + 构造器注入。`MultiFactorAlphaStrategy.ts` 是参考实现。

B. **`generateSignals(date)` 必须返回 BUY/SELL/HOLD 增量**：不要只返回 target_portfolio 让 caller 自己 diff，N 个调用方会写出 N 份不一致的 diff（PaperTradingFacade 之前踩过的坑）。

C. **previousSelection 的形态视策略需要扩展**：MultiFactorAlpha 只需要 `string[]`（哪只在哪只不在）；DragonHead 需要 `Map<code, { entryDate, ladderHeight }>`（带 ladder 高度做出场判断）。

D. **调仓 gate 在策略内判定**：非调仓日返回 previous → HOLD（不动持仓 + 不重算）。判定函数应该 export 让单测覆盖。例：`isRebalanceDate(asOf, period, dataSource)`。

E. **filtered 数组带 reason**：每一只被排除的股票 + 一行人类可读 reason。前端 LabWorkspace 详情会展示，方便策略调试。

### 4.4 让策略接入回测 / live trading

- **回测**：通过 `LabWorkspace` 创建任务（前端 → `POST /api/quant/backtest`）；后端 `BacktestEngine` 会自动识别策略形态（看是否实现 `generateSignals`）走对应路径。
- **Live trading**：策略注册到 StrategyRegistry 后，`SchedulerService` 的"每日盘后跑全策略"job 会自动调用；信号写入 QuantSignal 表 + PaperTradingFacade.applyAutomation 落地下单。
- **干运行**：策略支持 `dryRun: true` 字段（US-083）—— 仅写信号不下单。在 `SettingsWorkspace` 配置或通过 PRD 提交时设默认值。

### 4.5 6 个高频踩坑

1. **不要在组合级策略里走 per-stock 矩阵 evaluate**：StrategyEngine 不会调你的 `generateSignals`，你需要把它注册到组合级调度器（`SchedulerService.runCompositeStrategy(date)`）。
2. **diff 算法用 `Set` 不要双 for 循环**：previous = 5000 持仓 × target = 5000 候选 → 25M 次 includes 拖死生产；用 `new Set(...)` + `.has(c)` O(1)。
3. **行业中性不能在 sort 后再过滤**：要在 sort + 入选时 inline 限制 `if (perIndustry.get(c.industry) >= maxPerIndustry) continue;`，否则只在 top N 之内做 cap 等于没做。
4. **stable tie-break 必须 by stock_code**：单纯按 score 排序，相同 score 时的顺序不稳定 → 回测复跑结果不一致 → 没法验证 bug 是否修复。一律 `(a, b) => b.score - a.score || a.code.localeCompare(b.code)`。
5. **windowDays / topN / period 参数必须 `Number.isInteger` guard**：单用 `isFinite` 接受 `3.5` 会让 idx 计算静默取整产生错误 base（US-033 教训）。
6. **per-stock 策略的 evaluate() 严格 sync**：基类抽象方法签名是 sync，不要 `async evaluate()` —— TypeScript 会报错但 ts-node `--transpile-only` 模式可能放过，跑起来后 StrategyEngine 拿到 Promise 当成 result 写库 → 全表 `action: '[object Promise]'`。需要异步走组合级形态。

---

## 5. 编写测试

> 本项目**不依赖 jest**（避免 babel-jest 对 ts-node + sequelize-typescript 装饰器的复杂集成）。所有测试用同一约定：**IIFE 写 assert + 末尾 `process.exit(failed > 0 ? 1 : 0)`**。run-tests.ts spawn 子进程跑，收集 exit code。

### 5.1 完整代码模板：复制即可

> 示例：测试 §3 的 `TurnoverAccumFactor` 的纯函数 + factor metadata + 空 universe 路径。

**`backend/tests/factors/TurnoverAccumFactor.test.ts`**

```typescript
/**
 * TurnoverAccumFactor 单元测试.
 *
 * 跑：cd backend && npx ts-node --transpile-only tests/factors/TurnoverAccumFactor.test.ts
 *
 * 覆盖：
 *   - 纯函数 sumTurnover (空 / 全 finite / 含 NaN / 含 Infinity)
 *   - 纯函数 extractValidTurnovers (lookahead guard / 缺数据跳过 / 边界日期)
 *   - Factor metadata (name / category / description / 已注册)
 *   - 空 universe 不爆 → 返回空 Map
 */

import {
  turnoverAccumFactor,
  sumTurnover,
  extractValidTurnovers,
  WINDOW_DAYS,
  MIN_OBS,
} from '../../src/quant/factors/library/TurnoverAccumFactor';
import { factorRegistry } from '../../src/quant/factors/FactorRegistry';
// 触发 library 自我登记
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import '../../src/quant/factors/library';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

// ---- 纯函数 sumTurnover ----
console.log('\n## sumTurnover');
assert('空数组 → 0', sumTurnover([]) === 0);
assert('单元素 → 它本身', near(sumTurnover([3.14]), 3.14));
assert('多元素 → 求和', near(sumTurnover([1, 2, 3, 4]), 10));
assert('含 NaN → 跳过 NaN', near(sumTurnover([1, NaN, 2]), 3));
assert('含 Infinity → 跳过 Infinity', near(sumTurnover([1, Infinity, 2]), 3));
assert('全 NaN → 0', sumTurnover([NaN, NaN]) === 0);

// ---- 纯函数 extractValidTurnovers ----
console.log('\n## extractValidTurnovers');
const asOf = '2026-06-08';

assert(
  'lookahead guard：T+1 日跳过',
  extractValidTurnovers(
    [
      { time: new Date('2026-06-09T15:00:00Z'), turnover_rate: 5 },  // future
      { time: new Date('2026-06-08T15:00:00Z'), turnover_rate: 3 },
    ],
    asOf
  ).length === 1
);

assert(
  '缺 turnover_rate → 跳过',
  extractValidTurnovers(
    [
      { time: new Date('2026-06-08T15:00:00Z'), turnover_rate: null },
      { time: new Date('2026-06-07T15:00:00Z'), turnover_rate: 2 },
    ],
    asOf
  ).length === 1
);

assert(
  '边界日期：as_of 当日纳入',
  extractValidTurnovers(
    [{ time: new Date('2026-06-08T23:00:00Z'), turnover_rate: 1.5 }],
    asOf
  ).length === 1
);

assert(
  '字符串 time 解析',
  extractValidTurnovers(
    [{ time: '2026-06-08T10:00:00Z', turnover_rate: 2 }],
    asOf
  ).length === 1
);

// ---- Factor metadata ----
console.log('\n## Factor metadata');
assert('name = turnover_accum', turnoverAccumFactor.name === 'turnover_accum');
assert('category = flow', turnoverAccumFactor.category === 'flow');
assert('description 非空', (turnoverAccumFactor.description ?? '').length > 0);
assert('compute 是函数', typeof turnoverAccumFactor.compute === 'function');
assert('factorRegistry 已含 turnover_accum', factorRegistry.listNames().includes('turnover_accum'));
assert('factorRegistry.get 拿回同对象', factorRegistry.get('turnover_accum') === turnoverAccumFactor);

// ---- 空 universe 不爆 ----
console.log('\n## 空 universe 路径');
(async () => {
  const out = await turnoverAccumFactor.compute({
    as_of_date: '2026-06-08',
    universe: [],
    lookbackDays: 30,
  });
  assert('空 universe → 空 Map', out.size === 0);

  // ---- 常量校验 ----
  console.log('\n## 常量');
  assert(`WINDOW_DAYS = 20`, WINDOW_DAYS === 20);
  assert(`MIN_OBS = 5`, MIN_OBS === 5);

  // ---- summary ----
  console.log(`\n  Total: ${passed} ok, ${failed} fail`);
  process.exit(failed > 0 ? 1 : 0);
})();
```

### 5.2 跑测试

```bash
cd backend

# 跑你新写的 test 文件
npx ts-node --transpile-only tests/factors/TurnoverAccumFactor.test.ts

# 跑全部 test（CI 入口）
npm test

# 只跑含某关键词的 test 文件
npm test -- --filter=turnover

# 失败立即退出
npm test -- --bail

# 隐藏 stdout（除失败外）
npm test -- --quiet
```

### 5.3 DataSource 注入测试组合级策略 / 跨表 service

> §4.2 的 `TopMomentumStrategy` 用了 `DataSource` 注入；单测可以这样脱 DB：

```typescript
import { TopMomentumStrategy, TopMomentumDataSource } from '../../src/quant/strategies/TopMomentumStrategy';

class FakeDataSource implements TopMomentumDataSource {
  async loadTradeCalendar(start: string, end: string) {
    return ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'];
  }
  async loadCloseSnapshot(date: string) {
    return new Map([
      ['600519', { close: 1700, industry: '白酒', name: '贵州茅台' }],
      ['000001', { close: 12, industry: '银行', name: '平安银行' }],
    ]);
  }
  async loadClosePast(date: string, lookback: number) {
    return new Map([['600519', 1500], ['000001', 11]]);
  }
}

(async () => {
  const strat = new TopMomentumStrategy(new FakeDataSource());
  const r = await strat.generateSignals('2026-06-01', { previousSelection: [] });
  assert('月初首个交易日 → 触发', r.target_portfolio.length > 0);
  assert('top1 = 茅台（动量 13.3% > 9%）', r.target_portfolio[0] === '600519');
})();
```

### 5.4 测试 5 条最佳实践

1. **测纯函数 + 元数据 + 空入路径，不测 DB 连接**：上面模板 6 块结构是模板。涉及 DB 的部分留给生产场景验证 / 集成测试（infrequent）。
2. **assert 名字直接 → 失败定位**：`assert('lookahead guard：T+1 日跳过', ...)`，而非 `assert('test 1', ...)`。
3. **`near(a, b, eps)` 浮点比较**：JS `0.1 + 0.2 !== 0.3`，所有浮点断言必须容差。模板 `eps = 1e-9` 适用于求和；累乘 / 复利场景调到 `1e-6`。
4. **boundary 各 1 个 case**：lookahead = `time = as_of` 边界 / divisor = 0 / 空数组 / 全 NaN / 单元素 / NaN 与 Infinity 区分；少一个 case 就是少一道 guard。
5. **跨文件 fixture 复用同一个 Map / Array 生成函数 export**，不要让 5 个 test 文件各写 50 行假数据；测试本身不要复制粘贴。

### 5.5 测试覆盖的代码区域指南

| 区域 | 测试粒度 | 推荐覆盖 |
|------|----------|----------|
| Factor (纯计算) | 单元 | 必测：纯函数 / 元数据 / 空入；可选：compute 端到端用 fake DataSource |
| 组合级策略 (generateSignals) | 单元 + fake DS | 必测：调仓日判定 / sort + 行业中性 / diff 算法 / filtered reason |
| Per-stock 策略 (evaluate) | 单元 | 必测：4 维入场 AND / 出场优先级 / 边界 case (数据不足) |
| Sync service | 集成（fake Client） | 必测：幂等 (重复 syncDate 不重复 insert) / force flag / 错误隔离 |
| Controller | 集成（supertest） | 必测：参数校验 / 错误返回 4xx / 成功 envelope unwrap 一致 |

---

## 6. 调试技巧

### 6.1 后端 logger 使用

```typescript
import { logger } from '../utils/logger';
logger.info('Northbound: starting syncDate(2026-06-08)');
logger.warn(`Northbound: skip ${count} stocks with missing hold_ratio`);
logger.error(`syncDate failed: ${e.message}`, { stack: e.stack });
```

日志按 `LOG_LEVEL` env 控制（默认 info）；调试期设 `LOG_LEVEL=debug` 或临时 `logger.debug(...)`。生产 winston 落 `logs/backend.log`，开发模式 stdout。

### 6.2 高频调试场景速查

| 场景 | 怎么做 |
|------|--------|
| **CLI 跑一遍看输出** | `npx ts-node --transpile-only src/scripts/sync-XXX.ts -- --date=2026-06-08` |
| **只跑一个因子看 zscore 是否正常** | 见 §3.3 第 2 段 |
| **只跑一只股票的策略 evaluate** | `node -e "import('./dist/quant/strategies/X').then(...)"`；最快的办法是单测里写一段 |
| **回看 Bull queue 卡住的 job** | `redis-cli` → `LRANGE bull:quant_backtest:wait 0 -1` 看待跑 job |
| **看数据库当前因子分布** | `psql -c "SELECT factor_name, MIN(z_score), MAX(z_score), STDDEV(z_score), COUNT(*) FROM factor_scores WHERE factor_date='2026-06-08' GROUP BY factor_name;"` |
| **看持仓 / 模拟盘状态** | `psql -c "SELECT * FROM paper_trading_positions WHERE portfolio_id=1;"` |
| **AKShare 调试** | `python3 -c "import akshare as ak; df = ak.stock_hsgt_hold_stock_em(date='20260608'); print(df.head())"` |

### 6.3 worktree 环境配置（重要！）

如果你在 `.claude/worktrees/...` 下工作（多 agent 并行场景），`backend/node_modules` 不会被 git 跟踪也不会自动出现。需手动 symlink：

```bash
cd backend
ln -s /Users/<你>/.../stocks/backend/node_modules node_modules
```

> **提交前必须 `rm node_modules`**！否则 git 会把它当成 untracked symlink；虽然 `.gitignore` 匹配目录但 symlink 是 file 类型不匹配。详见 ralph/progress.txt 顶部"Symlinks for tooling in the worktree" 教训。

### 6.4 typecheck / lint 不过怎么办

```bash
cd backend
npx tsc --noEmit              # 看 TS 错误（出错时 stderr 有完整 chain）
npx eslint src --fix          # 自动修可修的（缺分号 / 引号 / import 排序）
npx eslint src/scripts/sync-XXX.ts   # 只看你改的文件
```

常见 TS 报错：
- `TS1382 / TS1003`（JSX）：JSX attribute 内含 ASCII 双引号 → 用 JSX 表达式包裹 `{'...'}` 或全角引号（US-078）。
- `TS2345`（Argument type）：Antd `InputNumber` 同时用 `formatter` + `parser` 必须显式 `<InputNumber<number>>` 泛型（US-016）。
- `TS2741`（missing property）：Sequelize Model 的 `bulkCreate` 入参类型严，常需 `as any` 兜底。

### 6.5 前端 dev tools

- React DevTools 看 component 树 / state；
- Redux DevTools 看 action / state diff（`store/` 用 RTK 自带 devtools middleware）；
- Network tab 看 `{success, data}` envelope；service 层失败的 throw 在 Console 红字（`.then` 链未 catch 时）。
- Recharts 在控制台 warn "duplicate keys" 是 dataKey 命名冲突（多线时序时易踩，见 ralph/progress.txt "recharts vs echarts 分工"）。

### 6.6 性能瓶颈定位

- 后端慢 endpoint：临时加 `console.time('x'); /* code */; console.timeEnd('x');`；
- 因子 pipeline 慢：开 `LOG_LEVEL=debug`，FactorPipeline 会打每因子耗时；
- DB 慢查询：开 `LOG_LEVEL=debug`，Sequelize 会把 SQL 全打出来，复制到 psql `EXPLAIN ANALYZE` 看执行计划；
- 前端首屏慢：Chrome Coverage tab 看哪个 chunk 占大头；Monaco 1.5MB chunk 必须 lazy load（US-093 教训）。

---

## 7. 提交规范

### 7.1 commit message 格式

```
<type>: <scope> - <subject>
```

- `<type>` ∈ `feat | fix | refactor | docs | test | chore | perf | style`
- `<scope>`：US-XXX（user story id）或模块名（如 `ralph`）
- `<subject>`：中文短句，结尾不加句号

仓库历史范例（见 `git log --oneline`）：

```
feat: US-098 - 文档：用户手册（如何在系统里跑出超额收益）
feat: US-097 - 运维：旧数据清理脚本
fix: US-074 - 修复行业热力图日期选择器异常
refactor: US-003 - PaperTradingFacade 收敛到 7 个 method
docs: 更新 backend/src/quant/CLAUDE.md
chore: US-087 - mark PRD passes=true + append progress learnings
```

### 7.2 PR / commit 前 checklist

1. **typecheck 0 error**：`cd backend && npx tsc --noEmit`
2. **lint 0 error**：`cd backend && npx eslint src --ext .ts`（前端 `cd frontend && npm run lint`）
3. **改动文件相关 test 通过**：`npm test -- --filter=<相关关键词>`；若涉及新模块写新 test。
4. **如有 sync / cleanup CLI**：跑一遍 `--help` 输出和 dry-run 模式确认无 crash。
5. **如改 UI**：本地起 frontend 打开对应页面截图（仅在 PR description 内贴，commit message 不要贴图）。
6. **如新增 reusable pattern**：更新最近的 `CLAUDE.md`（见 §1.3）；如是横向 pattern 加到 `ralph/progress.txt` 顶部 Codebase Patterns 区。
7. **不要 commit `backend/node_modules` symlink**（见 §6.3）。
8. **不要 commit `.env` 或任何包含 secret 的文件**（`.gitignore` 已覆盖，但 PR 前再 grep 一次 `git diff` 确认）。

### 7.3 CI 流水线（GitHub Actions）

`.github/workflows/ci.yml` 跑两条 lane（US-069）：

- **Backend**：`npx tsc --noEmit` + `npm run lint` + `npm test`（约 2 分钟）；
- **Security lint**：`security-lint.yml` 扫 secret / SQL injection / 危险 dependency（约 30 秒）。

CI 失败必须本地修后 push 第二轮，**绝不强 push 跳过**。如某个 test 是 flaky 的、与本 commit 无关，在 PR description 标注 + 单独开 issue 跟踪，不要禁用。

### 7.4 PRD / Story 维护（如果你是 Ralph agent 或在 Story 流程里）

- 每个 commit 对应 **1 个 user story**（PRD `userStories[i]`）；
- 完成后把 `passes: false` → `passes: true`，必要时填 `notes`；
- 追加 progress.txt 的标准 entry（见 `ralph/CLAUDE.md` 内的格式），重点写 **Learnings for future iterations**（这是 Ralph agent 的核心反思）；
- 不要混合多 story 到一个 commit；不要在一个 story 内偷偷做无关 refactor（拆开成单独 commit + chore: 类型）。

### 7.5 Co-author 标注（适用 AI agent commit）

如果是 Claude / Codex / Cursor 等 AI agent 生成的 commit，在 commit message 末尾追加：

```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

PR description 末尾加：

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

便于审计 / 追溯哪些代码是 agent 写的。

---

## 附录 A：架构索引

- **6 工作区前端路由** ← `frontend/src/App.tsx`
- **PaperTradingFacade 7 方法** ← `backend/src/portfolio/PaperTradingFacade.ts`
- **5 个 quant facade** ← `backend/src/quant/CLAUDE.md`
- **31+ 策略 + 18 因子注册中心** ← `StrategyRegistry.ts` + `library/index.ts`
- **30 数据源 Client + 22 SyncService** ← `backend/src/data/sources/` + `backend/src/data/services/`
- **科目 CLAUDE.md（必读）** ← `backend/src/quant/CLAUDE.md` / `quant/factors/CLAUDE.md` / `quant/strategies/CLAUDE.md`
- **横向 patterns（90+ 条）** ← `ralph/progress.txt` 顶部 Codebase Patterns
- **环境与部署** ← `docs/DEPLOY_ENVIRONMENTS.md` + `docs/PORT-CONFIGURATION.md`
- **测试约定** ← `docs/TESTING.md` + `backend/src/scripts/run-tests.ts` 文件头注释

---

## 附录 B：常用命令速查

```bash
# === 数据 ===
cd backend && npm run sync:northbound -- --date=2026-06-08
cd backend && npm run sync:northbound -- --start=2026-06-01 --end=2026-06-08
cd backend && npm run compute:factors -- --date=2026-06-08
cd backend && npm run check-env                 # US-068 env 校验

# === 测试 ===
cd backend && npm test                          # 全跑
cd backend && npm test -- --filter=factor       # 按文件名过滤
cd backend && npm test -- --bail                # 首次失败退出
cd backend && npm test -- --quiet               # 隐藏成功日志

# === 类型 / lint ===
cd backend && npx tsc --noEmit                  # typecheck
cd backend && npx eslint src --ext .ts          # lint
cd backend && npx eslint src --fix              # 自动修

# === 启动 ===
docker-compose up -d                            # postgres + redis
cd backend && npm run dev                       # 后端 :3000
cd frontend && PORT=3001 npm start              # 前端 :3001

# === 清理 ===
cd backend && npm run cleanup:old-data          # US-097 dry-run 预览
cd backend && npm run cleanup:old-data -- --confirm  # 真删

# === 健康检查 ===
curl http://localhost:3000/health               # k8s readiness
curl http://localhost:3000/health/detail        # US-096 全依赖看板
```

---

## 反馈与下一步

- **新数据源 / 因子 / 策略**：先按 §2 / §3 / §4 模板写一遍，跑通 `npm test` + CLI 烟雾测，再提 PR；遇到 5 文件清单某文件不知道放哪，对照同模式既有实现（如 US-091 MarginTradingBalance 是最近的多端点合并参考）。
- **不在本指南范围**：UI / 部署 / 性能压测 → 见 `docs/USER_GUIDE.md` / `docs/DEPLOY_ENVIRONMENTS.md` / `docs/QUANT_RESEARCH_IMPLEMENTATION_PLAN.md`。
- **遇到本指南没覆盖的"我现在该怎么写"问题**：第一步 grep `ralph/progress.txt` 顶部 Codebase Patterns 区，第二步看最近一次类似 story 的实现（`git log --grep="数据：" --oneline` 找数据相关 story），第三步问其他开发者；如果是反复出现的痛点，更新本指南 + 提 PR。

> 本指南的所有 §N.X 章节均交叉引用源 story（US-XXX）— 6 个月后看本指南某段与代码不一致时可直接跳回 PRD 验证原始设计意图，并 grep 相同 US-XXX 同步更新其他文档。
