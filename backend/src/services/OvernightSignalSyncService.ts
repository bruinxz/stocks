import { Op } from 'sequelize';
import { OvernightSignal } from '../models/OvernightSignal';
import { logger } from '../utils/logger';
import {
  OvernightSignalClient,
  OvernightSignalRow,
  overnightSignalClient,
} from '../data/sources/OvernightSignalClient';

/**
 * 隔夜信号矩阵同步服务 — PR-M1.
 *
 * Cron `* /15 0-9,21-23 * * *` 每 15 分钟拉一次 (北京时间 21:00-23:00 隔夜
 * 美股开盘期 + 次日 00:00-09:00 美股 + A50 期指 + 港股开盘前). 写入
 * `overnight_signals` 表, 给早盘 9:25 推荐服务消费.
 *
 * Cron 频次设计:
 *   - 9 小时窗口 (晚 21-23 + 早 0-9) × 每 15 分钟 = 36 次 / 日
 *   - 每次 5 个 source = 180 行 / 日, 每行 ~500 字节 = 90 KB / 日
 *
 * fail-OPEN 三层 (与 ETF_FLOW_SYNC / MarketJudgmentService 同款):
 *   1. Python 层每个 source 独立 try/except - 单 source 抖动不阻塞其他;
 *   2. Service 层 fetchAll 抛 - 仅 warn + 返 {fetched=0, error}, 不阻塞 cron;
 *   3. SchedulerService dispatcher 层 try/catch - 整体异常仅 warn + 记 FAIL,
 *      下次 cron 15min 后再试.
 *
 * loadRecentContext() 给 QuantRecommendationService /
 * OpeningRushDetectorService 消费, 返回过去 12h 内最新的 per-source signal +
 * 推导的 market_direction. 详见函数 jsdoc.
 *
 * deriveMarketDirection() 规则 (PR-I 教训, 普跌日不要盲推):
 *   - 强烈走弱: a50 < -1% AND vix > +10% - 'bearish' (阻塞个股推荐)
 *   - 普跌:    a50 + hk + nasdaq 中 >= 2 个 < -0.5% - 'bearish'
 *   - 普涨:    a50 + hk + nasdaq 中 >= 2 个 > +0.5% - 'bullish'
 *   - 否则:    'neutral'
 *   - 任一关键 source 缺失 + 其余不明 - 'unknown'
 */

export type OvernightSignalType =
  | 'a50_future'
  | 'hk_hsi'
  | 'us_nasdaq'
  | 'us_dxy'
  | 'us_vix'
  | 'china_adr';

export type MarketDirection = 'bullish' | 'neutral' | 'bearish' | 'unknown';

export interface SyncOneSourceResult {
  signal_type: OvernightSignalType;
  ok: boolean;
  source: string | null;
  value: number | null;
  change_pct: number | null;
  error?: string;
}

export interface SyncAllResult {
  /** 实际拉到的 source 数 (0-5) */
  fetched: number;
  /** 写库行数 (含 upsert 覆盖) */
  upserted: number;
  /** per-source 细节 (含失败) */
  per_source: SyncOneSourceResult[];
  /** 整体异常 - null = 部分成功也算 ok */
  error: string | null;
  /** 抓取时刻 (UTC); per-row collected_at 共享此时刻保证 UNIQUE 不冲突 */
  collected_at: Date;
}

export interface OvernightContext {
  /** 过去 12h 内 collected_at 最新的 per-source signal */
  signals: Map<OvernightSignalType, OvernightSignalRow & { collected_at: Date }>;
  /** 推导的大盘方向 - 给 recommendation gate 用 */
  market_direction: MarketDirection;
  /** 短句解释 (e.g. 'A50 -1.3% + VIX +15% -> 强烈走弱') */
  reason: string;
  /** 在线 source 数 (0-5) */
  source_count: number;
  /** 上下文时刻 (调用 loadRecentContext 时的 now) */
  as_of: Date;
}

