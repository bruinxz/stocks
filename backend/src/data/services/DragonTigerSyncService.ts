import { DragonTigerBoard } from '../../models/DragonTigerBoard';
import { logger } from '../../utils/logger';
import {
  DragonTigerClient,
  DragonTigerBoardRow,
  dragonTigerClient,
} from '../sources/DragonTigerClient';
import {
  isFamousYouzi,
  canonicalSeatName,
  getSeatType,
  SeatType,
} from '../../constants/famousSeats';
import { Op } from 'sequelize';

/**
 * 龙虎榜（Dragon-Tiger Board）日度入库服务
 *
 * - `syncDate(date)`：拉取单日龙虎榜，按 (trade_date, stock_code, buyer_seat,
 *   seller_seat) 做 upsert。同时标注 `is_famous_yz`（买方席位命中知名游资白名单）。
 * - `syncRange(start, end)`：闭区间按日遍历，默认开启断点续传
 *   （当日已有数据则跳过；`--force` 或 `DRAGON_TIGER_SKIP_EXISTING=0` 可禁用）。
 *
 * 失败的单日不中断 range，便于隔夜补漏。
 */
export interface SyncDateResult {
  trade_date: string;
  fetched: number;
  upserted: number;
  famous_hits: number;
  skipped: boolean;
  error?: string;
}

export interface SyncRangeOptions {
  /** 单日已有任意一条 dragon_tiger_board 时跳过整日，默认 true */
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

/**
 * US-088: 龙虎榜查询过滤参数
 *
 * 所有字段都是 optional —— 全空时返回最近 7 天的全部龙虎榜行（受 limit 限制）。
 * stock_code 可加可不加；seat_type 用于按归属机构维度过滤。
 */
export interface ListDragonTigerOptions {
  /** 股票代码（无市场后缀，例如 "600519"），缺省返回全市场 */
  stock_code?: string;
  /** 归属机构类型过滤（public_fund / foreign / private_fund / famous_yz / unknown） */
  seat_type?: SeatType;
  /** 起始日期 YYYY-MM-DD（含）；缺省 = end-7d */
  start?: string;
  /** 结束日期 YYYY-MM-DD（含）；缺省 = 今天 */
  end?: string;
  /** 返回行数上限，默认 200，硬上限 1000 防止误用 */
  limit?: number;
}

/**
 * US-088: 龙虎榜查询返回的精简行结构
 *
 * 比 Sequelize Model 实例轻量，避免把 raw_payload 等大字段透传给前端。
 */
export interface DragonTigerEntry {
  trade_date: string;
  stock_code: string;
  stock_name: string | null;
  buyer_seat: string;
  seller_seat: string;
  reason: string | null;
  buy_amount: number | null;
  sell_amount: number | null;
  net_amount: number | null;
  is_famous_yz: boolean;
  seat_type: SeatType;
}

export class DragonTigerSyncService {
  private client: DragonTigerClient;

  constructor(client: DragonTigerClient = dragonTigerClient) {
    this.client = client;
  }

