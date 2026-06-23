import { Op } from 'sequelize';
import { ETFFlow } from '../../models/ETFFlow';
import { logger } from '../../utils/logger';
import { ETFFlowClient, ETFFlowRow, etfFlowClient } from '../sources/ETFFlowClient';
import {
  getETFProfile,
  getAllWhitelistedETFCodes,
  getETFCodesByIndustry,
} from '../../constants/etfIndustry';

/**
 * 行业 ETF 资金流入库服务 — US-092 数据层.
 *
 * AKShare ETF 端点按日检索 (fund_etf_fund_daily_em + fund_etf_hist_em);
 * 本服务面向**单日**或**日期范围**进行同步:
 *
 *   - `syncDate(date)`               — 拉取单日并 bulkCreate upsert
 *   - `syncRange(start, end, opts?)` — 闭区间按日遍历, 支持断点续传
 *   - `listFlow(options?)`           — GET /api/data/etf-flow 端点的数据查询入口
 *
 * **PK = (trade_date, etf_code) 二元组** 与 NorthboundHolding (US-005) /
 * MarginTradingBalance (US-091) 同款形态; bulkCreate + updateOnDuplicate 在
 * 二元 PK 上 idempotent.
 *
 * **day-to-day diff 推算 net_inflow** (与 US-091 同款 identity 反推模式):
 *   net_inflow[T] ≈ (share_count[T] - share_count[T-1]) × nav[T]
 *   - 上一交易日 share_count 缺失 → net_inflow=null;
 *   - share_count[T] 或 nav[T] 缺失 → aum=null + net_inflow=null;
 *   - 学术依据: 国内基金研究普遍以"份额变化 × NAV" 作为申赎净额估计
 *     (份额是真实赎回/申购对应的会计指标, 二级市场买卖不会改变).
 *
 * **白名单过滤**: 仅入库 `constants/etfIndustry.ts` 内的 30+ 主流行业 ETF;
 *   Python 层只拉取白名单 codes (不扫全市场), TS 层 fallback 再用白名单二次
 *   过滤防 Python 端点返回未注册 ETF.
 *
 * **断点续传**: 默认按日 skip-existing (与 MarginTrading / Northbound 同款);
 *   `--force` 强制覆盖.
 *
 * 4 处文档同步标注 (与 US-091 同款) — Model column / Python helper docstring /
 * Client jsdoc / 本 SyncService jsdoc 一致.
 */
export interface SyncDateResult {
  trade_date: string;
  fetched: number;
  upserted: number;
  /** day-to-day diff 推算 net_inflow 成功的行数 (debug 用) */
  net_inflow_imputed: number;
  /** 白名单过滤掉的行数 (Python 返回非白名单 ETF, 理论上 0; 兜底 debug) */
  filtered_out: number;
  skipped: boolean;
  error?: string;
}

export interface SyncRangeOptions {
  /** 单日已有任意一条 etf_flows 时跳过整日 (默认 true) */
  skipExisting?: boolean;
}

export interface SyncRangeResult {
  start: string;
  end: string;
  total_days: number;
  succeeded: number;
  skipped: number;
  failed: number;
  details: SyncDateResult[];
}

export interface ListFlowOptions {
  /** 按行业筛选 (e.g. "半导体" / "医药"), 与 etf_code 互斥 */
  industry?: string;
  /** 按 ETF 代码筛选 (e.g. "159995"), 与 industry 互斥 */
  etf_code?: string;
  /** 回看天数 (默认 30 自然日, max 365) */
  days?: number;
  /** 终止日 YYYY-MM-DD (默认今天) */
  end?: string;
  /** 单 ETF 单日只一条; max rows 默认 5000 防 OOM */
  limit?: number;
}

