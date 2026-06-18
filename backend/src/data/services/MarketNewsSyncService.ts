import crypto from 'crypto';
import { Op } from 'sequelize';
import { MarketNews } from '../../models/MarketNews';
import { logger } from '../../utils/logger';
import { MarketNewsClient, MarketNewsRow, marketNewsClient } from '../sources/MarketNewsClient';

/**
 * MarketNewsSyncService — Batch AG (2026-06-18).
 *
 * `syncOnce()` 拉一次市场要闻 (财联社电报 + 东财全球 + 新浪) → 去重 → 入库.
 *
 * **AKShare 实时快照特性 (与 US-058 SnowballHotKeyword 同款)**: 接口无日期参数,
 * 调用返回 "当下时刻 / 近 N 小时" 的全市场要闻. 由 SchedulerService 高频 cron
 * (建议每 30min 一次盘中, 每 1h 盘外) 调用 syncOnce 累积形成事件流.
 *
 * **去重策略**: 主键 (publish_time, title_hash), title_hash = MD5(title.trim())
 * 前 16 字符. `bulkCreate + updateOnDuplicate(['content','source','category','url'])`
 * upsert 让同一条新闻的不同 source 后到时不重复入库 (但允许刷新 content / url).
 *
 * **保留期**: `pruneOld(days=30)` 删除 publish_date < today-N 的行,
 * 默认 30 天. 调用方在 SchedulerService 里日级跑一次.
 *
 * **失败兜底**: 单次 fetch 失败不抛, 返回 `SyncOnceResult.error`.
 */
export interface SyncOnceResult {
  fetched: number;
  upserted: number;
  skipped: number; // publish_time 缺失等
  error?: string;
}

export interface SyncOnceOptions {
  /** 拉取行数上限 (传给 client + Python helper), 默认 80 */
  limit?: number;
}

export interface PruneResult {
  before_date: string;
  deleted: number;
}

export class MarketNewsSyncService {
  private client: MarketNewsClient;

  constructor(client: MarketNewsClient = marketNewsClient) {
    this.client = client;
  }

  /**
   * 拉一次市场要闻并 upsert.
   */
  async syncOnce(options: SyncOnceOptions = {}): Promise<SyncOnceResult> {
    const limit = Math.max(1, Math.min(200, options.limit ?? 80));
    try {
      const rows = await this.client.fetchNews(limit);
      if (rows.length === 0) {
        return { fetched: 0, upserted: 0, skipped: 0 };
      }

      // 转 row 为 sequelize attr; 略过 publish_time 缺失行
      const records: Array<Record<string, any>> = [];
      let skipped = 0;
      const seen = new Set<string>(); // (title_hash, publish_time) in-memory dedup
      for (const r of rows) {
        const titleTrimmed = (r.title || '').trim();
        if (!titleTrimmed) {
          skipped += 1;
          continue;
        }
        const publishTime = parsePublishTime(r.publish_time);
        if (!publishTime) {
          skipped += 1;
          continue;
        }
        const titleHash = md5Hash16(titleTrimmed);
        const key = `${titleHash}|${publishTime.toISOString()}`;
        if (seen.has(key)) {
          continue; // in-memory dedup, avoid dialect-dependent bulkCreate UNIQUE
        }
        seen.add(key);

        records.push({
          title_hash: titleHash,
          publish_time: publishTime,
          publish_date: toISODate(publishTime),
          title: titleTrimmed.slice(0, 510), // STRING(512) 安全余量
          content: (r.content || '').slice(0, 4000) || null,
          source: r.source || 'cls',
          category: r.category || null,
          url: r.url || null,
          raw_payload: r.raw_payload || {},
        });
      }

      if (records.length === 0) {
        return { fetched: rows.length, upserted: 0, skipped };
      }

      await MarketNews.bulkCreate(records as any, {
        updateOnDuplicate: [
          'title',
          'content',
          'source',
          'category',
          'url',
          'raw_payload',
          'updated_at',
        ],
      });
      logger.info(
        `MarketNews syncOnce: fetched=${rows.length}, upserted=${records.length}, skipped=${skipped}`
      );
      return { fetched: rows.length, upserted: records.length, skipped };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`MarketNews syncOnce failed: ${message}`);
      return { fetched: 0, upserted: 0, skipped: 0, error: message };
    }
  }

  /**
   * 删除 publish_date 早于 (today - retentionDays) 的行.
   * @param retentionDays 默认 30 天.
   */
  async pruneOld(retentionDays = 30): Promise<PruneResult> {
    const days = Math.max(1, Math.min(365, Math.floor(retentionDays)));
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const cutoffDate = toISODate(cutoff);
    const deleted = await MarketNews.destroy({
      where: { publish_date: { [Op.lt]: cutoffDate } },
    });
    logger.info(`MarketNews pruneOld: deleted=${deleted} rows older than ${cutoffDate}`);
    return { before_date: cutoffDate, deleted };
  }
}

// ---------- helpers --------------------------------------------------------

function md5Hash16(s: string): string {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex').slice(0, 16);
}

function toISODate(d: Date): string {
  // YYYY-MM-DD in local time (cron 调度时区一致即可, 不强制 UTC 避免午夜偏差)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 财联社/东财/新浪格式参差: 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DD' / 'MM-DD HH:mm' / 'HH:mm'.
 *  返回 Date 或 null. 缺日期补今日, 缺时间补当前小时. */
function parsePublishTime(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Case 1: full ISO 'YYYY-MM-DD HH:mm:ss' (or with T)
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const norm = s.replace('T', ' ');
    const d = new Date(norm.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Case 2: 'YYYY-MM-DD'
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Case 3: 'MM-DD HH:mm[:ss]' — 假设本年
  const m = s.match(/^(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const now = new Date();
    const yr = now.getFullYear();
    const d = new Date(
      yr,
      Number(m[1]) - 1,
      Number(m[2]),
      Number(m[3]),
      Number(m[4]),
      Number(m[5] || '0')
    );
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Case 4: 'HH:mm' — 当日
  const hm = s.match(/^(\d{2}):(\d{2})$/);
  if (hm) {
    const now = new Date();
    const d = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Number(hm[1]),
      Number(hm[2])
    );
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // 兜底: Date 直接 parse
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const marketNewsSyncService = new MarketNewsSyncService();
