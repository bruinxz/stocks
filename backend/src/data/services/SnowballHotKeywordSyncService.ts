import { Op } from 'sequelize';
import { SnowballHotKeyword } from '../../models/SnowballHotKeyword';
import { logger } from '../../utils/logger';
import {
  SnowballHotKeywordClient,
  SnowballHotKeywordRow,
  SnowballSymbol,
  snowballHotKeywordClient,
} from '../sources/SnowballHotKeywordClient';

/**
 * 雪球热词同步服务 — US-058.
 *
 * `syncDate(date)`:
 *   1. 拉雪球关注度排行 (默认 symbol='最热门', limit=200);
 *   2. 与上一个有数据的交易日的关键词集合对比, 标记 `is_new`;
 *   3. bulkCreate + updateOnDuplicate upsert 到 `snowball_hot_keywords` 表。
 *
 * **AKShare 实时快照特性 (与 US-008 IndustryFlow 同款)**: 接口无日期参数,
 * 当下调用返回 "now" 的关注度。`trade_date` 是 caller 服务层在盘后调度时贴
 * 上的标签 — 当天调度的数据贴当天 trade_date, 历史日期回填只会把标签写成
 * 传入值, 关注度仍是 "当下" 数值。该限制已透传到 `SnowballHotKeyword` 模型
 * 与 Client jsdoc, 服务层不做隐藏。
 *
 * **新进关键词判定**: 上一交易日的"上一日"在节假日 / 周末时可能没有数据,
 * `loadPreviousKeywords()` 取**最近 ≤ trade_date - 1 天且有数据的最近一日**
 * 的全部 keyword 集合作为 baseline。无 baseline 时 (首次同步) 全部 is_new=false
 * (不强行标记, 避免首次同步出现 200 个"新进"假信号)。
 *
 * **失败兜底**: 单日 fetch 失败不抛, 返回 `SyncDateResult.error`; 与
 * `IndustrySyncService` 同款形态便于 `syncRange()` 隔夜补漏跑完不中断。
 */
export interface SyncDateResult {
  trade_date: string;
  symbol: SnowballSymbol;
  fetched: number;
  upserted: number;
  /** 相对上一个有数据的交易日, 新进的 keyword 数 */
  new_keywords_count: number;
  /** baseline 用的 trade_date (上一个有数据的交易日); null 表示首次同步无 baseline */
  baseline_trade_date: string | null;
  skipped: boolean;
  error?: string;
}

export interface SyncDateOptions {
  symbol?: SnowballSymbol;
  /** 返回行数上限 (传给 client + Python helper) */
  limit?: number;
  /** baseline 回看最大自然日数 (默认 14, 覆盖春节最长假期) */
  baselineLookbackDays?: number;
}

export interface SyncRangeOptions extends SyncDateOptions {
  /** 单日已有任意一条 snowball_hot_keywords 时跳过整日, 默认 true */
  skipExisting?: boolean;
  /** 每个日子之间间隔毫秒 (防 AKShare 限流), 默认 3000 */
  intervalMs?: number;
}

export interface SyncRangeResult {
  start: string;
  end: string;
  symbol: SnowballSymbol;
  total_days: number;
  succeeded: number;
  skipped: number;
  failed: number;
  details: SyncDateResult[];
}

export class SnowballHotKeywordSyncService {
  private client: SnowballHotKeywordClient;

  constructor(client: SnowballHotKeywordClient = snowballHotKeywordClient) {
    this.client = client;
  }

