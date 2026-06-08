import { ShareholderTradeRecord } from '../../models/ShareholderTradeRecord';
import { logger } from '../../utils/logger';
import {
  ShareholderTradeClient,
  ShareholderTradeRow,
  ShareholderTradeSymbol,
  shareholderTradeClient,
} from '../sources/ShareholderTradeClient';

/**
 * 股东增减持公告入库服务 — US-090 数据层.
 *
 * AKShare `stock_ggcg_em(symbol='全部')` 是 real-time-only 快照端点 (无日期参数,
 * 单次调用返回 ~140k 行近 N 月全市场公告). 本服务面向 **单次快照** 同步:
 *
 *   - `syncSnapshot(symbol)` — 拉一次全市场快照 + bulkCreate upsert (idempotent)
 *
 * **PK = (announce_date, stock_code, shareholder_name, trade_direction,
 *         change_start_date) 五元组**: 同一公告里 N 个股东同步增减持 → shareholder_name in PK;
 * 同一股东可能 N 月内多次增持 + 减持交替 → trade_direction in PK 防混淆;
 * 同一股东同一公告里若分批 → change_start_date in PK; announce_date 作为时序入口.
 *
 * **bulkCreate + updateOnDuplicate + in-memory dedup**: 跨方言一致的幂等行为
 * (与 US-030 AnalystForecast / US-089 RestrictedShare 同款 dialect-independent dedup).
 *
 * **shareholder_type 启发式分类** (在 TS 服务做, 不在 Python 做 — 同款
 * "TS 业务推理 + Python dumb fetcher" 范式见 US-006 is_famous_yz / US-088 seat_type):
 *
 *   - **机构投资者**: 名称含 '基金' / '信托' / '资产' / '资本' / '投资' / '股份' /
 *                   '合伙企业' / '有限合伙' / '私募' / '证券' / '保险' / 'QFII' / 'RQFII' /
 *                   '产业基金' / '产业投资' / '集团' / 'pte' / 'fund' / 'capital'
 *   - **高管**:       与 ShareholderTradeRecord 同公司董监高 (通过 raw_payload 的
 *                   "高管职务" 字段判断 — 若 AKShare 后续补此字段就用; 当前仅
 *                   fallback 到 isFullChineseName + 名称 length 2-4 且与公司名相同
 *                   姓氏关联), 当前数据集中 fallback 为 '自然人'
 *   - **自然人**:    isFullChineseName == true 且不命中机构关键词
 *   - **其他**:      未能归类 (e.g. 名称为空 / 单字符 / 含特殊字符)
 *
 *   分类规则在本服务集中维护 — 未来加新模式只改 classifyShareholderType 一处,
 *   不需要重新调用 AKShare. 单测覆盖核心边界.
 */
export interface SyncSnapshotResult {
  symbol: ShareholderTradeSymbol;
  fetched: number;
  upserted: number;
  /** in-memory dedup 后真正落库的行数 (< fetched 时记录 dedup_dropped) */
  dedup_dropped: number;
  /** 5 类 shareholder_type 分布 (debug / monitoring 用) */
  shareholder_type_distribution: Record<string, number>;
  error?: string;
}

/** 机构关键词白名单 (大小写不敏感) */
export const INSTITUTION_KEYWORDS: readonly string[] = [
  '基金',
  '信托',
  '资产管理',
  '资本',
  '投资管理',
  '投资合伙',
  '股份',
  '合伙企业',
  '有限合伙',
  '私募',
  '证券',
  '保险',
  '产业基金',
  '产业投资',
  '集团',
  '银行',
  '财务公司',
  '资产',
  'qfii',
  'rqfii',
  'pte',
  'ltd',
  'fund',
  'capital',
  'investment',
];

/**
 * 启发式分类 shareholder_name → shareholder_type.
 *
 * 优先级 (短路返回):
 *   1. 空 / null / 单字符 → '其他'
 *   2. 命中机构关键词 → '机构投资者'
 *   3. 全中文 2-4 字 (典型自然人姓名) → '自然人'
 *   4. fallback → '其他'
 *
 * 注: '高管' 类目前无法从 AKShare 当前字段稳定识别 (无"高管职务"原文列), 暂保留
 * 类型签名但永不返回, 留待后续 endpoint 升级时再启用 (升级路径). 单测显式覆盖.
 */
