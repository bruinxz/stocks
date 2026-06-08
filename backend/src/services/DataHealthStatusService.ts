import { fn, col } from 'sequelize';
import { NorthboundHolding } from '../models/NorthboundHolding';
import { DragonTigerBoard } from '../models/DragonTigerBoard';
import { LimitUpStock } from '../models/LimitUpStock';
import { IndustryFlow } from '../models/IndustryFlow';
import { FinancialReport } from '../models/FinancialReport';
import { SnowballHotKeyword } from '../models/SnowballHotKeyword';
import { AnalystForecast } from '../models/AnalystForecast';
import { ShareholderCount } from '../models/ShareholderCount';
import { DividendHistory } from '../models/DividendHistory';
import { EarningsForecast } from '../models/EarningsForecast';
import { AnnouncementSummary } from '../models/AnnouncementSummary';
import { StockSentiment } from '../models/StockSentiment';
import { MarketSentimentIndex } from '../models/MarketSentimentIndex';
import { KOLOpinion } from '../models/KOLOpinion';
import { DailyBar } from '../models/DailyBar';
import { logger } from '../utils/logger';

/**
 * US-079 数据健康度看板
 *
 * 聚合每个数据源的最新同步状态——按 "latest_data_date" 与 "市场最新交易日"
 * 之间相差的 *交易日数* 计算 lag，给出红 (>3) / 黄 (1-3) / 绿 (0) 三态。
 *
 * 数据源分为 3 类（不同表用不同方式取 latest_data_date 与 record_count）：
 *   1. **日级行情类**（北向 / 龙虎榜 / 涨停 / 行业流 / 雪球热词 / 个股情绪 /
 *      市场情绪指数）— 主键含 trade_date，取 MAX(trade_date) 当 latest
 *   2. **per-stock 历史类**（财报 / 业绩预告 / 分析师 / 分红 / 股东户数）—
 *      取 MAX(report_date | announce_date) 当 latest（披露式数据天然就落后
 *      于市场日，可接受 lag 比较大）
 *   3. **事件流类**（公告 / KOL）— 取 MAX(updated_at)（事件型数据
 *      latest_data_date 用最后写入时间近似）
 *
 * 调用入口：DataController.getHealthStatus → API GET /api/data/health-status
 * 触发同步：DataController.triggerSync → API POST /api/data/sync/:source
 */
export type DataHealthLevel = 'green' | 'yellow' | 'red' | 'unknown';

export type DataSourceCategory = 'daily' | 'periodic' | 'event';

export interface DataSourceHealthCard {
  /** 数据源唯一 key，前端通过 key 调 trigger sync */
  key: string;
  /** 数据源中文展示名 */
  display_name: string;
  /** 数据源分类：日级 / 周期披露 / 事件流 */
  category: DataSourceCategory;
  /** 最新数据日期 (YYYY-MM-DD)，无数据时 null */
  latest_data_date: string | null;
  /** 最近一次写入时间 ISO，从模型 updated_at 取 */
  last_sync_at: string | null;
  /** 总记录条数 */
  record_count: number;
  /** 相对于 reference_trade_date 落后的交易日数；null 表示无法判定 */
  lag_trading_days: number | null;
  /** 健康度等级：red >3 / yellow 1-3 / green 0 / unknown */
  level: DataHealthLevel;
  /** 同步触发端点的 source key（与 :source path param 对齐） */
  sync_source: string;
  /** 数据源说明（短，给前端 tooltip 用） */
  description: string;
  /** 取数时发生错误的兜底文案 */
  error?: string;
}

export interface DataHealthStatusResponse {
  /** 用于计算 lag 的参考交易日（市场最新已有 daily_bar 的日） */
  reference_trade_date: string | null;
  /** 全部数据源卡片，按 priority + key 排序 */
  cards: DataSourceHealthCard[];
  /** 整体汇总：4 种 level 各有多少个数据源 */
  summary: Record<DataHealthLevel, number>;
  /** 服务端时间戳（前端可显示"数据获取时间"） */
  generated_at: string;
}

interface SourceDefinition {
  key: string;
  display_name: string;
  category: DataSourceCategory;
  description: string;
  /** 同步触发的 sync_source 值（POST /api/data/sync/:source 接收的 :source） */
  sync_source: string;
  /** 取最新日期 + record count；reference_trade_date 由调用者传入计算 lag */
  loadLatest: () => Promise<{
    latest_data_date: string | null;
    last_sync_at: string | null;
    record_count: number;
  }>;
}

/**
 * 把 Sequelize 取出来的日期值（可能 string / Date / null）规整为 'YYYY-MM-DD' 字符串。
 * - 一些 dialect 把 DATEONLY 列返回 string，一些返回 Date；统一处理避免上游分支
 */
