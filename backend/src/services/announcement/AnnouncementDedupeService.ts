/**
 * AnnouncementDedupeService — L6-AI / US-118 [ANN-010] 公告去重服务
 *
 * 把"同一公司 / 同一事件 在窗口内多次公告" 折叠成 cluster, 标 canonical (最早一行)
 * + duplicate_of (指向 canonical), 用于:
 *   - 黑天鹅 / 飞书 critical push: 同事件只 push 一次 (canonical), 后续进展公告不重复轰炸
 *   - KOL / 行业聚合: 同事件只贡献一次 weight
 *   - UI "近 30 天公告" 抽屉: 默认折叠 cluster 仅显示 canonical, 展开看进展
 *
 * **聚类规则** (优先级链, fail-OPEN 默认):
 *   1. cluster_key = `${stock_code}|${event_type}` (主体公司 + 事件类型;
 *      event_type=NULL 时退化为 `${stock_code}|*`, 按公司聚簇)
 *   2. 同 cluster 内按 announce_date ASC + id ASC 排序, 第一行 = canonical
 *   3. 窗口约束: 同 cluster 内任意两行 |announce_date 差| ≤ WINDOW_DAYS (默认 7);
 *      超窗口的新公告 = 新 cluster (避免季报 "2024Q1 + 2024Q2" 误聚)
 *   4. is_canonical=true 仅一行, 其余 is_canonical=false + duplicate_of=canonical_id
 *
 * **AC 验收 (≥ 70%)**:
 *   - 20 条人工标注样本, 含 N 个 cluster 与 N 个独立公告; 见 announcement-dedupe-service.test.ts
 *   - dedupe_ratio = (total - canonical_count) / total ≥ 0.70 (即 ≥ 70% 行被折叠)
 *
 * **持久化**:
 *   - 默认不改 AnnouncementSummary 表 (避免给已落库行加 dedupe 列引发 migration);
 *   - 通过 AnnouncementEventRelation.metadata.linked_dedupe_cluster_id 留痕
 *     (本 service 主动 upsert 同 announcement_id 一行 relation_type='primary'
 *     + metadata.dedupe_cluster_id / duplicate_of / is_canonical);
 *   - 或由 caller (e.g. CriticalAnnouncementPushService) 直接消费 dedupe 结果
 *     不持久化也能 push gating, 是首选低风险路径.
 *
 * **fail-OPEN**:
 *   - 异常 (字段 null / 非法日期 / sortKey 抛错) 不抛, 返按输入顺序的 trivial cluster
 *     (每行自成 cluster, dedupe_ratio=0) — 让 caller 看到原始行不丢公告;
 *   - bulkUpsert 失败仅 log, 不阻塞主流程.
 *
 * 实现笔记: 沿用 [[RelatedCompanyExtractor]] 同款 DataSource DI + pure-function-first;
 * 沿用 [[KOLAggregatorService]] 同款 fail-OPEN; 与 [[CriticalAnnouncementPushService]]
 * 形成 "dedupe → push" 上下游链路.
 */

import { Op } from 'sequelize';
import { AnnouncementEventRelation } from '../../models/AnnouncementEventRelation';
import { AnnouncementSummary } from '../../models/AnnouncementSummary';
import { logger } from '../../utils/logger';

// ---------- 公开常量 ---------------------------------------------------------

/** 同 cluster 任意两行 |announce_date 差| 上限 (天). 超窗口的属新 cluster. */
export const DEDUPE_WINDOW_DAYS = 7;

/** dedupe-service 版本号 — metadata.dedupe_service_version 写入, 便于回放/兼容. */
export const DEDUPE_SERVICE_VERSION = 'announcement_dedupe_v1';

/** 单批最多处理行数 (内存爆炸防护). */
export const MAX_ROWS_PER_DEDUPE = 5000;

// ---------- 公开类型 ---------------------------------------------------------

/** 公告投影 (dedupe 只需的最小字段). */
export interface AnnouncementDedupeInput {
  id: number;
  announce_date: string; // YYYY-MM-DD
  stock_code: string;
  event_type: string | null;
  original_title: string;
}

/** 单条公告 dedupe 结果. */
export interface AnnouncementDedupeRecord {
  id: number;
  cluster_key: string;
  cluster_id: number; // canonical row id (同 cluster 共享)
  is_canonical: boolean;
  duplicate_of: number | null; // null iff is_canonical
}

