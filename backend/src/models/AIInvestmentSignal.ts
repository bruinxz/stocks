import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

export enum AISignalSourceType {
  DAILY_SCREENER = 'daily_screener',
  TRADING_AGENTS = 'tradingagents',
  QUANT_RECOMMENDATION = 'quant_recommendation',
  MANUAL_ANALYSIS = 'manual_analysis',
  /**
   * US-020 [AE-001] 多维分析引擎 hard mode 产物 — 由
   * `AIInvestmentSignalService.archiveAnalysisEngineResult` 落库,
   * 让 PaperTradingAutomationService / Dashboard / Attribution 能识别
   * `analysis_engine` 来源并在 hard mode 下跟单. 不破坏 shadow mode 行为
   * (后者写 AIStockAnalysisReport, 不写本表).
   */
  ANALYSIS_ENGINE = 'analysis_engine',
}

export enum AISignalDecision {
  STRONG_BUY = 'strong_buy',
  BUY = 'buy',
  HOLD = 'hold',
  SELL = 'sell',
  STRONG_SELL = 'strong_sell',
  UNKNOWN = 'unknown',
}

@Table({
  tableName: 'ai_investment_signals',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      unique: true,
      fields: ['source_type', 'source_id'],
    },
    {
      fields: ['symbol', 'signal_date'],
    },
    {
      fields: ['normalized_decision'],
    },
    {
      fields: ['verification_status'],
    },
    {
      fields: ['loop_run_id'],
    },
  ],
})
export class AIInvestmentSignal extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    field: 'source_type',
    comment:
      '信号来源类型：daily_screener / tradingagents / quant_recommendation / manual_analysis / analysis_engine',
  })
  declare source_type: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    field: 'source_id',
    comment: '来源记录ID或任务ID',
  })
  declare source_id: string;

  @Column({
    type: DataType.STRING(80),
    allowNull: true,
    field: 'loop_run_id',
    comment: '自动荐股闭环运行ID，用于把推荐参数版本、信号、模拟交易收益串起来',
  })
  declare loop_run_id?: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    comment: '股票代码',
  })
  declare symbol: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    comment: '股票名称',
  })
  declare name?: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'signal_date',
    comment: '信号日期',
  })
  declare signal_date: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    comment: '原始AI决策文本',
  })
  declare decision: string;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    field: 'normalized_decision',
    defaultValue: AISignalDecision.UNKNOWN,
    comment: '标准化决策',
  })
  declare normalized_decision: string;

  @Column({
    type: DataType.DECIMAL(8, 2),
    allowNull: true,
    field: 'confidence_score',
    comment: '置信分/综合分 0-100',
  })
  declare confidence_score?: number;

  @Column({
    type: DataType.STRING(30),
    allowNull: true,
    field: 'risk_level',
    comment: '风险等级',
  })
  declare risk_level?: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '核心理由',
  })
  declare rationale?: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '完整研报或推理明细',
  })
  declare detail?: string;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'current_price',
    comment: '信号生成时价格',
  })
  declare current_price?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'price_change_pct',
    comment: '信号生成时涨跌幅',
  })
  declare price_change_pct?: number;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'forward_returns',
    comment: '信号生成后的多周期收益验证',
  })
  declare forward_returns: Record<string, any>;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: 'pending',
    field: 'verification_status',
    comment: '验证状态 pending / partial / completed / no_data',
  })
  declare verification_status: string;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'verified_at',
    comment: '最近验证时间',
  })
  declare verified_at?: Date;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    comment: '额外元数据',
  })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