export function normalizeDateOnly(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = value.match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * 把 Date 规整为 ISO 字符串；null/无效返回 null。
 */
export function normalizeIsoDateTime(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  }
  return null;
}

/**
 * 从一组已升序的交易日 array 中，计算 latestDataDate 距离 referenceDate 的交易日数。
 * 包含 boundary：latest === reference → 0；reference 不在 array 内时返回最贴近 reference 的
 * trading-day distance（fallback 用日历日差）。
 */
export function computeLagInTradingDays(
  latestDataDate: string | null,
  referenceTradeDate: string | null,
  knownTradeDatesDesc: string[]
): number | null {
  if (!latestDataDate || !referenceTradeDate) return null;
  if (latestDataDate >= referenceTradeDate) return 0;

  // count distinct trade dates between (latest, reference] inclusive of reference
  let lag = 0;
  for (const td of knownTradeDatesDesc) {
    if (td > referenceTradeDate) continue;
    if (td <= latestDataDate) break;
    lag += 1;
  }
  return lag;
}

/**
 * 根据 lag 决定 level：unknown → 'unknown' / 0 → green / 1-3 → yellow / >3 → red。
 * 注意 periodic 类（报告期数据）天然 lag 大，下游可放宽阈值——这里给个 *默认* 阈值，
 * 实现时已包装好。
 */
export function decideLevel(lag: number | null, category: DataSourceCategory): DataHealthLevel {
  if (lag === null) return 'unknown';
  if (category === 'periodic') {
    // 季报 / 年报披露期天然落后；阈值放宽
    if (lag <= 30) return 'green';
    if (lag <= 90) return 'yellow';
    return 'red';
  }
  if (category === 'event') {
    // 事件流（公告 / KOL）按周期评估，1 周内绿，2 周黄，超 2 周红
    if (lag <= 7) return 'green';
    if (lag <= 14) return 'yellow';
    return 'red';
  }
  // daily
  if (lag === 0) return 'green';
  if (lag <= 3) return 'yellow';
  return 'red';
}

async function maxFieldDateOnly(
  Model: any,
  field: string,
  alias = 'latest'
): Promise<string | null> {
  try {
    const row = await Model.findOne({
      attributes: [[fn('MAX', col(field)), alias]],
      raw: true,
    });
    const raw = (row as Record<string, unknown> | null)?.[alias];
    return normalizeDateOnly(raw);
  } catch (error: any) {
    logger.warn(
      `DataHealthStatusService maxField(${Model?.name}, ${field}) failed: ${error?.message}`
    );
    return null;
  }
}

async function maxUpdatedAt(Model: any, alias = 'latest_updated'): Promise<string | null> {
  try {
    const row = await Model.findOne({
      attributes: [[fn('MAX', col('updated_at')), alias]],
      raw: true,
    });
    const raw = (row as Record<string, unknown> | null)?.[alias];
    return normalizeIsoDateTime(raw);
  } catch (error: any) {
    logger.warn(`DataHealthStatusService maxUpdatedAt(${Model?.name}) failed: ${error?.message}`);
    return null;
  }
}

async function countAll(Model: any): Promise<number> {
  try {
    const count = await Model.count();
    return Number(count) || 0;
  } catch (error: any) {
    logger.warn(`DataHealthStatusService countAll(${Model?.name}) failed: ${error?.message}`);
    return 0;
  }
}

