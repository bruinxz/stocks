import { Table, Column, Model, DataType, CreatedAt } from 'sequelize-typescript';

/**
 * AuctionSnapshot — PR-M2 (2026-06-29)
 *
 * **集合竞价 9:15-9:25 后的开盘快照**. 一行 = (trade_date, symbol) 二元组.
 *
 * 由 cron AUCTION_SNAPSHOT_SYNC 每日 9:25 触发, 对 ~500 票 universe (持仓 + 自选 +
 * 涨停池 + 近 30 日推荐过) 拉一次 stock_zh_a_spot_em 拿开盘价 + 量 + 昨收, 计算
 * 7 大战法 pattern → bulkCreate 写入.
 *
 * 给 OpeningRushDetector / 任意"开盘异动"消费方使用.
 *
 * pattern 值域 (与 AuctionSnapshotSyncService.classifyAuctionPattern 严格对齐):
 *   - one_word           — 一字板 (9:15 即封涨停, 全天封单不撤)
 *   - t_word             — T 字板 (开盘涨停后开板回落)  [需 intraday 数据, 本表暂不识别]
 *   - low_open_v         — 低开 V 型反弹 [需 intraday 数据]
 *   - high_open_volume   — 高开巨量 (≥ +3% 高开 且 open_volume 显著)
 *   - shrink_limit       — 缩量涨停 (one_word 子类, 留扩展)
 *   - northbound_block   — 北向竞价大单 [TODO 接 KOL 北向数据]
 *   - gap_up             — 高开 [+1% ~ +3%) (轻度高开)
 *   - gap_down           — 低开 (≤ -1%)
 *   - normal             — 平开
 *
 * Migration: backend/scripts/migrations/2026-06-29-auction-and-30min-klines.sql
 */
@Table({
  tableName: 'auction_snapshots',
  timestamps: false,
  underscored: true,
  indexes: [
    { unique: true, fields: ['trade_date', 'symbol'], name: 'auction_snapshots_uk' },
    { fields: ['trade_date', 'pattern'], name: 'idx_auction_snapshots_date_pattern' },
  ],
})
export class AuctionSnapshot extends Model {
  @Column({ type: DataType.BIGINT, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'trade_date' })
  declare trade_date: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(80), allowNull: true })
  declare name?: string | null;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true, field: 'open_price' })
  declare open_price?: number | string | null;

  @Column({ type: DataType.BIGINT, allowNull: true, field: 'open_volume' })
  declare open_volume?: number | string | null;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true, field: 'open_amount' })
  declare open_amount?: number | string | null;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true, field: 'prev_close' })
  declare prev_close?: number | string | null;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'open_change_pct' })
  declare open_change_pct?: number | string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_limit_up' })
  declare is_limit_up: boolean;

  @Column({ type: DataType.STRING(40), allowNull: false, defaultValue: 'normal' })
  declare pattern: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'raw_payload' })
  declare raw_payload: Record<string, unknown>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;
}
