/**
 * MetaLabelDecision — Sprint 2A Meta-label 二层决策日志
 *
 * 每次对一个原始信号（来自策略 / AI / 推荐池）调用 MetaLabelService.shouldBet
 * 都写一行 — 用于：
 *   1. 复盘 "MetaLabel 拒绝过哪些后来涨的信号 / 通过过哪些后来跌的信号"
 *   2. 后续重训模型时这一行是 sample
 *   3. UI 显示 "MetaLabel 信心度" 让用户看到二层过滤的影响
 */
import { Table, Column, Model, DataType, CreatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'meta_label_decisions',
  timestamps: true,
  underscored: true,
  updatedAt: false,
  indexes: [
    { fields: ['signal_id'] },
    { fields: ['symbol', 'as_of_date'] },
    { fields: ['decision'] },
    { fields: ['strategy_key', 'created_at'] },
  ],
})
export class MetaLabelDecision extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  /** 原始信号 ID（AIInvestmentSignal.id 或 QuantSignal.id 等） */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'signal_id' })
  declare signal_id?: number | null;

  /** 信号源 (ai / quant / recommendation) */
  @Column({ type: DataType.STRING(40), allowNull: true, field: 'signal_source' })
  declare signal_source?: string | null;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(60), allowNull: true, field: 'strategy_key' })
  declare strategy_key?: string | null;

  @Column({ type: DataType.STRING(10), allowNull: false, field: 'as_of_date' })
  declare as_of_date: string;

  /** 原始 final_score 0-100 */
  @Column({ type: DataType.DECIMAL(8, 4), allowNull: true, field: 'original_score' })
  declare original_score?: number | null;

  /** MetaLabel 输出 confidence ∈ [0, 1] = P(profit > 0 | features) */
  @Column({ type: DataType.DECIMAL(8, 6), allowNull: false })
  declare confidence: number;

  /** 决策 'bet' | 'skip' */
  @Column({ type: DataType.STRING(10), allowNull: false })
  declare decision: 'bet' | 'skip';

  /** 模型版本 (eg 'v1-logistic-2026-06-13') */
  @Column({ type: DataType.STRING(40), allowNull: false, field: 'model_version' })
  declare model_version: string;

  /** 决策阈值 (confidence >= threshold => bet) */
  @Column({ type: DataType.DECIMAL(8, 6), allowNull: false })
  declare threshold: number;

  /** 主要正/负贡献特征列表 [{name, contribution, value}] */
  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: [], field: 'top_features_json' })
  declare top_features_json?: Array<{
    name: string;
    contribution: number;
    value: number | string;
  }>;

  /** reason — 人类可读解释 */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason?: string | null;

  /** 完整 features snapshot (debug) */
  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: {} })
  declare metadata?: Record<string, any>;

  @CreatedAt
  declare created_at: Date;
}