/** 单调 toNumber, 同 ETFFlowSyncService.toNullableNumber 范式 - DECIMAL string -> number. */
export function toNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把过去 12h 内的 signal 行折叠成 per-source 最新一个 (DESC by collected_at).
 * Map 顺序按插入顺序, key 是 signal_type.
 */
export function pickLatestPerSource(
  rows: Array<{
    signal_type: string;
    source: string | null;
    value: number | null;
    change_pct: number | null;
    raw_payload: unknown;
    collected_at: Date;
  }>
): Map<OvernightSignalType, OvernightSignalRow & { collected_at: Date }> {
  const out = new Map<OvernightSignalType, OvernightSignalRow & { collected_at: Date }>();
  // rows 入参已按 collected_at DESC 排序 (loadRecentContext), 第一次见即最新
  for (const r of rows) {
    const st = r.signal_type as OvernightSignalType;
    if (out.has(st)) continue; // 取最新一条
    const value = toNullableNumber(r.value);
    if (value === null) continue;
    out.set(st, {
      signal_type: st,
      source: r.source ?? 'unknown',
      value,
      change_pct: toNullableNumber(r.change_pct),
      raw_payload: (r.raw_payload as Record<string, unknown>) ?? {},
      collected_at: r.collected_at,
    });
  }
  return out;
}

/**
 * 根据 5 个 source 的 change_pct 推导大盘方向.
 *
 * 优先级链 (一旦命中即返回):
 *   1. a50 < -1% AND vix > +10%  -> 'bearish' (强烈走弱, PR-I 教训阻塞推荐)
 *   2. 普跌  3 个核心 (a50/hk/nasdaq) 中 >= 2 个 < -0.5%  -> 'bearish'
 *   3. 普涨  3 个核心 (a50/hk/nasdaq) 中 >= 2 个 > +0.5%  -> 'bullish'
 *   4. 核心 source 都缺 -> 'unknown'
 *   5. 否则 -> 'neutral'
 */
export function deriveMarketDirection(
  signals: Map<OvernightSignalType, OvernightSignalRow & { collected_at: Date }>
): { direction: MarketDirection; reason: string } {
  const a50 = signals.get('a50_future')?.change_pct ?? null;
  const hk = signals.get('hk_hsi')?.change_pct ?? null;
  const nasdaq = signals.get('us_nasdaq')?.change_pct ?? null;
  const vix = signals.get('us_vix')?.change_pct ?? null;

  // 1. 强烈走弱
  if (a50 !== null && vix !== null && a50 < -1.0 && vix > 10.0) {
    return {
      direction: 'bearish',
      reason: `A50 ${a50.toFixed(2)}% + VIX ${vix > 0 ? '+' : ''}${vix.toFixed(1)}% -> 强烈走弱`,
    };
  }

  const core = [
    { key: 'A50', val: a50 },
    { key: '恒指', val: hk },
    { key: '纳指', val: nasdaq },
  ];
  const validCore = core.filter(c => c.val !== null);
  if (validCore.length === 0) {
    return { direction: 'unknown', reason: '隔夜信号全部缺失' };
  }

  const downCount = core.filter(c => c.val !== null && (c.val as number) < -0.5).length;
  const upCount = core.filter(c => c.val !== null && (c.val as number) > 0.5).length;

  if (downCount >= 2) {
    const parts = core
      .filter(c => c.val !== null)
      .map(c => `${c.key} ${(c.val as number).toFixed(2)}%`)
      .join(' / ');
    return { direction: 'bearish', reason: `${parts} -> 普跌` };
  }
  if (upCount >= 2) {
    const parts = core
      .filter(c => c.val !== null)
      .map(c => `${c.key} ${(c.val as number) > 0 ? '+' : ''}${(c.val as number).toFixed(2)}%`)
      .join(' / ');
    return { direction: 'bullish', reason: `${parts} -> 普涨` };
  }

  const parts = core
    .filter(c => c.val !== null)
    .map(
      c =>
        `${c.key} ${(c.val as number) > 0 ? '+' : ''}${(c.val as number).toFixed(2)}%`
    )
    .join(' / ');
  return { direction: 'neutral', reason: `${parts} -> 中性` };
}

export class OvernightSignalSyncService {
  private client: OvernightSignalClient;

