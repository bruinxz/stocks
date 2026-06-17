import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index, AfterUpdate } from 'sequelize-typescript';
import { logger } from '../utils/logger';

@Table({
  tableName: 'recommendation_trade_outcomes',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      name: 'idx_recommendation_trade_outcomes_portfolio',
      fields: ['portfolio_id'],
    },
    {
      name: 'idx_recommendation_trade_outcomes_signal',
      fields: ['signal_id'],
    },
    {
      name: 'idx_recommendation_trade_outcomes_symbol',
      fields: ['symbol'],
    },
    {
      name: 'idx_recommendation_trade_outcomes_status',
      fields: ['trade_status'],
    },
    {
      name: 'idx_recommendation_trade_outcomes_loop_run',
      fields: ['loop_run_id'],
    },
    {
      name: 'uniq_recommendation_trade_outcomes_portfolio_signal',
      unique: true,
      fields: ['portfolio_id', 'signal_id'],
    },
  ],
})
export class RecommendationTradeOutcome extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'portfolio_id' })
  declare portfolio_id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'signal_id' })
  declare signal_id: number;

  @Index
  @Column({ type: DataType.STRING(80), allowNull: true, field: 'loop_run_id' })
  declare loop_run_id?: string;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'source_type' })
  declare source_type: string;

  @Column({ type: DataType.STRING(100), allowNull: false, field: 'source_id' })
  declare source_id: string;

  @Index
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name?: string;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'signal_date' })
  declare signal_date: string;

  @Column({ type: DataType.STRING(30), allowNull: true })
  declare decision?: string;

  @Column({ type: DataType.DECIMAL(8, 2), allowNull: true })
  declare score?: number;

  @Column({ type: DataType.STRING(30), allowNull: true, field: 'risk_level' })
  declare risk_level?: string;

  @Column({ type: DataType.STRING(30), allowNull: true })
  declare action?: string;

  @Column({ type: DataType.STRING(50), allowNull: true, field: 'action_label' })
  declare action_label?: string;

  @Column({ type: DataType.STRING(30), allowNull: true, field: 'agent_session' })
  declare agent_session?: string;

  @Column({ type: DataType.STRING(50), allowNull: true, field: 'recommendation_style' })
  declare recommendation_style?: string;

  @Column({ type: DataType.STRING(50), allowNull: true, field: 'recommendation_source' })
  declare recommendation_source?: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare industry?: string;

  @Column({ type: DataType.STRING(10), allowNull: true })
  declare market?: string;

  @Index
  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'open',
    field: 'trade_status',
    comment: 'open / closed',
  })
  declare trade_status: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'entry_trade_id' })
  declare entry_trade_id?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'exit_trade_id' })
  declare exit_trade_id?: number;

  @Column({ type: DataType.DATEONLY, allowNull: true, field: 'entry_date' })
  declare entry_date?: string;

  @Column({ type: DataType.DATEONLY, allowNull: true, field: 'exit_date' })
  declare exit_date?: string;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'entry_price' })
  declare entry_price?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'exit_price' })
  declare exit_price?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'latest_price' })
  declare latest_price?: number;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare quantity?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'position_pct' })
  declare position_pct?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'entry_amount' })
  declare entry_amount?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'exit_amount' })
  declare exit_amount?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'total_commission' })
  declare total_commission?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'realized_pnl' })
  declare realized_pnl?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'realized_pnl_pct' })
  declare realized_pnl_pct?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'unrealized_pnl' })
  declare unrealized_pnl?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'unrealized_pnl_pct' })
  declare unrealized_pnl_pct?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'total_pnl' })
  declare total_pnl?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'total_pnl_pct' })
  declare total_pnl_pct?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'max_favorable_excursion_pct' })
  declare max_favorable_excursion_pct?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'max_adverse_excursion_pct' })
  declare max_adverse_excursion_pct?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'holding_days' })
  declare holding_days?: number;

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'benchmark_code' })
  declare benchmark_code?: string;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'benchmark_name' })
  declare benchmark_name?: string;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'benchmark_return_pct' })
  declare benchmark_return_pct?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'excess_return_pct' })
  declare excess_return_pct?: number;

  @Column({ type: DataType.STRING(50), allowNull: true, field: 'exit_reason' })
  declare exit_reason?: string;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'exit_reason_label' })
  declare exit_reason_label?: string;

  /**
   * Phase 5: Root cause 分类 — 把 trade outcome (尤其是亏损) 归到结构化原因
   *
   * 取值 (TRADE_ROOT_CAUSES enum):
   *   - 'profit_take'      —— 止盈出场，正常
   *   - 'stop_loss'        —— 止损出场（亏损）
   *   - 'time_stop'        —— 持仓超过 max holding days
   *   - 'wrong_entry'      —— 入场时机不对 (买入后立即下跌 > 3% 且无回弹)
   *   - 'wrong_regime'     —— 触发后市场环境从 bull 转 bear, 策略不适用
   *   - 'catalyst_failed'  —— 业绩预告超预期 / 利好兑现, 但价格未跟随
   *   - 'data_quality'     —— 数据缺失或异常导致信号错算
   *   - 'backtest_drift'   —— 实盘 - 回测 偏离 > 50% (滑点 / 流动性问题)
   *   - 'risk_kill_switch' —— 风控熔断强制平仓
   *   - 'unknown'          —— 未能自动归类
   *
   * 自动归因规则在 RecommendationTradeOutcomeService.classifyRootCause()
   * (Phase 5 实现的纯函数 + 单测覆盖)。
   */
  @Column({
    type: DataType.STRING(40),
    allowNull: true,
    field: 'root_cause',
    comment: 'Phase 5: trade 失败/成功根因归类 (枚举见 model jsdoc)',
  })
  declare root_cause?: string;

  /** Phase 5: root_cause 的人类可读标签 */
  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'root_cause_label',
    comment: 'Phase 5: root_cause 中文标签',
  })
  declare root_cause_label?: string;

  /** Phase 5: 自动归类时的 confidence (0-1)，<0.5 时建议人工 review */
  @Column({
    type: DataType.DECIMAL(4, 3),
    allowNull: true,
    field: 'root_cause_confidence',
    comment: 'Phase 5: root_cause 自动归类置信度 (0-1)，<0.5 建议人工 review',
  })
  declare root_cause_confidence?: number;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;

  /**
   * Sprint 24 接入: trade closed 触发 DQS 自动评分 + Wizard 合规检测
   *
   * 当 trade_status 从其他状态变为 'closed' 时自动跑:
   *   1. autoApplyDqsToClosedTrade — 算 Reason Triplet + Postmortem 4 维 → metadata.dqs
   *   2. checkTradeCompliance — 5 wizard rule violations → metadata.wizard_compliance
   *   3. emitWizardAlert — Grade D/F 时写 RiskAlert(level='MEDIUM')
   *
   * 设计要点 (与 RiskAlert.@AfterCreate 同款 fire-and-forget):
   *   - lazy-require trader-mind-deep / TradeComplianceChecker 避免循环 import
   *   - 顶层 try/catch 吞错 — hook 失败绝不让 outcome.update() 回滚
   *   - 仅在 trade_status 字段发生变化且新值='closed' 时触发 (避免 metadata 自更新递归)
   *   - 更新 metadata 用 instance.update({metadata: ...}, {hooks: false}) 防递归
   */
  @AfterUpdate
  static async applyDqsAndComplianceHook(instance: RecommendationTradeOutcome): Promise<void> {
    try {
      // 只在 trade_status 字段改变且变为 'closed' 时触发
      if (!instance.changed || typeof instance.changed !== 'function') return;
      const changedFields = instance.changed();
      if (!Array.isArray(changedFields) || !changedFields.includes('trade_status')) return;
      if (instance.trade_status !== 'closed') return;

      // 检查 metadata 是否已有 dqs / 防重复触发
      const md: any = instance.metadata || {};
      if (md.dqs && md.wizard_compliance) return;

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { autoApplyDqsToClosedTrade } = require('../services/governor/trader-mind-deep');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { checkTradeCompliance, emitWizardAlert } = require('../services/TradeComplianceChecker');

      // === 1. DQS 自动评分 ===
      const dqsResult = autoApplyDqsToClosedTrade({
        entry_date: instance.entry_date,
        exit_date: instance.exit_date,
        entry_price: Number(instance.entry_price || 0),
        exit_price: Number(instance.exit_price || 0),
        total_pnl_pct: Number(instance.total_pnl_pct || 0),
        holding_days: Number(instance.holding_days || 0),
        metadata: md,
        thesis_recorded_pre_trade: !!(md.edge_hypothesis || md.thesis),
        data_support_count: Number(md.signal_count || md.data_support || 1),
        stop_loss_honored: md.stop_loss_honored !== false,
        conviction_level: Number(md.conviction_level || 5),
        position_size_pct: Number(md.position_size_pct || 0.05),
      });

      // === 2. Wizard 合规检测 ===
      const complianceInput = {
        realized_pnl_pct: Number(instance.total_pnl_pct || 0) / 100,
        position_size_pct: Number(md.position_size_pct || 0.05),
        conviction_level: Number(md.conviction_level || 5),
        max_drawdown_during_hold_pct: Number(instance.max_adverse_excursion_pct || 0) / 100,
        closed_pre_weekend: false,
        held_over_weekend: Number(instance.holding_days || 0) > 5,
        realized_vol_during_hold: Number(md.realized_vol || 0.2),
        stop_loss_distance_pct: Number(md.stop_loss_distance_pct || 0.07),
        market_trend: (md.market_trend || 'sideways') as 'up' | 'down' | 'sideways',
        trade_direction: 'BUY' as 'BUY' | 'SELL',
        expected_target_pct: Number(md.expected_target_pct || 0.10),
        expected_stop_pct: Number(md.stop_loss_distance_pct || 0.07),
        worst_case_analyzed_pre_trade: !!md.worst_case_analyzed,
        current_pe: Number(md.current_pe || 15),
        historical_avg_pe: Number(md.historical_avg_pe || 15),
        has_specific_catalyst: !!md.has_catalyst,
      };
      const complianceResult = checkTradeCompliance(complianceInput);

      // === 3. 写回 metadata (hooks:false 防递归) ===
      const updatedMetadata = {
        ...md,
        dqs: {
          composite_dqs: dqsResult.triplet?.composite_dqs,
          entry_score: dqsResult.triplet?.entry_score,
          exit_score: dqsResult.triplet?.exit_score,
          size_score: dqsResult.triplet?.size_score,
          postmortem_summary: dqsResult.postmortem_summary,
          computed_at: new Date().toISOString(),
        },
        wizard_compliance: {
          grade: complianceResult.rule_compliance_grade,
          total_violations: complianceResult.total_violations,
          severity_score: complianceResult.severity_score,
          violations: complianceResult.violations,
          summary: complianceResult.summary_message,
          computed_at: new Date().toISOString(),
        },
      };
      await instance.update({ metadata: updatedMetadata }, { hooks: false });

      // === 4. 严重违规 → RiskAlert (fire-and-forget) ===
      if (complianceResult.should_alert) {
        // Batch K (2026-06-17, H3 fix): 之前硬编码 user_id=1 → 所有用户的合规告警
        // 都挂 user 1 名下, 真持仓人看不到. 现在按 portfolio_id 反查 user_id, fallback
        // 到 1 仅在 portfolio 也查不到的边界场景 (db corruption / outcome 旧数据).
        let resolvedUserId = 1;
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { PaperTradingPortfolio } = require('./PaperTradingPortfolio');
          const port = await PaperTradingPortfolio.findByPk(instance.portfolio_id, {
            attributes: ['user_id'],
          });
          if (port?.user_id) resolvedUserId = Number(port.user_id);
        } catch (lookupErr: any) {
          logger.warn(
            `[RecommendationTradeOutcome.afterUpdate] portfolio→user lookup failed (fallback user_id=1): ${lookupErr?.message || lookupErr}`
          );
        }
        await emitWizardAlert({
          user_id: resolvedUserId,
          outcome_id: instance.id,
          symbol: instance.symbol,
          name: instance.symbol,
          trade_direction: 'BUY',
          realized_pnl_pct: Number(instance.total_pnl_pct || 0) / 100,
          result: complianceResult,
        });
      }
    } catch (err: any) {
      logger.warn(`[RecommendationTradeOutcome.afterUpdate] DQS+Wizard hook failed: ${err?.message || err}`);
    }
  }
}
