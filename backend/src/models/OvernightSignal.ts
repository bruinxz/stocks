import { Table, Column, Model, DataType, CreatedAt } from 'sequelize-typescript';

/**
 * 隔夜信号矩阵 (Overnight Signal Matrix) — PR-M1 数据层.
 *
 * 用途: 早盘 9:25 集合竞价前给 QuantRecommendationService /
 * OpeningRushDetectorService 消费, 用于推断大盘方向 (bullish/neutral/bearish)
 * 并按 PR-I 战法库 阻塞普跌日盲推荐.
 *
 * 一行 = 一次 (signal_type, collected_at) 唯一信号快照. 同一信号一天会被刷新
 * 多次 (cron 每 15min 跑一次, 9:00-9:25 期间共 ~6 次), 用于捕捉 A50 期指 / VIX
 * 等盘前最末分钟变动.
 *
 * 数据源 (5 个核心 source, 全 AKShare):
 *   - a50_future   富时 A50 期指 (新加坡)  — Han/Hu/Jia 2023 实证 R² 显著, 全市场高低开预期
 *   - hk_hsi       港股恒指 / H 股        — Stefan 2020 AH 股联动 (港股 9:30 比 A 股早 30min)
 *   - us_nasdaq    美股纳指                — PR-I 实证 → 半导体/AI/新能源车 跳空 ±2%
 *   - us_dxy       美元指数 DXY            — 黄金/有色/出口/航空 ±0.5% 阈值
 *   - us_vix       VIX 恐慌指数            — 全市场风险偏好, VIX > 25 → A 股低开偏空
 *   - china_adr    (预留) 中概 ADR        — Stefan 2020 双重上市联动 (KWEB 等)
 *
 * fail-OPEN 范式 (与 ETF_FLOW_SYNC / MarketJudgmentService 同款):
 *   单个 source AKShare 端点抖动 / 404 仅 warn + 缺该 source 的行, 不阻塞
 *   其他 source. 整体 SyncResult 返回 per-source success / error 数组.
 *
 * AC endpoint substitution 范式 (与 US-034 / US-091 / US-092 同款 4 处文档同步):
 *   AKShare 部分 endpoint 名称变化频繁, Python helper 内部按 try/except
 *   fallback 链尝试, 服务层 / TS 端只看 signal_type 不关心底层 endpoint.
 *
 * 与既有 model 的区分:
 *   - MarketJudgmentService (US-040): 实时 sina hq.sinajs.cn 单次拉取 4 个海外
 *     指数 (hangseng/nasdaq/sp500/dji) 给"今日大盘判断"卡片, 不入库.
 *     本表是定时 cron 入库的时序数据, 给推荐服务做盘前历史回看 + 大盘方向
 *     decider 用 (前 12h 内的全部 signal 都参考). 两者互补不重复.
 *   - MarketSentimentIndex (US-057): 单日全市场情绪指数 (4 维), 是 EOD 计算
 *     的衍生指标; 本表是原始外盘信号.
 */
@Table({
  tableName: 'overnight_signals',
  timestamps: false, // 只用 created_at, 不需要 updated_at (signal 是 append-only)
  underscored: true,
  indexes: [
    { fields: ['signal_type', 'collected_at'] },
    { fields: ['collected_at'] },
  ],
})
export class OvernightSignal extends Model {
  @Column({
    type: DataType.BIGINT,
    autoIncrement: true,
    primaryKey: true,
  })
  declare id: number;

  @Column({
    type: DataType.STRING(32),
    allowNull: false,
    field: 'signal_type',
    comment:
      '信号类型: a50_future / hk_hsi / us_nasdaq / us_dxy / us_vix / china_adr',
  })
  declare signal_type: string;

  @Column({
    type: DataType.STRING(64),
    allowNull: true,
    comment: '原始 AKShare endpoint 名 (e.g. index_global_em) - 便于事后回溯',
  })
  declare source?: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'collected_at',
    defaultValue: DataType.NOW,
    comment: '抓取时间 (UTC TIMESTAMPTZ); 与 signal_type 组成 unique key',
  })
  declare collected_at: Date;

  @Column({
    type: DataType.DECIMAL(20, 8),
    allowNull: true,
    comment: '最新价 / 收盘价 (浮点保留 8 位)',
  })
  declare value?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'change_pct',
    comment: '当日涨跌幅 % (e.g. -1.23 = 下跌 1.23%)',
  })
  declare change_pct?: number;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment: '原始 AKShare 行 (保留所有字段, 便于事后回溯)',
  })
  declare raw_payload: Record<string, unknown>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;
}