/** 取市场最近 60 天的交易日（DESC 排序），用于 lag 计算 */
async function loadRecentTradeDates(limit = 90): Promise<string[]> {
  try {
    const rows: any[] = await DailyBar.findAll({
      attributes: [[fn('DISTINCT', col('time')), 'time']],
      order: [['time', 'DESC']],
      limit,
      raw: true,
    });
    const dates = rows.map(r => normalizeDateOnly(r.time)).filter((d): d is string => Boolean(d));
    // dedupe (DISTINCT 已经做了但插入 timestamps may still alias)
    return Array.from(new Set(dates)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  } catch (error: any) {
    logger.warn(`DataHealthStatusService loadRecentTradeDates failed: ${error?.message}`);
    return [];
  }
}

/**
 * 取 daily_bars 最新的交易日（市场已收一日 = 用作 reference），若空表则返回 null。
 */
export async function loadReferenceTradeDate(): Promise<string | null> {
  const dates = await loadRecentTradeDates(1);
  return dates.length > 0 ? dates[0] : null;
}

/**
 * 全部数据源的注册中心。新加数据源时在此 array push 一条即可，
 * service / route / 前端 dashboard 都自动覆盖到。
 */
function getSourceDefinitions(): SourceDefinition[] {
  return [
    {
      key: 'northbound',
      display_name: '北向资金日度持股',
      category: 'daily',
      description: '陆股通 / 沪深港通日度持股快照，AKShare stock_hsgt_hold_stock_em',
      sync_source: 'northbound',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(NorthboundHolding, 'trade_date'),
        last_sync_at: await maxUpdatedAt(NorthboundHolding),
        record_count: await countAll(NorthboundHolding),
      }),
    },
    {
      key: 'dragon_tiger',
      display_name: '龙虎榜每日明细',
      category: 'daily',
      description: '游资 / 机构席位买卖明细，AKShare stock_lhb_detail_em',
      sync_source: 'dragon_tiger',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(DragonTigerBoard, 'trade_date'),
        last_sync_at: await maxUpdatedAt(DragonTigerBoard),
        record_count: await countAll(DragonTigerBoard),
      }),
    },
    {
      key: 'limit_up',
      display_name: '涨停板与连板高度',
      category: 'daily',
      description: '涨停 + 跌停 + 连板梯队，AKShare stock_zt_pool_em + strong_pool',
      sync_source: 'limit_up',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(LimitUpStock, 'trade_date'),
        last_sync_at: await maxUpdatedAt(LimitUpStock),
        record_count: await countAll(LimitUpStock),
      }),
    },
    {
      key: 'industry_flow',
      display_name: '行业资金流与板块强度',
      category: 'daily',
      description: '行业板块主力资金流与涨跌幅排名，AKShare 板块系列接口',
      sync_source: 'industry_flow',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(IndustryFlow, 'trade_date'),
        last_sync_at: await maxUpdatedAt(IndustryFlow),
        record_count: await countAll(IndustryFlow),
      }),
    },
    {
      key: 'snowball_hot',
      display_name: '雪球热词',
      category: 'daily',
      description: '雪球当日热门关键词与情绪聚合，AKShare snowball 接口',
      sync_source: 'snowball_hot',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(SnowballHotKeyword, 'trade_date'),
        last_sync_at: await maxUpdatedAt(SnowballHotKeyword),
        record_count: await countAll(SnowballHotKeyword),
      }),
    },
    {
      key: 'stock_sentiment',
      display_name: '个股舆情热度',
      category: 'daily',
      description: '个股舆情热度（东财问答 / 雪球评论代理），按日聚合',
      sync_source: 'stock_sentiment',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(StockSentiment, 'trade_date'),
        last_sync_at: await maxUpdatedAt(StockSentiment),
        record_count: await countAll(StockSentiment),
      }),
    },
    {
      key: 'market_sentiment',
      display_name: '市场情绪量化指数',
      category: 'daily',
      description: 'A 股市场情绪综合指数（多维度加权 sigmoid 归一化）',
      sync_source: 'market_sentiment',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(MarketSentimentIndex, 'trade_date'),
        last_sync_at: await maxUpdatedAt(MarketSentimentIndex),
        record_count: await countAll(MarketSentimentIndex),
      }),
    },
    {
      key: 'financial_report',
      display_name: '财务报告（年报 / 季报）',
      category: 'periodic',
      description: '上市公司定期财报，主键 (report_date, stock_code)；按报告期同步',
      sync_source: 'financial_report',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(FinancialReport, 'report_date'),
        last_sync_at: await maxUpdatedAt(FinancialReport),
        record_count: await countAll(FinancialReport),
      }),
    },
    {
      key: 'earnings_forecast',
      display_name: '业绩预告',
      category: 'periodic',
      description: '公司业绩预告 / 快报 / 正式财报披露窗口，AKShare 业绩系列',
      sync_source: 'earnings_forecast',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(EarningsForecast, 'report_period'),
        last_sync_at: await maxUpdatedAt(EarningsForecast),
        record_count: await countAll(EarningsForecast),
      }),
    },
    {
      key: 'analyst_forecast',
      display_name: '分析师一致预期',
      category: 'periodic',
      description: '券商研报 EPS / 评级，per-stock 历史 + 跨年度滚动列',
      sync_source: 'analyst_forecast',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(AnalystForecast, 'report_date'),
        last_sync_at: await maxUpdatedAt(AnalystForecast),
        record_count: await countAll(AnalystForecast),
      }),
    },
    {
      key: 'dividend_history',
      display_name: '分红派息历史',
      category: 'periodic',
      description: 'A 股公司分红派息历史 + 股息率，per-stock 全量历史',
      sync_source: 'dividend_history',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(DividendHistory, 'ex_date'),
        last_sync_at: await maxUpdatedAt(DividendHistory),
        record_count: await countAll(DividendHistory),
      }),
    },
    {
      key: 'shareholder_count',
      display_name: '股东户数',
      category: 'periodic',
      description: '股东户数 + 户均流通市值，季度披露，per-stock 全量历史',
      sync_source: 'shareholder_count',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(ShareholderCount, 'report_date'),
        last_sync_at: await maxUpdatedAt(ShareholderCount),
        record_count: await countAll(ShareholderCount),
      }),
    },
    {
      key: 'announcements',
      display_name: '公告摘要 NLP',
      category: 'event',
      description: '公司公告主题 / 情感分析（启发式 + AI fallback）',
      sync_source: 'announcements',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(AnnouncementSummary, 'announce_date'),
        last_sync_at: await maxUpdatedAt(AnnouncementSummary),
        record_count: await countAll(AnnouncementSummary),
      }),
    },
    {
      key: 'kol_opinions',
      display_name: 'KOL 观点聚合',
      category: 'event',
      description: '雪球大 V / 微博财经博主观点抓取与聚合',
      sync_source: 'kol_opinions',
      loadLatest: async () => ({
        latest_data_date: await maxFieldDateOnly(KOLOpinion, 'opinion_date'),
        last_sync_at: await maxUpdatedAt(KOLOpinion),
        record_count: await countAll(KOLOpinion),
      }),
    },
  ];
}

