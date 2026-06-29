import { Table, Column, Model, DataType, CreatedAt } from 'sequelize-typescript';

/**
 * IntradayKline30Min — PR-M2 (2026-06-29)
 *
 * **盘中 30-min K 线**, 一行 = (symbol, kline_time) OHLCV.
 *
 * 由 cron INTRADAY_KLINE_30MIN_SYNC 每 30min 盘中触发 (10:05/11:05/13:05/14:05/14:35),
 * 拉 universe ~500 票当日所有已结束的 30min bar → bulkCreate(updateOnDuplicate).
 *
 * 一天 8 根 30-min bar:
 *   - 09:30, 10:00, 10:30, 11:00, 13:00, 13:30, 14:00, 14:30 (Asia/Shanghai bar 起始)
 *   - 注: AKShare 返回的"时间"字段是 bar 结束时刻 (10:00 表示 9:30-10:00 那根),
 *     IntradayKlineSyncService.parseKlineTime 统一对齐到 30min 整点 (Asia/Shanghai),
 *     IntradayMomentumDetector 用 bar 结束时刻语义 (10:00 close 表示 9:30-10:00 那根).
 *
 * 给 IntradayMomentumDetector 消费:
 *   - Zhang/Ma/Zhu 2019 Economic Modelling (被引 109): r1 = 9:30-10:00 收益预测 r2 = 14:30-15:00.
 *   - "mainly evident in China" → A 股最 robust 日内 alpha.
 *
 * Migration: backend/scripts/migrations/2026-06-29-auction-and-30min-klines.sql
 */
@Table({
  tableName: 'intraday_klines_30min',
  timestamps: false,
  underscored: true,
  indexes: [
    { unique: true, fields: ['symbol', 'kline_time'], name: 'intraday_klines_30min_uk' },
    { fields: ['kline_time', 'symbol'], name: 'intraday_klines_30min_time_idx' },
  ],
})
export class IntradayKline30Min extends Model {
  @Column({ type: DataType.BIGINT, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'kline_time' })
  declare kline_time: Date;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true })
  declare open?: number | string | null;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true })
  declare high?: number | string | null;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true })
  declare low?: number | string | null;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true })
  declare close?: number | string | null;

  @Column({ type: DataType.BIGINT, allowNull: true })
  declare volume?: number | string | null;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true })
  declare money?: number | string | null;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;
}