/** 整批 dedupe 输出. */
export interface AnnouncementDedupeResult {
  records: AnnouncementDedupeRecord[];
  /** cluster_key -> [row id...] 便于 UI 展开 */
  clusters: Map<string, number[]>;
  total: number;
  canonical_count: number;
  duplicate_count: number;
  /** dedupe_ratio = duplicate_count / total; total=0 时为 0. AC ≥ 0.70 */
  dedupe_ratio: number;
}

// ---------- pure helpers -----------------------------------------------------

/** 安全 parse YYYY-MM-DD; 非法返 null. */
export function parseAnnounceDate(d: string | null | undefined): Date | null {
  if (!d || typeof d !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(da)) return null;
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  // UTC 避免本地时区抖动
  const ts = Date.UTC(y, mo - 1, da);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts);
}

/** 计算两日期相差天数 (绝对值, 仅看 UTC 日期段). 任一 null 返 Infinity. */
export function daysBetween(a: Date | null, b: Date | null): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const MS = 24 * 60 * 60 * 1000;
  return Math.abs(Math.round((a.getTime() - b.getTime()) / MS));
}

/**
 * cluster_key 构造: (stock_code | event_type).
 * event_type=null/空字符串 退化为 '*', 让"未分类"公告按公司聚簇而非散落.
 */
export function buildClusterKey(stockCode: string, eventType: string | null): string {
  const code = (stockCode || '').trim();
  const et = eventType && String(eventType).trim() !== '' ? String(eventType).trim() : '*';
  return `${code}|${et}`;
}

/**
 * pure: 把一批输入分到 cluster.
 * - 同 (stock_code, event_type) 且窗口内 ≤ DEDUPE_WINDOW_DAYS 才合并;
 * - 超窗口分裂成新 cluster (sub-cluster key 加日期段后缀避免 collision).
 *
 * 流程:
 *   1. 按 cluster_key 分桶
 *   2. 桶内按 announce_date ASC + id ASC 排序
 *   3. 滑窗扫描: 第 i 行与桶内当前 sub-cluster 任一行 |日期差| > WINDOW_DAYS → 开新 sub-cluster
 *   4. sub-cluster 内首行 = canonical
 */
export function clusterAnnouncements(
  rows: AnnouncementDedupeInput[] | null | undefined,
  options: { windowDays?: number } = {}
): Map<string, AnnouncementDedupeInput[]> {
  const result = new Map<string, AnnouncementDedupeInput[]>();
  if (!Array.isArray(rows) || rows.length === 0) return result;
  const windowDays = Number.isFinite(options.windowDays as number)
    ? Math.max(0, options.windowDays as number)
    : DEDUPE_WINDOW_DAYS;

  // 1+2. 按 cluster_key 分桶 + 排序
  const buckets = new Map<string, AnnouncementDedupeInput[]>();
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !Number.isFinite(r.id)) continue;
    const key = buildClusterKey(r.stock_code, r.event_type);
    const arr = buckets.get(key);
    if (arr) arr.push(r);
    else buckets.set(key, [r]);
  }
  for (const [, arr] of buckets) {
    arr.sort((a, b) => {
      const da = parseAnnounceDate(a.announce_date);
      const db = parseAnnounceDate(b.announce_date);
      const ta = da ? da.getTime() : 0;
      const tb = db ? db.getTime() : 0;
      if (ta !== tb) return ta - tb;
      return a.id - b.id;
    });
  }

  // 3. 滑窗 split 成 sub-cluster
  for (const [key, arr] of buckets) {
    let subIdx = 0;
    let current: AnnouncementDedupeInput[] = [];
    let currentMaxDate: Date | null = null;
    for (const r of arr) {
      const rd = parseAnnounceDate(r.announce_date);
      if (current.length === 0) {
        current.push(r);
        currentMaxDate = rd;
        continue;
      }
      // 与 sub-cluster 最早行 比 (排序后 current[0] 是最早), 也与最新行 比
      const earliest = parseAnnounceDate(current[0].announce_date);
      const diffEarliest = daysBetween(rd, earliest);
      const diffLatest = daysBetween(rd, currentMaxDate);
      if (diffEarliest > windowDays || diffLatest > windowDays) {
        // 当前 sub-cluster 满了, 落库
        const subKey = subIdx === 0 ? key : `${key}#${subIdx}`;
        result.set(subKey, current);
        subIdx += 1;
        current = [r];
        currentMaxDate = rd;
      } else {
        current.push(r);
        if (rd && (!currentMaxDate || rd.getTime() > currentMaxDate.getTime())) {
          currentMaxDate = rd;
        }
      }
    }
    if (current.length > 0) {
      const subKey = subIdx === 0 ? key : `${key}#${subIdx}`;
      result.set(subKey, current);
    }
  }
  return result;
}