  /**
   * 同步指定日期的龙虎榜营业部明细。
   * 内部会调用 famousSeats 白名单为每条记录打标。
   *
   * @param date ISO YYYY-MM-DD
   */
  async syncDate(date: string): Promise<SyncDateResult> {
    try {
      const rows = await this.client.fetchDailyDetail(date);
      if (rows.length === 0) {
        logger.warn(`DragonTiger: no data returned for ${date}, marking as empty success`);
        return {
          trade_date: date,
          fetched: 0,
          upserted: 0,
          famous_hits: 0,
          skipped: false,
        };
      }

      // 计算 is_famous_yz / seat_type 标签并归一席位名（命中别名时落标准名进库）
      let famousHits = 0;
      const records = rows.map((row: DragonTigerBoardRow) => {
        const buyerCanonical = canonicalSeatName(row.buyer_seat);
        const sellerCanonical = canonicalSeatName(row.seller_seat);
        const famous = isFamousYouzi(row.buyer_seat);
        // US-088: seat_type 用归一后的买方名查 — getSeatType 内部也会兜底原名 / 别名
        const seatType = getSeatType(buyerCanonical);
        if (famous) famousHits += 1;

        return {
          trade_date: row.trade_date,
          stock_code: row.stock_code,
          buyer_seat: buyerCanonical,
          seller_seat: sellerCanonical,
          stock_name: row.stock_name ?? undefined,
          reason: row.reason ?? undefined,
          buy_amount: row.buy_amount ?? undefined,
          sell_amount: row.sell_amount ?? undefined,
          net_amount: row.net_amount ?? undefined,
          is_famous_yz: famous,
          seat_type: seatType,
          source: 'akshare',
          raw_payload: row.raw_payload ?? {},
        };
      });

      // In-memory dedup by composite PK (trade_date, stock_code, buyer_seat, seller_seat).
      // AKShare occasionally returns dup rows for the same seat pair (e.g. when 营业部 has
      // multiple sub-account entries that we cannot distinguish), and canonicalSeatName
      // may also collapse alias variants onto the same canonical name. Either case causes
      // "ON CONFLICT DO UPDATE command cannot affect row a second time" on bulkCreate.
      // Keep the last occurrence (most recent in AKShare ordering wins).
      const dedupMap = new Map<string, (typeof records)[number]>();
      for (const rec of records) {
        const key = `${rec.trade_date}|${rec.stock_code}|${rec.buyer_seat}|${rec.seller_seat}`;
        dedupMap.set(key, rec);
      }
      const dedupedRecords = Array.from(dedupMap.values());
      const droppedDup = records.length - dedupedRecords.length;
      if (droppedDup > 0) {
        logger.info(
          `DragonTiger: deduped ${droppedDup} duplicate seat-pair rows for ${date} ` +
            `(${records.length} → ${dedupedRecords.length})`
        );
      }

      await DragonTigerBoard.bulkCreate(dedupedRecords, {
        updateOnDuplicate: [
          'stock_name',
          'reason',
          'buy_amount',
          'sell_amount',
          'net_amount',
          'is_famous_yz',
          'seat_type',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(
        `DragonTiger: upserted ${dedupedRecords.length} rows for ${date} (famous_yz hits=${famousHits})`
      );
      return {
        trade_date: date,
        fetched: rows.length,
        upserted: dedupedRecords.length,
        famous_hits: famousHits,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`DragonTiger syncDate(${date}) failed: ${message}`);
      return {
        trade_date: date,
        fetched: 0,
        upserted: 0,
        famous_hits: 0,
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * 闭区间按日遍历（含两端）。
   * 周末/节假日 AKShare 会返回空 dataframe，记一条 fetched=0 的 detail，
   * 不计入失败（同 NorthboundSyncService 的契约）。
   */
  async syncRange(
    start: string,
    end: string,
    options: SyncRangeOptions = {}
  ): Promise<SyncRangeResult> {
    const skipExisting = options.skipExisting ?? process.env.DRAGON_TIGER_SKIP_EXISTING !== '0';

    const startDate = parseIsoDate(start);
    const endDate = parseIsoDate(end);
    if (startDate > endDate) {
      throw new Error(`DragonTiger syncRange: start ${start} after end ${end}`);
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
        const existing = await DragonTigerBoard.count({ where: { trade_date: iso } });
        if (existing > 0) {
          logger.info(`DragonTiger: skip ${iso} (${existing} rows already present)`);
          details.push({
            trade_date: iso,
            fetched: 0,
            upserted: 0,
            famous_hits: 0,
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
   * US-088: 按过滤条件查询龙虎榜行。
   *
   * 用于 `GET /api/data/dragon-tiger` 端点 — 短线策略 / 前端面板按
   * `stock_code` + `seat_type` 拉取最近 N 天的龙虎榜营业部明细。
   *
   * 默认行为：
   *   - 缺省日期范围 = 最近 7 天（含今天）；
   *   - 缺省 limit = 200；硬上限 1000；
   *   - 按 `trade_date DESC, net_amount DESC` 排序（最近 + 净买入大的优先）；
   *   - stock_code 与 seat_type 互不依赖，可任选。
   *
   * 返回精简的 `DragonTigerEntry[]`，避免把 `raw_payload` 透传到 HTTP。
   */
  async listEntries(options: ListDragonTigerOptions = {}): Promise<DragonTigerEntry[]> {
    const limit = clampLimit(options.limit);
    const { start, end } = resolveDateRange(options.start, options.end);

    const where: Record<string, unknown> = {
      trade_date: { [Op.between]: [start, end] },
    };
    if (options.stock_code) where.stock_code = options.stock_code;
    if (options.seat_type) where.seat_type = options.seat_type;

    const rows = await DragonTigerBoard.findAll({
      where,
      order: [
        ['trade_date', 'DESC'],
        ['net_amount', 'DESC'],
      ],
      limit,
      raw: true,
    });

    return rows.map(r => ({
      trade_date: typeof r.trade_date === 'string' ? r.trade_date : String(r.trade_date),
      stock_code: r.stock_code,
      stock_name: r.stock_name ?? null,
      buyer_seat: r.buyer_seat,
      seller_seat: r.seller_seat,
      reason: r.reason ?? null,
      buy_amount: r.buy_amount === undefined || r.buy_amount === null ? null : Number(r.buy_amount),
      sell_amount:
        r.sell_amount === undefined || r.sell_amount === null ? null : Number(r.sell_amount),
      net_amount: r.net_amount === undefined || r.net_amount === null ? null : Number(r.net_amount),
      is_famous_yz: Boolean(r.is_famous_yz),
      seat_type: (r.seat_type as SeatType) || 'unknown',
    }));
  }
}

/** ISO YYYY-MM-DD → Date (UTC midnight)，避免本地时区漂移 */
function parseIsoDate(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`Invalid ISO date (expected YYYY-MM-DD): ${iso}`);
  }
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * US-088 helper: 限定 limit 在 [1, 1000] 内，默认 200。
 *
 * 公开 export 以便单测覆盖（边界 / 负数 / NaN / 超大）。
 */
export function clampLimit(raw: unknown, defaultValue = 200): number {
  const HARD_MAX = 1000;
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) return defaultValue;
  const intVal = Math.floor(num);
  if (intVal <= 0) return 1;
  if (intVal > HARD_MAX) return HARD_MAX;
  return intVal;
}

/**
 * US-088 helper: 解析查询日期范围，缺省 end=今天 / start=end-7d。
 *
 * 公开 export 以便单测覆盖（缺省 / 单边缺 / 非法格式 fallback）。
 *
 * 非法日期 fallback 到缺省值，避免抛错让上层 controller 必须二次校验；
 * controller 仍可在前置阶段单独 reject 明显非法的 query string。
 */
export function resolveDateRange(
  rawStart?: string,
  rawEnd?: string,
  todayIso = new Date().toISOString().slice(0, 10)
): { start: string; end: string } {
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  const end = rawEnd && ISO_RE.test(rawEnd) ? rawEnd : todayIso;

  if (rawStart && ISO_RE.test(rawStart)) {
    return { start: rawStart, end };
  }

  // 默认 = end - 7 天
  const endDate = new Date(`${end}T00:00:00.000Z`);
  endDate.setUTCDate(endDate.getUTCDate() - 7);
  return { start: endDate.toISOString().slice(0, 10), end };
}

export const dragonTigerSyncService = new DragonTigerSyncService();