  constructor(client: OvernightSignalClient = overnightSignalClient) {
    this.client = client;
  }

  /**
   * 拉全部 5 个 source 并写库. 单次调用所有 5 行共享同一 collected_at,
   * 保证 UNIQUE(signal_type, collected_at) 不冲突.
   *
   * @param now 测试可注入 - 生产默认 new Date()
   */
  async syncAllSources(now: Date = new Date()): Promise<SyncAllResult> {
    const collectedAt = now;
    const perSource: SyncOneSourceResult[] = [];
    let rows: OvernightSignalRow[] = [];
    try {
      rows = await this.client.fetchAll();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[overnight_signal] fetchAll outage: ${msg}`);
      return {
        fetched: 0,
        upserted: 0,
        per_source: [],
        error: msg,
        collected_at: collectedAt,
      };
    }

    // per-source detail
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.signal_type);
      perSource.push({
        signal_type: r.signal_type,
        ok: true,
        source: r.source ?? null,
        value: toNullableNumber(r.value),
        change_pct: toNullableNumber(r.change_pct),
      });
    }
    // 缺失 source 写入 ok=false 占位 (便于 monitoring)
    const allTypes: OvernightSignalType[] = [
      'a50_future',
      'hk_hsi',
      'us_nasdaq',
      'us_dxy',
      'us_vix',
    ];
    for (const st of allTypes) {
      if (!seen.has(st)) {
        perSource.push({
          signal_type: st,
          ok: false,
          source: null,
          value: null,
          change_pct: null,
          error: 'source_missing',
        });
      }
    }

    if (rows.length === 0) {
      logger.warn('[overnight_signal] no source returned data');
      return {
        fetched: 0,
        upserted: 0,
        per_source: perSource,
        error: null,
        collected_at: collectedAt,
      };
    }

    // 拼写库 record
    const records = rows.map(r => ({
      signal_type: r.signal_type,
      source: r.source ?? null,
      collected_at: collectedAt,
      value: toNullableNumber(r.value),
      change_pct: toNullableNumber(r.change_pct),
      raw_payload: r.raw_payload ?? {},
    }));

    try {
      await OvernightSignal.bulkCreate(records as any[], {
        updateOnDuplicate: ['value', 'change_pct', 'raw_payload', 'source'],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[overnight_signal] bulkCreate fail: ${msg}`);
      return {
        fetched: rows.length,
        upserted: 0,
        per_source: perSource,
        error: msg,
        collected_at: collectedAt,
      };
    }

    return {
      fetched: rows.length,
      upserted: records.length,
      per_source: perSource,
      error: null,
      collected_at: collectedAt,
    };
  }

  /**
   * 给 QuantRecommendationService 调用 - 加载过去 12 小时的隔夜信号上下文,
   * 推导出大盘方向 + 短句原因.
   *
   * 调用方典型用法:
   * ```ts
   * const ctx = await overnightSignalSyncService.loadRecentContext();
   * if (ctx.market_direction === 'bearish' && ctx.signals.size >= 3) {
   *   return { ...result, blocked: true, blocked_reason: ctx.reason };
   * }
   * ```
   */
  async loadRecentContext(now: Date = new Date()): Promise<OvernightContext> {
    const since = new Date(now.getTime() - 12 * 3600 * 1000);
    let rows: any[] = [];
    try {
      rows = await OvernightSignal.findAll({
        where: {
          collected_at: { [Op.gte]: since },
        },
        order: [['collected_at', 'DESC']],
        raw: true,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[overnight_signal] loadRecentContext fail: ${msg}`);
      return {
        signals: new Map(),
        market_direction: 'unknown',
        reason: `加载隔夜信号失败: ${msg}`,
        source_count: 0,
        as_of: now,
      };
    }

    const signals = pickLatestPerSource(rows);
    const { direction, reason } = deriveMarketDirection(signals);
    return {
      signals,
      market_direction: direction,
      reason,
      source_count: signals.size,
      as_of: now,
    };
  }
}

export const overnightSignalSyncService = new OvernightSignalSyncService();