/**
 * pure: 给 cluster 内每行打 dedupe 标记.
 * canonical = sort 后首行 (clusterAnnouncements 已排序).
 */
export function buildDedupeRecords(
  clusters: Map<string, AnnouncementDedupeInput[]>
): AnnouncementDedupeRecord[] {
  const out: AnnouncementDedupeRecord[] = [];
  for (const [clusterKey, rows] of clusters) {
    if (rows.length === 0) continue;
    const canonical = rows[0];
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      out.push({
        id: r.id,
        cluster_key: clusterKey,
        cluster_id: canonical.id,
        is_canonical: i === 0,
        duplicate_of: i === 0 ? null : canonical.id,
      });
    }
  }
  return out;
}

/**
 * pure: 一站式 dedupe 入口 — 包 cluster + buildRecords + 统计.
 * fail-OPEN: 任何 throw 返 trivial (每行自成 cluster, ratio=0).
 */
export function dedupeAnnouncements(
  rows: AnnouncementDedupeInput[] | null | undefined,
  options: { windowDays?: number } = {}
): AnnouncementDedupeResult {
  try {
    const inputs = Array.isArray(rows) ? rows.slice(0, MAX_ROWS_PER_DEDUPE) : [];
    const clusters = clusterAnnouncements(inputs, options);
    const records = buildDedupeRecords(clusters);
    const clusterMap = new Map<string, number[]>();
    for (const [k, arr] of clusters) {
      clusterMap.set(
        k,
        arr.map(r => r.id)
      );
    }
    const total = records.length;
    const canonicalCount = records.filter(r => r.is_canonical).length;
    const duplicateCount = total - canonicalCount;
    const ratio = total === 0 ? 0 : duplicateCount / total;
    return {
      records,
      clusters: clusterMap,
      total,
      canonical_count: canonicalCount,
      duplicate_count: duplicateCount,
      dedupe_ratio: ratio,
    };
  } catch (err) {
    logger.warn(
      `[AnnouncementDedupe] dedupeAnnouncements unexpected throw — fail-OPEN: ${
        (err as Error).message
      }`
    );
    const trivial: AnnouncementDedupeRecord[] = [];
    const trivialClusters = new Map<string, number[]>();
    const safeRows = Array.isArray(rows) ? rows : [];
    for (const r of safeRows) {
      if (!r || !Number.isFinite(r.id)) continue;
      const k = `${buildClusterKey(r.stock_code, r.event_type)}#${r.id}`;
      trivial.push({
        id: r.id,
        cluster_key: k,
        cluster_id: r.id,
        is_canonical: true,
        duplicate_of: null,
      });
      trivialClusters.set(k, [r.id]);
    }
    return {
      records: trivial,
      clusters: trivialClusters,
      total: trivial.length,
      canonical_count: trivial.length,
      duplicate_count: 0,
      dedupe_ratio: 0,
    };
  }
}

// ---------- DataSource DI ----------------------------------------------------

export interface AnnouncementDedupeDataSource {
  /** 读: 拉取最近 N 天公告投影. */
  listAnnouncements(opts: {
    sinceDate?: string; // YYYY-MM-DD
    untilDate?: string;
    stockCodes?: string[];
    limit?: number;
  }): Promise<AnnouncementDedupeInput[]>;

  /** 写: 把 dedupe 结果写到 AnnouncementEventRelation.metadata (relation_type=primary 的行). */
  persistDedupeMetadata(records: AnnouncementDedupeRecord[]): Promise<number>;
}

