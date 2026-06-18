/**
 * ResearchIntegrityAudit — Sprint 1A 研究严谨性审计记录
 *
 * 每次对一份 backtest / walk-forward run 跑研究严谨性审计就写一行：
 *   - DSR (Deflated Sharpe Ratio)
 *   - PBO (Probability of Backtest Overfitting)
 *   - OOS decay (IS/OOS sharpe 比值)
 *   - lookahead_issues (未来函数静态扫描结果)
 *   - survivorship_issues (universe drift 警告)
 *   - verdict (PASS / WARN / FAIL / INSUFFICIENT)
 *
 * 用途：
 *   - Promotion gate: 任何想 promote 到 live 的策略必须有近期 PASS audit
 *   - UI: 策略实验室对每个 backtest 显示一个 "可信度徽章"
 *   - Ops: 离线巡检批量审计所有最近 backtest，找出可疑策略
 */
import { Table, Column, Model, DataType, CreatedAt } from 'sequelize-typescript';

export type ResearchIntegrityVerdict = 'PASS' | 'WARN' | 'FAIL' | 'INSUFFICIENT';

@Table({
  tableName: 'research_integrity_audits',
  timestamps: true,
  underscored: true,
  updatedAt: false,
  indexes: [
    { fields: ['backtest_id'] },
    { fields: ['strategy_key', 'created_at'] },
    { fields: ['verdict'] },
  ],
})
export class ResearchIntegrityAudit extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  /** QuantBacktestResult.id 或 WalkForwardResult.id (按 source 字段区分) */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'backtest_id' })
  declare backtest_id?: number | null;

  /** 'quant_backtest_result' | 'walk_forward_result' | 'standalone' */
  @Column({ type: DataType.STRING(40), allowNull: false, defaultValue: 'standalone' })
  declare source: string;

  @Column({ type: DataType.STRING(60), allowNull: true, field: 'strategy_key' })
  declare strategy_key?: string | null;

  /** Deflated Sharpe Ratio ∈ [0, 1]，null = 数据不足 */
  @Column({ type: DataType.DECIMAL(8, 6), allowNull: true })
  declare dsr?: number | null;

  /** Probability of Backtest Overfitting ∈ [0, 1]，null = 没跑 CPCV */
  @Column({ type: DataType.DECIMAL(8, 6), allowNull: true })
  declare pbo?: number | null;

  /** IS sharpe / OOS sharpe 比值；> 1.5 即 OOS 大幅退化 */
  @Column({ type: DataType.DECIMAL(8, 4), allowNull: true, field: 'oos_decay_ratio' })
  declare oos_decay_ratio?: number | null;

  /** 观测到的年化 sharpe（IS / 整段） */
  @Column({ type: DataType.DECIMAL(8, 4), allowNull: true, field: 'observed_sharpe' })
  declare observed_sharpe?: number | null;

  /** OOS 年化 sharpe（如有） */
  @Column({ type: DataType.DECIMAL(8, 4), allowNull: true, field: 'oos_sharpe' })
  declare oos_sharpe?: number | null;

  /** 试验次数（DSR 用） */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'num_trials' })
  declare num_trials?: number | null;

  /** 样本长度（DSR 用，回测期日数） */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'sample_length' })
  declare sample_length?: number | null;

  /** 未来函数扫描结果 [{file, line, pattern, snippet}] */
  @Column({
    type: DataType.JSONB,
    allowNull: true,
    defaultValue: [],
    field: 'lookahead_issues_json',
  })
  declare lookahead_issues_json?: Array<{
    file: string;
    line: number;
    pattern: string;
    snippet: string;
    severity: 'high' | 'medium' | 'low';
  }>;

  /** universe drift / survivorship bias 警告 */
  @Column({
    type: DataType.JSONB,
    allowNull: true,
    defaultValue: [],
    field: 'survivorship_issues_json',
  })
  declare survivorship_issues_json?: Array<{
    kind: string;
    detail: string;
    severity: 'high' | 'medium' | 'low';
  }>;

  /** 综合判决：PASS / WARN / FAIL / INSUFFICIENT */
  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'INSUFFICIENT' })
  declare verdict: ResearchIntegrityVerdict;

  /** 自然语言总结 (1-2 句话) */
  @Column({ type: DataType.TEXT, allowNull: true, field: 'summary_message' })
  declare summary_message?: string | null;

  /** 完整 detail JSON (debug) */
  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: {} })
  declare metadata?: Record<string, any>;

  @CreatedAt
  declare created_at: Date;
}
