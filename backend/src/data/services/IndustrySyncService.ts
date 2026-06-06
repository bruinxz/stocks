import { Op } from 'sequelize';
import { IndustryFlow } from '../../models/IndustryFlow';
import { LimitUpStock } from '../../models/LimitUpStock';
import { logger } from '../../utils/logger';
import {
  IndustryFlowClient,
  IndustryFlowRow,
  industryFlowClient,
} from '../sources/IndustryFlowClient';

/**
 * 行业资金流与板块强度日度入库服务
 *
 * - `syncDate(date)`：拉取当日 86+ 行业板块的资金流快照（含每行业当日龙头股），
 *   并 join 库内 `LimitUpStock` 计算每个行业的 `limit_up_count`，最终按
 *   (trade_date, industry_code) upsert。
 *
 *   **AKShare 接口为实时快照而非历史**：fund_flow / board_name / cons 三个接口
 *   都只能拿"当下时刻"的数据。调用方应在当日盘后调用；历史日期回填只会把
 *   trade_date 标签写成传入值，资金流字段仍是当下快照——这是数据源限制，
 *   服务层不做隐藏。
 *
 * - `syncRange(start, end)`：闭区间按日遍历，支持断点续传
 *   （环境变量 `INDUSTRY_FLOW_SKIP_EXISTING=0` 或 `--force` 关闭）。
 *
 * 失败的单日不中断 range，便于隔夜补漏。
 */
export interface SyncDateResult {
  trade_date: string;
  fetched: number;
  upserted: number;
  /** 通过 LimitUpStock join 拿到 limit_up_count > 0 的行业数 */
  industries_with_limit_ups: number;
  /** 成功识别到龙头股（非一字板）的行业数 */
  industries_with_leader: number;
  skipped: boolean;
  error?: string;
}

export interface SyncRangeOptions {
  /** 单日已有任意一条 industry_flows 时跳过整日，默认 true */
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

export class IndustrySyncService {
  private client: IndustryFlowClient;

  constructor(client: IndustryFlowClient = industryFlowClient) {
    this.client = client;
  }

  /**
   * 同步指定日期的行业资金流（含 LimitUpStock join 的 limit_up_count 计算）
   * @param date ISO YYYY-MM-DD
   */
  async syncDate(date: string): Promise<SyncDateResult> {
    try {
      const rows = await this.client.fetchDailySnapshot(date);
      if (rows.length === 0) {
        logger.warn(`IndustryFlow: no data returned for ${date}, marking as empty success`);
        return {
          trade_date: date,
          fetched: 0,
          upserted: 0,
          industries_with_limit_ups: 0,
          industries_with_leader: 0,
          skipped: false,
        };
      }

      // ----- 1) 查同日所有涨停股票的 industry 分布，构建行业→涨停数 映射 -----
      const limitUpCountByIndustry = await this.loadLimitUpCountByIndustry(date);

      let withLimitUps = 0;
      let withLeader = 0;
      const records = rows.map((row: IndustryFlowRow) => {
        const limitUpCount = limitUpCountByIndustry.get(row.industry_name) ?? 0;
        if (limitUpCount > 0) withLimitUps += 1;
        if (row.leader_stock_code) withLeader += 1;
        return {
          trade_date: row.trade_date,
          industry_code: row.industry_code,
          industry_name: row.industry_name,
          change_pct: row.change_pct ?? undefined,
          main_inflow: row.main_inflow ?? undefined,
          main_inflow_ratio: row.main_inflow_ratio ?? undefined,
          limit_up_count: limitUpCount,
          leader_stock_code: row.leader_stock_code ?? undefined,
          leader_stock_name: row.leader_stock_name ?? undefined,
          leader_stock_change_pct: row.leader_stock_change_pct ?? undefined,
          advancing_count: row.advancing_count ?? undefined,
          declining_count: row.declining_count ?? undefined,
          source: 'akshare',
          raw_payload: row.raw_payload ?? {},
        };
      });

      await IndustryFlow.bulkCreate(records, {
        updateOnDuplicate: [
          'industry_name',
          'change_pct',
          'main_inflow',
          'main_inflow_ratio',
          'limit_up_count',
          'leader_stock_code',
          'leader_stock_name',
          'leader_stock_change_pct',
          'advancing_count',
          'declining_count',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(
        `IndustryFlow: upserted ${records.length} rows for ${date} ` +
          `(industries_with_limit_ups=${withLimitUps}, with_leader=${withLeader})`
      );
      return {
        trade_date: date,
        fetched: rows.length,
        upserted: records.length,
        industries_with_limit_ups: withLimitUps,
        industries_with_leader: withLeader,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`IndustryFlow syncDate(${date}) failed: ${message}`);
      return {
        trade_date: date,
        fetched: 0,
        upserted: 0,
        industries_with_limit_ups: 0,
        industries_with_leader: 0,
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * 闭区间按日遍历（含两端），断点续传。
   * AKShare 在周末/节假日返回空池；这种情况记 fetched=0 的 detail，不计失败。
   */
  async syncRange(
    start: string,
    end: string,
    options: SyncRangeOptions = {}
  ): Promise<SyncRangeResult> {
    const skipExisting = options.skipExisting ?? process.env.INDUSTRY_FLOW_SKIP_EXISTING !== '0';

    const startDate = parseIsoDate(start);
    const endDate = parseIsoDate(end);
    if (startDate > endDate) {
      throw new Error(`IndustryFlow syncRange: start ${start} after end ${end}`);
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
        const existing = await IndustryFlow.count({ where: { trade_date: iso } });
        if (existing > 0) {
          logger.info(`IndustryFlow: skip ${iso} (${existing} rows already present)`);
          details.push({
            trade_date: iso,
            fetched: 0,
            upserted: 0,
            industries_with_limit_ups: 0,
            industries_with_leader: 0,
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
   * 查同日 LimitUpStock 表所有涨停股票的 industry 分布，返回 行业名 → count 映射。
   *
   * 注意：LimitUpStock.industry 是 AKShare 在涨停股池里返回的"所属行业"字段，
   * 与 IndustryFlowClient 拉到的 `stock_sector_fund_flow_rank` 的"名称"字段口径
   * 通常一致（都是东财行业板块名）。少量边角行业可能不匹配——这种情况下
   * `limit_up_count` 会偏低（缺失行不在映射中），不会引入幻读。
   */
  private async loadLimitUpCountByIndustry(date: string): Promise<Map<string, number>> {
    const rows = (await LimitUpStock.findAll({
      attributes: ['industry'],
      where: {
        trade_date: date,
        industry: { [Op.ne]: null },
      },
      raw: true,
    })) as unknown as Array<{ industry: string | null }>;

    const counts = new Map<string, number>();
    for (const r of rows) {
      const ind = r.industry?.trim();
      if (!ind) continue;
      counts.set(ind, (counts.get(ind) ?? 0) + 1);
    }
    return counts;
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

export const industrySyncService = new IndustrySyncService();