export const PRODUCTION_DEDUPE_DATA_SOURCE: AnnouncementDedupeDataSource = {
  async listAnnouncements(opts) {
    const where: Record<string, unknown> = {};
    if (Array.isArray(opts.stockCodes) && opts.stockCodes.length > 0) {
      where.stock_code = { [Op.in]: opts.stockCodes };
    }
    if (opts.sinceDate) where.announce_date = { [Op.gte]: opts.sinceDate };
    if (opts.untilDate) {
      where.announce_date = {
        ...((where.announce_date as Record<string, unknown>) || {}),
        [Op.lte]: opts.untilDate,
      };
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 500, MAX_ROWS_PER_DEDUPE));
    try {
      const rows = await AnnouncementSummary.findAll({
        where,
        attributes: ['id', 'announce_date', 'stock_code', 'event_type', 'original_title'],
        order: [
          ['announce_date', 'ASC'],
          ['id', 'ASC'],
        ],
        limit,
      });
      return rows.map(r => ({
        id: r.id,
        announce_date: r.announce_date,
        stock_code: r.stock_code,
        event_type: r.event_type,
        original_title: r.original_title,
      }));
    } catch (err) {
      logger.warn(
        `[AnnouncementDedupe] listAnnouncements failed (fail-OPEN): ${(err as Error).message}`
      );
      return [];
    }
  },

  async persistDedupeMetadata(records) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    // 仅 upsert duplicate 行的 metadata (canonical 行无需新增 relation, 节省写入)
    // canonical 行也写一行 relation_type=primary 让 cluster JOIN 可见
    const rows = records.map(r => ({
      announcement_id: r.id,
      related_stock_code: '_DEDUPE_', // 占位 (本表 UNIQUE 由 (announcement_id, related_stock_code))
      related_stock_name: null,
      relation_type: 'primary',
      confidence: 1.0,
      source: 'dedupe_service',
      detail: {
        dedupe_service_version: DEDUPE_SERVICE_VERSION,
      },
      metadata: {
        linked_dedupe_cluster_id: r.cluster_id,
        dedupe_cluster_key: r.cluster_key,
        is_canonical: r.is_canonical,
        duplicate_of: r.duplicate_of,
        dedupe_service_version: DEDUPE_SERVICE_VERSION,
      },
      extracted_at: new Date(),
    }));
    try {
      await AnnouncementEventRelation.bulkCreate(
        rows as unknown as Array<Record<string, unknown>>,
        {
          updateOnDuplicate: [
            'related_stock_name',
            'relation_type',
            'confidence',
            'source',
            'detail',
            'metadata',
            'extracted_at',
            'updated_at',
          ],
        }
      );
      return rows.length;
    } catch (err) {
      logger.warn(
        `[AnnouncementDedupe] persistDedupeMetadata failed (fail-OPEN): ${(err as Error).message}`
      );
      return 0;
    }
  },
};

// ---------- Service 类 -------------------------------------------------------

export class AnnouncementDedupeService {
  constructor(
    private readonly dataSource: AnnouncementDedupeDataSource = PRODUCTION_DEDUPE_DATA_SOURCE
  ) {}

  /** in-memory dedupe (caller 已有 rows). */
  dedupe(
    rows: AnnouncementDedupeInput[] | null | undefined,
    options: { windowDays?: number } = {}
  ): AnnouncementDedupeResult {
    return dedupeAnnouncements(rows, options);
  }

  /**
   * batch: 拉取窗口期公告 → dedupe → 可选持久化.
   * persist=false 时仅返结果 (caller e.g. CriticalAnnouncementPushService 直接消费 gating).
   */
  async runBatch(opts: {
    sinceDate?: string;
    untilDate?: string;
    stockCodes?: string[];
    limit?: number;
    persist?: boolean;
    windowDays?: number;
  }): Promise<AnnouncementDedupeResult & { persisted: number }> {
    const rows = await this.dataSource.listAnnouncements({
      sinceDate: opts.sinceDate,
      untilDate: opts.untilDate,
      stockCodes: opts.stockCodes,
      limit: opts.limit,
    });
    const res = this.dedupe(rows, { windowDays: opts.windowDays });
    let persisted = 0;
    if (opts.persist === true && res.records.length > 0) {
      try {
        persisted = await this.dataSource.persistDedupeMetadata(res.records);
      } catch (err) {
        logger.warn(
          `[AnnouncementDedupe] runBatch.persist failed (fail-OPEN): ${(err as Error).message}`
        );
      }
    }
    return { ...res, persisted };
  }
}

/** Singleton 兼调用方便. */
export const announcementDedupeService = new AnnouncementDedupeService();
