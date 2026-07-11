import { Column, DataType, Model, Table } from 'sequelize-typescript';

@Table({
  tableName: 'jpkr_financial_snapshot',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      name: 'uq_jpkr_financial_source_version',
      unique: true,
      fields: ['market_scope', 'ticker', 'source_document_id', 'source_version'],
    },
    {
      name: 'ix_jpkr_financial_ticker_period',
      fields: ['market_scope', 'ticker', 'fiscal_period_end', 'available_at_utc'],
    },
    {
      name: 'ix_jpkr_financial_pit',
      fields: ['market_scope', 'ticker', 'available_at_utc', 'source_version'],
    },
  ],
})
export class JpkrFinancialSnapshot extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
    field: 'jpkr_financial_snapshot_id',
  })
  declare jpkrFinancialSnapshotId: string;

  @Column({ type: DataType.STRING(8), allowNull: false, field: 'market_scope' })
  declare marketScope: 'jp' | 'kr';

  @Column({ type: DataType.TEXT, allowNull: true, field: 'provider_market_label' })
  declare providerMarketLabel: string | null;

  @Column({ type: DataType.STRING(32), allowNull: false, field: 'ticker' })
  declare ticker: string;

  // Database-generated from fiscal_period_end. allowNull=true disables
  // Sequelize's insert-side not-null validation; PostgreSQL always returns it.
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'fiscal_year' })
  declare readonly fiscalYear?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'fiscal_quarter' })
  declare fiscalQuarter: number | null;

  @Column({ type: DataType.DATEONLY, allowNull: true, field: 'fiscal_period_start' })
  declare fiscalPeriodStart: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'fiscal_period_end' })
  declare fiscalPeriodEnd: string;

  @Column({ type: DataType.STRING(16), allowNull: false, field: 'fiscal_period_kind' })
  declare fiscalPeriodKind: 'Q1' | 'Q3' | 'SEMIANNUAL' | 'ANNUAL';

  @Column({ type: DataType.TEXT, allowNull: false, field: 'currency' })
  declare currency: string;

  @Column({ type: DataType.BOOLEAN, allowNull: true, field: 'is_consolidated' })
  declare isConsolidated: boolean | null;

  @Column({ type: DataType.DECIMAL(28, 4), allowNull: true, field: 'revenue' })
  declare revenue: string | null;

  @Column({ type: DataType.DECIMAL(28, 8), allowNull: true, field: 'eps' })
  declare eps: string | null;

  @Column({ type: DataType.DECIMAL(28, 4), allowNull: true, field: 'net_income' })
  declare netIncome: string | null;

  @Column({ type: DataType.DECIMAL(28, 4), allowNull: true, field: 'total_assets' })
  declare totalAssets: string | null;

  @Column({ type: DataType.DECIMAL(28, 4), allowNull: true, field: 'total_equity' })
  declare totalEquity: string | null;

  @Column({ type: DataType.DECIMAL(28, 4), allowNull: true, field: 'total_liabilities' })
  declare totalLiabilities: string | null;

  @Column({ type: DataType.DECIMAL(28, 4), allowNull: true, field: 'operating_cash_flow' })
  declare operatingCashFlow: string | null;

  @Column({
    type: DataType.DECIMAL(28, 4),
    allowNull: true,
    field: 'research_and_development',
  })
  declare researchAndDevelopment: string | null;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'segment_facts' })
  declare segmentFacts: unknown[];

  @Column({ type: DataType.TEXT, allowNull: true, field: 'taxonomy_version' })
  declare taxonomyVersion: string | null;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'parser_version' })
  declare parserVersion: string;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'account_mapping_version' })
  declare accountMappingVersion: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'concept_provenance',
  })
  declare conceptProvenance: Record<string, unknown>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'parse_warnings',
  })
  declare parseWarnings: unknown[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'source_payload' })
  declare sourcePayload: Record<string, unknown>;

  @Column({ type: DataType.JSONB, allowNull: true, field: 'dim_quality' })
  declare dimQuality: Record<string, unknown> | null;

  @Column({ type: DataType.JSONB, allowNull: true, field: 'dim_growth' })
  declare dimGrowth: Record<string, unknown> | null;

  @Column({ type: DataType.JSONB, allowNull: true, field: 'dim_valuation' })
  declare dimValuation: Record<string, unknown> | null;

  @Column({ type: DataType.JSONB, allowNull: true, field: 'dim_moat' })
  declare dimMoat: Record<string, unknown> | null;

  @Column({ type: DataType.JSONB, allowNull: true, field: 'dim_trend' })
  declare dimTrend: Record<string, unknown> | null;

  @Column({ type: DataType.JSONB, allowNull: true, field: 'dim_risk' })
  declare dimRisk: Record<string, unknown> | null;

  @Column({ type: DataType.DECIMAL(5, 2), allowNull: true, field: 'coverage_pct' })
  declare coveragePct: string | null;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'derivation_version' })
  declare derivationVersion: string | null;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'source_kind' })
  declare sourceKind: 'jpx-edinet' | 'dart';

  @Column({ type: DataType.TEXT, allowNull: false, field: 'source_document_id' })
  declare sourceDocumentId: string;

  @Column({ type: DataType.STRING(255), allowNull: false, field: 'source_version' })
  declare sourceVersion: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'effective_at_utc' })
  declare effectiveAtUtc: Date;

  @Column({ type: DataType.DATE, allowNull: false, field: 'available_at_utc' })
  declare availableAtUtc: Date;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'fact_hash' })
  declare factHash: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'created_at',
  })
  declare createdAt: Date;
}
