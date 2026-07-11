import { Column, DataType, Model, Table } from 'sequelize-typescript';

@Table({
  tableName: 'jpkr_daily_kline',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      name: 'uq_jpkr_kline_identity',
      unique: true,
      fields: ['exchange', 'ticker', 'trading_day', 'source_kind', 'source_version'],
    },
    {
      name: 'ix_jpkr_kline_exchange_day',
      fields: ['exchange', 'trading_day'],
    },
    {
      name: 'ix_jpkr_kline_ticker_day',
      fields: ['market_scope', 'ticker', 'trading_day', 'ingested_at'],
    },
    {
      name: 'ix_jpkr_kline_pit',
      fields: ['available_at_utc', 'effective_at_utc'],
    },
  ],
})
export class JpkrDailyKline extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
    field: 'jpkr_daily_kline_id',
  })
  declare jpkrDailyKlineId: string;

  @Column({ type: DataType.STRING(8), allowNull: false, field: 'market_scope' })
  declare marketScope: 'jp' | 'kr';

  @Column({ type: DataType.TEXT, allowNull: true, field: 'provider_market_label' })
  declare providerMarketLabel: string | null;

  @Column({ type: DataType.STRING(16), allowNull: false, field: 'exchange' })
  declare exchange: 'tse' | 'ose' | 'krx' | 'kosdaq';

  @Column({ type: DataType.STRING(32), allowNull: false, field: 'ticker' })
  declare ticker: string;

  @Column({ type: DataType.STRING(255), allowNull: false, field: 'ticker_name_local' })
  declare tickerNameLocal: string;

  @Column({ type: DataType.STRING(255), allowNull: true, field: 'ticker_name_en' })
  declare tickerNameEn: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'trading_day' })
  declare tradingDay: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'effective_at_utc' })
  declare effectiveAtUtc: Date;

  @Column({ type: DataType.DATE, allowNull: false, field: 'available_at_utc' })
  declare availableAtUtc: Date;

  @Column({ type: DataType.DECIMAL(18, 4), allowNull: false, field: 'open' })
  declare open: string;

  @Column({ type: DataType.DECIMAL(18, 4), allowNull: false, field: 'high' })
  declare high: string;

  @Column({ type: DataType.DECIMAL(18, 4), allowNull: false, field: 'low' })
  declare low: string;

  @Column({ type: DataType.DECIMAL(18, 4), allowNull: false, field: 'close' })
  declare close: string;

  @Column({ type: DataType.DECIMAL(18, 4), allowNull: true, field: 'adjusted_close' })
  declare adjustedClose: string | null;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'corporate_action_version' })
  declare corporateActionVersion: string | null;

  @Column({ type: DataType.BIGINT, allowNull: false, field: 'volume' })
  declare volume: string;

  @Column({ type: DataType.DECIMAL(24, 4), allowNull: true, field: 'turnover' })
  declare turnover: string | null;

  @Column({ type: DataType.STRING(3), allowNull: false, field: 'currency' })
  declare currency: 'JPY' | 'KRW';

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'is_halted',
  })
  declare isHalted: boolean;

  @Column({ type: DataType.DECIMAL(18, 4), allowNull: true, field: 'dividend_amount' })
  declare dividendAmount: string | null;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'split_ratio' })
  declare splitRatio: string | null;

  @Column({ type: DataType.DECIMAL(28, 4), allowNull: true, field: 'market_cap_local' })
  declare marketCapLocal: string | null;

  @Column({ type: DataType.DECIMAL(12, 8), allowNull: true, field: 'turnover_rate' })
  declare turnoverRate: string | null;

  @Column({ type: DataType.STRING(64), allowNull: true, field: 'halt_reason_code' })
  declare haltReasonCode: string | null;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'source_kind' })
  declare sourceKind: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'source_document_id' })
  declare sourceDocumentId: string;

  @Column({ type: DataType.STRING(255), allowNull: false, field: 'source_version' })
  declare sourceVersion: string;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'fact_hash' })
  declare factHash: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'ingested_at',
  })
  declare ingestedAt: Date;
}