/**
 * Lookup source by sync key, used by trigger endpoint to find which sync service to invoke.
 */
export function listDataSources(): { key: string; sync_source: string }[] {
  return getSourceDefinitions().map(def => ({ key: def.key, sync_source: def.sync_source }));
}

export class DataHealthStatusService {
  /**
   * 主入口：返回所有数据源健康卡片（含每个 lag / level / 记录数 / 最近同步时间）。
   *
   * 设计要点：
   * - 并发跑每个 source 的 loadLatest，单个失败不阻塞其他（per-card try/catch 兜底）
   * - reference_trade_date 用 daily_bars 最新一日，空表时 lag=null → level='unknown'
   * - lag 在交易日维度计算（绕开周末 / 节假日的"假落后"），用最近 90 天交易日 desc 列表
   */
  async getHealthStatus(): Promise<DataHealthStatusResponse> {
    const definitions = getSourceDefinitions();
    const [referenceTradeDate, recentTradeDates] = await Promise.all([
      loadReferenceTradeDate(),
      loadRecentTradeDates(90),
    ]);

    const cards: DataSourceHealthCard[] = await Promise.all(
      definitions.map(async def => {
        try {
          const latest = await def.loadLatest();
          const lag =
            def.category === 'periodic' || def.category === 'event'
              ? this._computeCalendarLag(latest.latest_data_date, referenceTradeDate)
              : computeLagInTradingDays(
                  latest.latest_data_date,
                  referenceTradeDate,
                  recentTradeDates
                );
          const level = decideLevel(lag, def.category);
          return {
            key: def.key,
            display_name: def.display_name,
            category: def.category,
            latest_data_date: latest.latest_data_date,
            last_sync_at: latest.last_sync_at,
            record_count: latest.record_count,
            lag_trading_days: lag,
            level,
            sync_source: def.sync_source,
            description: def.description,
          };
        } catch (error: any) {
          logger.warn(
            `DataHealthStatusService card(${def.key}) failed: ${error?.message ?? 'unknown'}`
          );
          return {
            key: def.key,
            display_name: def.display_name,
            category: def.category,
            latest_data_date: null,
            last_sync_at: null,
            record_count: 0,
            lag_trading_days: null,
            level: 'unknown' as DataHealthLevel,
            sync_source: def.sync_source,
            description: def.description,
            error: error?.message ?? '数据源查询失败',
          };
        }
      })
    );

    const summary: Record<DataHealthLevel, number> = {
      green: 0,
      yellow: 0,
      red: 0,
      unknown: 0,
    };
    for (const c of cards) summary[c.level] += 1;

    return {
      reference_trade_date: referenceTradeDate,
      cards,
      summary,
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * 周期 / 事件类数据 lag 计算用日历日差，绕开交易日依赖
   * (财报披露 / 公告事件不是按交易日发生，按 calendar day 计算更直观)。
   */
  private _computeCalendarLag(
    latestDataDate: string | null,
    referenceTradeDate: string | null
  ): number | null {
    if (!latestDataDate || !referenceTradeDate) return null;
    const latest = new Date(`${latestDataDate}T00:00:00Z`);
    const reference = new Date(`${referenceTradeDate}T00:00:00Z`);
    if (Number.isNaN(latest.getTime()) || Number.isNaN(reference.getTime())) return null;
    const diffMs = reference.getTime() - latest.getTime();
    if (diffMs <= 0) return 0;
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }
}

export const dataHealthStatusService = new DataHealthStatusService();
