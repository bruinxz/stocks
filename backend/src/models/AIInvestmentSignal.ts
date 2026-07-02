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
  /**
   * PR-O3 (2026-06-30) — 早盘抢 (9:25 集合竞价 + PR-M1 隔夜信号融合).
   * 由 `OpeningRushDetector.runOnce` 写入. timing_tag='opening_rush'.
   */
  OPENING_RUSH_DETECTOR = 'opening_rush_detector',
  /**
   * PR-O3 (2026-06-30) — 盘中价量异动 (量比突增 / 主力净流入 / 接近涨停 /
   * 板块联动滞涨 / 炸板回封 / 二板秒封).
   * 由 `IntradayPriceVolumeAnomalyDetector.runOnce` 写入. timing_tag='intraday_anomaly'.
   */
  INTRADAY_PRICE_VOLUME_ANOMALY = 'intraday_price_volume_anomaly',
  /**
   * PR-O3 (2026-06-30) — 尾盘动量 (Yang/Li/Wang 2022 CFRI A 股最稳 alpha,
   * r1 9:30-10:00 收益预测 r2 14:30-15:00). 由 `LastHourMomentumDetector.runOnce` 写入.
   * timing_tag='closing_grab'.
   */
  LAST_HOUR_MOMENTUM = 'last_hour_momentum',
  /**
   * PR-O3 (2026-06-30) — 涨停板战法 (LimitUpBoardDetector, 预留 PR-O2 接入).
   */
  LIMIT_UP_BOARD = 'limit_up_board',
  /**
   * PR-O3 (2026-06-30) — 题材发酵 (ThemeFermentationDetector, 已存在但本 enum 未列).
   */
  THEME_FERMENTATION = 'theme_fermentation',
  /**
   * PR-O6 (2026-06-30) — 午后开盘攻 (12:55-13:30 4 类 pattern):
   *   A19 午后强势开盘 / A20 午间利好引爆 / A21 午后衰竭反转 / A22 板块联动午后启动.
   * 由 `AfternoonKickDetector.runOnce` 写入. timing_tag='afternoon_kick'.
   */
  AFTERNOON_KICK_DETECTOR = 'afternoon_kick_detector',
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

  // ========================================================================
  // §2.2 Signal 原子字段 (SIGNAL_FIRST_PLAN) — 批5e 迁移 phase 1: 加字段, 全部
  // NULL 允许, 应用层双写. phase 2 (观察 7 天后) 加索引; phase 3 (30 天后) 对
  // BUY signal 的 lifecycle_id 加 NOT NULL. 参见 §2.3 Migration 顺序 / §13.1.
  //
  // 说明: source_detector 由既有 source_type 承担 (broad category = 谁给的),
  // 不另设冗余列 (§0.4 规范 > 快, 避免两列语义重叠留脏). action 与既有
  // normalized_decision 并存: normalized_decision 保留 buy/sell/hold 细分,
  // action 是 §2.2 规范的粗粒度 BUY/SELL/TARGET_WEIGHT (TARGET_WEIGHT 为 ETF
  // 再平衡新增, 老 decision 枚举无法表达). confidence 是 0-1 真实胜率 (Wilson
  // 下界, §5.1), 与既有 confidence_score (0-100 打分) 语义不同, 故并存.
  // ========================================================================

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    comment: "§2.2 粗粒度动作: 'BUY' | 'SELL' | 'TARGET_WEIGHT' (ETF 调目标比例)",
  })
  declare action?: string;

  @Column({
    type: DataType.DECIMAL(5, 4),
    allowNull: true,
    comment: '§5.1 该 detector 历史真实胜率 (Wilson 下界, 0-1), 区别于 confidence_score 打分',
  })
  declare confidence?: number;

  @Column({
    type: DataType.STRING(80),
    allowNull: true,
    field: 'lifecycle_id',
    comment: '§2.3 BUY-SELL 配对: <detector>-<symbol>-<yyyymmddhhmm>, 每次 BUY 新 id',
  })
  declare lifecycle_id?: string;

  @Column({
    type: DataType.STRING(80),
    allowNull: true,
    field: 'theme_id',
    comment: '§2.3 卫星题材标识: <industry_slug>-<launch_date>, 同题材多股共享',
  })
  declare theme_id?: string;

  @Column({
    type: DataType.STRING(40),
    allowNull: true,
    field: 'rebalance_id',
    comment: '§2.3 月度再平衡组标识: rebalance-YYYY-MM, 一次再平衡所有 signal 共享',
  })
  declare rebalance_id?: string;

  @Column({
    type: DataType.DECIMAL(6, 2),
    allowNull: true,
    field: 'target_pct',
    comment: '§2.2 TARGET_WEIGHT 时目标仓位 %',
  })
  declare target_pct?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'expected_value',
    comment: '§5.2 EV = confidence×avg_win - (1-confidence)×avg_loss',
  })
  declare expected_value?: number;

  @Column({
    type: DataType.DECIMAL(6, 2),
    allowNull: true,
    field: 'recommended_size_pct',
    comment: '§2.2 建议仓位 % (占总资金)',
  })
  declare recommended_size_pct?: number;

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    field: 'entry_price_strategy',
    comment: "§2.2 进场方式: 'auction_open' | 'observe_15min' | 'skip'",
  })
  declare entry_price_strategy?: string;

  @Column({
    type: DataType.DECIMAL(6, 2),
    allowNull: true,
    field: 'stop_loss_pct',
    comment: '§4.2 止损 %',
  })
  declare stop_loss_pct?: number;

  @Column({
    type: DataType.DECIMAL(6, 2),
    allowNull: true,
    field: 'take_profit_pct',
    comment: '§4.2 止盈 %',
  })
  declare take_profit_pct?: number;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'cooldown_until',
    comment: '§2.2 冷却截止时间',
  })
  declare cooldown_until?: Date;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: true,
    field: 'gate_pass',
    comment: '§5.2 是否通过 gate (L1-L4)',
  })
  declare gate_pass?: boolean;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'gate_reason',
    comment: '§5.2 gate 通过/拒绝原因 (eligibility_fail / risk_fail / cost_fail / ev_fail 等)',
  })
  declare gate_reason?: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