export interface FlowEntry {
  trade_date: string;
  etf_code: string;
  etf_name: string;
  underlying_industry: string;
  net_inflow: number | null;
  aum: number | null;
  nav: number | null;
  share_count: number | null;
  secondary_turnover: number | null;
  close_price: number | null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ETFFlowSyncService {
  private client: ETFFlowClient;

  constructor(client: ETFFlowClient = etfFlowClient) {
    this.client = client;
  }

  /**
   * 同步单个交易日的全白名单 ETF 资金流.
   * @param date ISO YYYY-MM-DD
   * @param codes 可选自定义代码列表 (默认全白名单)
   */
  async syncDate(date: string, codes?: string[]): Promise<SyncDateResult> {
    if (!ISO_DATE_RE.test(date)) {
      return {
        trade_date: date,
        fetched: 0,
        upserted: 0,
        net_inflow_imputed: 0,
        filtered_out: 0,
        skipped: false,
        error: `Invalid date format (expected YYYY-MM-DD): ${date}`,
      };
    }

    const targetCodes = codes && codes.length > 0 ? codes : getAllWhitelistedETFCodes();
    if (targetCodes.length === 0) {
      return {
        trade_date: date,
        fetched: 0,
        upserted: 0,
        net_inflow_imputed: 0,
        filtered_out: 0,
        skipped: false,
        error: 'No ETF codes to sync (whitelist empty?)',
      };
    }

    try {
      const rows = await this.client.fetchDate(date, targetCodes);
      if (rows.length === 0) {
        logger.warn(`ETFFlow: no data returned for ${date}, marking as empty success`);
        return {
          trade_date: date,
          fetched: 0,
          upserted: 0,
          net_inflow_imputed: 0,
          filtered_out: 0,
          skipped: false,
        };
      }

      // ----- 白名单过滤兜底 -----
      let filteredOut = 0;
      const whitelistedRows: ETFFlowRow[] = [];
      for (const row of rows) {
        const profile = getETFProfile(row.etf_code);
        if (!profile) {
          filteredOut += 1;
          continue;
        }
        whitelistedRows.push(row);
      }

      // ----- service-layer in-memory dedup (同 US-091) -----
      // PK = (trade_date, etf_code) 二元组; 一日一只 ETF 理论上一行;
      // 兜底跨方言 idempotent.
      const seen = new Map<string, ETFFlowRow>();
      for (const row of whitelistedRows) {
        const key = `${row.trade_date}::${row.etf_code}`;
        if (seen.has(key)) continue;
        seen.set(key, row);
      }
      const uniqueRows = Array.from(seen.values());

      // ----- day-to-day diff 推算 net_inflow -----
      const codesWithShares = uniqueRows
        .filter(r => r.share_count !== null && r.nav !== null)
        .map(r => r.etf_code);
      const prevShareMap = await this.loadPrevDayShareForCodes(date, codesWithShares);
      let netInflowImputed = 0;

      const records = uniqueRows.map(row => {
        const profile = getETFProfile(row.etf_code);
        // 白名单已过滤; 防御性兜底 - 若 race condition / 白名单运行时被改空, 跳过
        if (!profile) {
          throw new Error(`ETF profile missing for whitelisted code ${row.etf_code}`);
        }
        const shareCount = row.share_count;
        const nav = row.nav;

        const aum =
          shareCount !== null && nav !== null && Number.isFinite(shareCount) && Number.isFinite(nav)
            ? shareCount * nav
            : null;

        let netInflow: number | null = null;
        if (shareCount !== null && nav !== null) {
          const prevShare = prevShareMap.get(row.etf_code);
          if (prevShare !== undefined && prevShare !== null) {
            // identity: net_inflow ≈ (share_count[T] - share_count[T-1]) × nav[T]
            netInflow = (shareCount - prevShare) * nav;
            netInflowImputed += 1;
          }
        }

        return {
          trade_date: row.trade_date,
          etf_code: row.etf_code,
          etf_name: row.etf_name ?? profile.name,
          underlying_industry: profile.industry,
          net_inflow: netInflow ?? undefined,
          aum: aum ?? undefined,
          nav: nav ?? undefined,
          share_count: shareCount ?? undefined,
          secondary_turnover: row.secondary_turnover ?? undefined,
          close_price: row.close_price ?? undefined,
          source: 'akshare',
          raw_payload: row.raw_payload ?? {},
        };
      });

      await ETFFlow.bulkCreate(records, {
        updateOnDuplicate: [
          'etf_name',
          'underlying_industry',
          'net_inflow',
          'aum',
          'nav',
          'share_count',
          'secondary_turnover',
          'close_price',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(
        `ETFFlow: upserted ${records.length} rows for ${date} ` +
          `(net_inflow_imputed=${netInflowImputed} filtered_out=${filteredOut})`
      );

      return {
        trade_date: date,
        fetched: rows.length,
        upserted: records.length,
        net_inflow_imputed: netInflowImputed,
        filtered_out: filteredOut,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      // BI-3 (2026-06-23): ETF sync 是 daily cron, 失败次日重试. error 字段已返
      // SyncDateResult.error 给 caller, log 降 warn 减少 error.log noise.
      logger.warn(`ETFFlow syncDate(${date}) failed: ${message}`);
      return {
        trade_date: date,
        fetched: 0,
        upserted: 0,
        net_inflow_imputed: 0,
        filtered_out: 0,
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * 闭区间按日遍历 (含两端), 断点续传: 默认遇到当日已有数据则跳过.
   *
   * 注意: ETF 数据只在交易日才有; 遇到周末/节假日 AKShare 返回空 dataframe.
   */
  async syncRange(
    start: string,
    end: string,
    options: SyncRangeOptions = {}
  ): Promise<SyncRangeResult> {
    const skipExisting = options.skipExisting ?? process.env.ETF_FLOW_SKIP_EXISTING !== '0';

    const startDate = parseIsoDate(start);
    const endDate = parseIsoDate(end);
    if (startDate > endDate) {
      throw new Error(`ETFFlow syncRange: start ${start} after end ${end}`);
    }

    const details: SyncDateResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    let totalDays = 0;

    for (
      let cursor = new Date(startDate);
      cursor <= endDate;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      totalDays += 1;
      const iso = cursor.toISOString().slice(0, 10);

      if (skipExisting) {
        const existing = await ETFFlow.count({ where: { trade_date: iso } });
        if (existing > 0) {
          logger.info(`ETFFlow: skip ${iso} (${existing} rows already present)`);
          details.push({
            trade_date: iso,
            fetched: 0,
            upserted: 0,
            net_inflow_imputed: 0,
            filtered_out: 0,
            skipped: true,
          });
          skipped += 1;
          continue;
        }
      }

      const dayResult = await this.syncDate(iso);
      details.push(dayResult);
      if (dayResult.error) failed += 1;
      else succeeded += 1;
    }

    return {
      start,
      end,
      total_days: totalDays,
      succeeded,
      skipped,
      failed,
      details,
    };
  }

  /**
   * 列表查询入口 - 供 GET /api/data/etf-flow 端点使用.
   *
   * 支持 (industry XOR etf_code) 单维度筛选, 默认返回最近 30 天数据按
   * (trade_date DESC, etf_code ASC) 排序.
   */
  async listFlow(options: ListFlowOptions = {}): Promise<FlowEntry[]> {
    const days = normalizePositiveInt(options.days, 30, 365);
    const limit = normalizePositiveInt(options.limit, 5000, 50_000);

    const end = options.end && ISO_DATE_RE.test(options.end) ? options.end : todayIso();
    const endDt = parseIsoDate(end);
    const startDt = new Date(endDt);
    startDt.setUTCDate(startDt.getUTCDate() - (days - 1));
    const start = startDt.toISOString().slice(0, 10);

    const where: any = {
      trade_date: { [Op.between]: [start, end] },
    };

    // industry 与 etf_code 互斥: industry 优先
    if (options.industry && options.industry.trim()) {
      const codes = getETFCodesByIndustry(options.industry.trim());
      if (codes.length === 0) {
        return [];
      }
      where.etf_code = { [Op.in]: codes };
    } else if (options.etf_code && options.etf_code.trim()) {
      where.etf_code = options.etf_code.trim();
    }

    const rows = (await ETFFlow.findAll({
      attributes: [
        'trade_date',
        'etf_code',
        'etf_name',
        'underlying_industry',
        'net_inflow',
        'aum',
        'nav',
        'share_count',
        'secondary_turnover',
        'close_price',
      ],
      where,
      order: [
        ['trade_date', 'DESC'],
        ['etf_code', 'ASC'],
      ],
      limit,
      raw: true,
    })) as unknown as Array<{
      trade_date: string;
      etf_code: string;
      etf_name: string;
      underlying_industry: string;
      net_inflow: any;
      aum: any;
      nav: any;
      share_count: any;
      secondary_turnover: any;
      close_price: any;
    }>;

    // DECIMAL 字段须 Number() 转换 (raw:true 取 DECIMAL 是 string, 见
    // US-088 codified pattern). nullable 字段先 null/undefined 检查再 Number
    // 避免 Number(null) === 0 大坑.
    return rows.map(r => ({
      trade_date: r.trade_date,
      etf_code: r.etf_code,
      etf_name: r.etf_name,
      underlying_industry: r.underlying_industry,
      net_inflow: toNullableNumber(r.net_inflow),
      aum: toNullableNumber(r.aum),
      nav: toNullableNumber(r.nav),
      share_count: toNullableNumber(r.share_count),
      secondary_turnover: toNullableNumber(r.secondary_turnover),
      close_price: toNullableNumber(r.close_price),
    }));
  }

  /**
   * 查指定 codes 在 < tradeDate 的最近一日 share_count, 供 day-to-day diff
   * 推算 net_inflow 使用.
   *
   * 实现 (同 US-091 loadPrevDayFinBalanceForCodes): 查 trade_date < target
   * 的最近一日, 一次 findAll 拉满 7 自然日窗口 + JS 端 reduce 取每个 code 最大
   * trade_date 行 - dialect-independent 优于 SQL DISTINCT ON.
   */
  private async loadPrevDayShareForCodes(
    targetDate: string,
    codes: string[]
  ): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (codes.length === 0) return out;

    const target = parseIsoDate(targetDate);
    const lower = new Date(target);
    lower.setUTCDate(lower.getUTCDate() - 7);
    const lowerIso = lower.toISOString().slice(0, 10);

    const rows = (await ETFFlow.findAll({
      attributes: ['etf_code', 'trade_date', 'share_count'],
      where: {
        etf_code: { [Op.in]: codes },
        trade_date: { [Op.gte]: lowerIso, [Op.lt]: targetDate },
      },
      raw: true,
    })) as unknown as Array<{
      etf_code: string;
      trade_date: string;
      share_count: any;
    }>;

    const latestByCode = new Map<string, { trade_date: string; share_count: any }>();
    for (const r of rows) {
      const existing = latestByCode.get(r.etf_code);
      if (!existing || r.trade_date > existing.trade_date) {
        latestByCode.set(r.etf_code, { trade_date: r.trade_date, share_count: r.share_count });
      }
    }

    for (const [code, entry] of latestByCode.entries()) {
      const v = toNullableNumber(entry.share_count);
      out.set(code, v);
    }

    return out;
  }
}

/** ISO YYYY-MM-DD → Date (UTC midnight). Exported for tests. */
export function parseIsoDate(iso: string): Date {
  if (!ISO_DATE_RE.test(iso)) {
    throw new Error(`Invalid ISO date (expected YYYY-MM-DD): ${iso}`);
  }
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

/** 今日 ISO 字符串. Exported for tests. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Clamp + sanitize 正整数 (用于 days/limit 等 query 参数). 无效值退回 default,
 * 超出 max 退回 max. 与既有 normalizeXxxConfig 同款"静默退回"风格.
 */
export function normalizePositiveInt(v: unknown, defaultValue: number, max: number): number {
  if (v === undefined || v === null) return defaultValue;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  const floored = Math.floor(n);
  return Math.min(floored, max);
}

/**
 * raw:true DECIMAL 字段 → number | null 转换 (US-088 codified pattern).
 * null/undefined 直接返回 null; 非有限 Number 也返回 null. Exported for tests.
 */
export function toNullableNumber(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

export const etfFlowSyncService = new ETFFlowSyncService();