export function classifyShareholderType(
  name: string | null | undefined
): '机构投资者' | '自然人' | '高管' | '其他' {
  if (!name) return '其他';
  const trimmed = String(name).trim();
  if (trimmed.length === 0 || trimmed.length === 1) return '其他';

  const lower = trimmed.toLowerCase();
  for (const keyword of INSTITUTION_KEYWORDS) {
    if (lower.includes(keyword)) return '机构投资者';
  }

  // 全中文 2-4 字典型自然人姓名 (姓 1 字 + 名 1-3 字)
  // 包含繁体中文 字符范围 一-鿿
  const cnRegex = /^[一-鿿]{2,4}$/;
  if (cnRegex.test(trimmed)) return '自然人';

  return '其他';
}

export class ShareholderTradeSyncService {
  private client: ShareholderTradeClient;

  constructor(client: ShareholderTradeClient = shareholderTradeClient) {
    this.client = client;
  }

  /**
   * 同步股东增减持公告全快照 (idempotent).
   *
   * @param symbol 默认 '全部'; 业务推荐每日全跑一次, 通过 trade_direction 列分流.
   */
  async syncSnapshot(symbol: ShareholderTradeSymbol = '全部'): Promise<SyncSnapshotResult> {
    try {
      const rows = await this.client.fetchSnapshot(symbol);
      if (rows.length === 0) {
        logger.warn(
          `ShareholderTrade: no data returned for symbol=${symbol}, marking as empty success`
        );
        return {
          symbol,
          fetched: 0,
          upserted: 0,
          dedup_dropped: 0,
          shareholder_type_distribution: {},
        };
      }

      // ----- 服务层 in-memory dedup -----
      // PK = (announce_date, stock_code, shareholder_name, trade_direction, change_start_date)
      // 跨方言一致的 idempotent 行为 (Postgres 静默覆盖 / MySQL 在 batch 内 dup 抛错).
      // 同 US-030 / US-089 范式.
      const seen = new Map<string, ShareholderTradeRow>();
      let dedupDropped = 0;
      for (const row of rows) {
        const startDate = row.change_start_date || '1970-01-01';
        const key = `${row.announce_date}::${row.stock_code}::${row.shareholder_name}::${row.trade_direction}::${startDate}`;
        if (seen.has(key)) {
          dedupDropped += 1;
          continue;
        }
        seen.set(key, row);
      }
      if (dedupDropped > 0) {
        logger.warn(
          `ShareholderTrade: dropped ${dedupDropped} in-batch duplicate PKs for symbol=${symbol}`
        );
      }

      // ----- shareholder_type 启发式分类 + records 组装 -----
      const typeCounter: Record<string, number> = {};
      const records = Array.from(seen.values()).map((row: ShareholderTradeRow) => {
        const shareholderType = classifyShareholderType(row.shareholder_name);
        typeCounter[shareholderType] = (typeCounter[shareholderType] ?? 0) + 1;
        return {
          announce_date: row.announce_date,
          stock_code: row.stock_code,
          shareholder_name: row.shareholder_name,
          trade_direction: row.trade_direction,
          change_start_date: row.change_start_date || '1970-01-01',
          stock_name: row.stock_name ?? undefined,
          trade_shares: row.trade_shares ?? 0,
          trade_amount: row.trade_amount ?? 0,
          shareholder_type: shareholderType,
          latest_price: row.latest_price ?? undefined,
          pct_of_total_shares: row.pct_of_total_shares ?? undefined,
          pct_of_float_shares: row.pct_of_float_shares ?? undefined,
          post_hold_shares: row.post_hold_shares ?? undefined,
          change_end_date: row.change_end_date ?? undefined,
          source: 'akshare',
          raw_payload: row.raw_payload ?? {},
        };
      });

      await ShareholderTradeRecord.bulkCreate(records, {
        updateOnDuplicate: [
          'stock_name',
          'trade_shares',
          'trade_amount',
          'shareholder_type',
          'latest_price',
          'pct_of_total_shares',
          'pct_of_float_shares',
          'post_hold_shares',
          'change_end_date',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(
        `ShareholderTrade: upserted ${records.length} rows for symbol=${symbol}` +
          (dedupDropped > 0 ? ` (dedup_dropped=${dedupDropped})` : '') +
          ` | dist=${JSON.stringify(typeCounter)}`
      );

      return {
        symbol,
        fetched: rows.length,
        upserted: records.length,
        dedup_dropped: dedupDropped,
        shareholder_type_distribution: typeCounter,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`ShareholderTrade syncSnapshot(symbol=${symbol}) failed: ${message}`);
      return {
        symbol,
        fetched: 0,
        upserted: 0,
        dedup_dropped: 0,
        shareholder_type_distribution: {},
        error: message,
      };
    }
  }
}

export const shareholderTradeSyncService = new ShareholderTradeSyncService();