  /**
   * 同步指定日期的雪球热词榜 (含 is_new 标记).
   * @param date ISO YYYY-MM-DD (默认今日)
   */
  async syncDate(date: string, options: SyncDateOptions = {}): Promise<SyncDateResult> {
    const symbol = options.symbol ?? '最热门';
    const limit = Math.max(1, Math.min(1000, options.limit ?? 200));
    const baselineLookback = Math.max(1, options.baselineLookbackDays ?? 14);
    try {
      const rows = await this.client.fetchKeywords(date, symbol, limit);
      if (rows.length === 0) {
        logger.warn(
          `SnowballHotKeyword: no data returned for ${date} (symbol=${symbol}), marking as empty success`
        );
        return {
          trade_date: date,
          symbol,
          fetched: 0,
          upserted: 0,
          new_keywords_count: 0,
          baseline_trade_date: null,
          skipped: false,
        };
      }

      // 取上一个有数据的交易日的关键词集合作为 baseline
      const baseline = await this.loadPreviousKeywords(date, baselineLookback);
      const baselineKeywords = baseline ? baseline.keywords : null;

      let newCount = 0;
      const records = rows.map((row: SnowballHotKeywordRow) => {
        const isNew = baselineKeywords !== null && !baselineKeywords.has(row.keyword);
        if (isNew) newCount += 1;
        return {
          trade_date: date,
          keyword: row.keyword,
          heat_score: row.heat_score,
          rank: row.rank,
          related_stocks_json: [
            {
              stock_code: row.stock_code,
              stock_name: row.stock_name,
              latest_price: row.latest_price,
            },
          ],
          source: row.source,
          is_new: isNew,
          raw_payload: row.raw_payload ?? {},
        };
      });

      await SnowballHotKeyword.bulkCreate(records, {
        updateOnDuplicate: [
          'heat_score',
          'rank',
          'related_stocks_json',
          'source',
          'is_new',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(
        `SnowballHotKeyword: upserted ${records.length} rows for ${date} ` +
          `(symbol=${symbol}, new_keywords=${newCount}, baseline=${
            baseline ? baseline.tradeDate : 'none'
          })`
      );
      return {
        trade_date: date,
        symbol,
        fetched: rows.length,
        upserted: records.length,
        new_keywords_count: newCount,
        baseline_trade_date: baseline ? baseline.tradeDate : null,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`SnowballHotKeyword syncDate(${date}) failed: ${message}`);
      return {
        trade_date: date,
        symbol,
        fetched: 0,
        upserted: 0,
        new_keywords_count: 0,
        baseline_trade_date: null,
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * 闭区间按日遍历, 断点续传 (skipExisting=true 时跳过已 sync 的日期).
   * AKShare 实时快照特性: 历史日期回填的关注度仍是当下 "now" 值,
   * 标签是传入日期。
   */
  async syncRange(
    start: string,
    end: string,
    options: SyncRangeOptions = {}
  ): Promise<SyncRangeResult> {
    const symbol = options.symbol ?? '最热门';
    const skipExisting = options.skipExisting ?? process.env.SNOWBALL_KEYWORD_SKIP_EXISTING !== '0';
    const intervalMs = Math.max(0, options.intervalMs ?? 3000);

    const startDate = parseIsoDate(start);
    const endDate = parseIsoDate(end);
    if (startDate > endDate) {
      throw new Error(`SnowballHotKeyword syncRange: start ${start} after end ${end}`);
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
        const existing = await SnowballHotKeyword.count({ where: { trade_date: iso } });
        if (existing > 0) {
          logger.info(`SnowballHotKeyword: skip ${iso} (${existing} rows already present)`);
          details.push({
            trade_date: iso,
            symbol,
            fetched: 0,
            upserted: 0,
            new_keywords_count: 0,
            baseline_trade_date: null,
            skipped: true,
          });
          skipped += 1;
          continue;
        }
      }

      const result = await this.syncDate(iso, options);
      details.push(result);
      if (result.error) failed += 1;
      else succeeded += 1;

      if (intervalMs > 0 && cursor < endDate) {
        await sleep(intervalMs);
      }
    }

    return {
      start,
      end,
      symbol,
      total_days: totalDays,
      succeeded,
      skipped,
      failed,
      details,
    };
  }

  /**
   * 取**最近 ≤ trade_date - 1 天且有数据**的关键词集合, 作为 is_new 判定 baseline.
   * 在节假日 / 周末时跳到 lookbackDays 内最近的有效日。
   *
   * @returns 该日的 trade_date + keyword Set; null 表示无 baseline (首次同步)
   */
  async loadPreviousKeywords(
    tradeDate: string,
    lookbackDays: number
  ): Promise<{ tradeDate: string; keywords: Set<string> } | null> {
    const dt = parseIsoDate(tradeDate);
    const oldest = new Date(dt);
    oldest.setUTCDate(oldest.getUTCDate() - lookbackDays);
    const oldestIso = oldest.toISOString().slice(0, 10);

    // 取上一个 trade_date < tradeDate 内有数据的最近一日
    const latestRow = await SnowballHotKeyword.findOne({
      attributes: ['trade_date'],
      where: {
        trade_date: { [Op.gte]: oldestIso, [Op.lt]: tradeDate },
      },
      order: [['trade_date', 'DESC']],
    });

    if (!latestRow) return null;
    const previousDate = latestRow.trade_date;

    const rows = await SnowballHotKeyword.findAll({
      attributes: ['keyword'],
      where: { trade_date: previousDate },
      raw: true,
    });
    const set = new Set<string>(rows.map(r => r.keyword));
    return { tradeDate: previousDate, keywords: set };
  }

  /**
   * 读端: 列表查询某日的雪球热词榜.
   *
   * @param date ISO YYYY-MM-DD (默认最近一个有数据的日)
   * @param onlyNew true 时只返回当日 is_new=true 的"新进"关键词
   * @param limit 上限 (默认 200, 上限 1000 防滥用)
   */
  async listByDate(date?: string, onlyNew = false, limit = 200): Promise<SnowballHotKeyword[]> {
    const cap = Math.max(1, Math.min(1000, Math.floor(limit)));
    let targetDate = date;
    if (!targetDate) {
      // 找最近一日有数据的 trade_date
      const latest = await SnowballHotKeyword.findOne({
        attributes: ['trade_date'],
        order: [['trade_date', 'DESC']],
      });
      if (!latest) return [];
      targetDate = latest.trade_date;
    }
    const where: Record<string, unknown> = { trade_date: targetDate };
    if (onlyNew) where.is_new = true;
    return SnowballHotKeyword.findAll({
      where,
      order: [
        ['rank', 'ASC'],
        ['keyword', 'ASC'],
      ],
      limit: cap,
    });
  }
}

// ---------------------------------------------------------------------------
// 公共导出 helpers (供测试断言 / 调用方静态导入)
// ---------------------------------------------------------------------------

/** YYYY-MM-DD → Date (UTC); 失败抛 RangeError */
export function parseIsoDate(d: string): Date {
  const dt = new Date(`${d}T00:00:00Z`);
  if (!Number.isFinite(dt.getTime())) {
    throw new RangeError(`Invalid ISO date: ${d}`);
  }
  return dt;
}

/** Promise sleep */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 生产环境 singleton */
export const snowballHotKeywordSyncService = new SnowballHotKeywordSyncService();
