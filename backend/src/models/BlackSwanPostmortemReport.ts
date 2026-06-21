import {
  Table,
  Column,
  Model,
  DataType,
  CreatedAt,
  UpdatedAt,
  ForeignKey,
  BelongsTo,
} from 'sequelize-typescript';
import { BlackSwanEvent } from './BlackSwanEvent';

/**
 * BlackSwanPostmortemReport — L4-Portfolio + Risk / US-101 [PR-012] 黑天鹅事件复盘报告
 *
 * 一行 = 一个 BlackSwanEvent 的一次完整 postmortem 输出快照. 由 PR-013
 * BlackSwanPostmortemService 触发后 30 min 内生成 (US-102 同 story 接入), 后续 PR-014/015/016
 * 各自负责填充本表对应 JSONB 段:
 *   - PR-013 BlackSwanPostmortemService (US-102): 主入口, 编排 4 段生成 + bulkUpsert 本表
 *   - PR-014 CounterfactualBaselineCalculator (US-103): 填 counterfactual_baselines 段
 *   - PR-015 EventTimelineReplayer (US-104):           填 event_timeline 段
 *   - PR-016 ImprovementSuggestor (US-105):            填 improvement_suggestions 段
 *
 * **本 story (PR-012) 只新增 model schema + migration**. 真持久化 (write/read) 由 PR-013/014/015/016
 * 后续 story 接入; 本表落表后由前端 ops 看板 / 飞书 push 消费 (与 PM-009 同款 dispatcher; 后续 EV
 * story 接入).
 *
 * **与既有 model 的边界**:
 *   - BlackSwanEvent (PR-010) = 事件本身 global 视角 (一次事件一行, 上游 FK 来源).
 *   - BlackSwanWatchdog 输出 RiskAlert (US-053) = per-user-per-position 实时告警 (与本表正交,
 *     被 EventTimelineReplayer 当数据源拉前 N 天 RiskAlert 输入).
 *   - 本表 = per-event 一次性 postmortem 报告 (一对一; 若同一事件需要多版本可 versioned 增量
 *     UPSERT, 见 generated_at 字段 + UNIQUE(black_swan_event_id) 业务键).
 *   - ErrorPatternReport (PM-021) = per-user 90 天 bias 聚合 (跨多个事件; 与本表正交;
 *     postmortem 是单事件, 错误模式聚合是跨事件 / 跨周期).
 *   - ImprovementSuggestion (PM-023) = per-user-per-period 改进建议 (从 ErrorPatternReport 展开,
 *     与本表 improvement_suggestions JSONB 段语义相关但 scope 不同: 本表段只针对单事件,
 *     ImprovementSuggestion 表针对 90 天周期聚合).
 *
 * **(black_swan_event_id) 业务唯一** (本 story 关键不变量):
 *   - 一个事件最终落一份最新 postmortem; cron 重跑 / 人工 review 后 重新生成走 UPSERT 覆盖.
 *   - 历史版本保留思想: generated_at 字段每次 UPSERT 更新; 真要保多版本走 metadata.history[].
 *   - PRD US-101 AC: "报告模型 + 4 段 JSONB 字段" — 一事件一报告, idempotent 重跑.
 *
 * **4 段 JSONB** (PRD US-101 AC 核心要求, 对应 PR-013/014/015/016 各自输出):
 *
 *   1. `event_summary` JSONB — PR-013 主入口在生成时填充, 给前端 hero card / 飞书 push 引用:
 *      - event_type / severity / scope / symbol: 冗余字段 (避免 read 时再 JOIN BlackSwanEvent)
 *      - detected_at / resolved_at: 事件时间窗口
 *      - duration_minutes: 事件持续 / 影响时长
 *      - title / description: 复制 BlackSwanEvent.title / description (postmortem 时刻 snapshot)
 *      - severity_change?: { old: 'medium', new: 'high', reason: '...' }
 *        — PR-013 postmortem 人工 review 后上调 / 下调 severity 的留痕
 *      - linked_risk_alert_ids[]: 关联 RiskAlert IDs (BlackSwanWatchdog 之前发的告警)
 *
 *   2. `counterfactual_baselines` JSONB — PR-014 CounterfactualBaselineCalculator (US-103) 填充:
 *      - baselines[]: 4 种 baseline 模拟结果数组 (每条一个 baseline 类型)
 *        { type: 'hold' | 'zero' | 'plan' | 'perfect',
 *          pnl: number, pnl_pct: number, max_drawdown: number,
 *          peak_value: number, trough_value: number,
 *          assumptions: { ... }, samples: Array<{date, value}> (≤ 10) }
 *      - actual: { pnl, pnl_pct, max_drawdown, peak_value, trough_value, ... }
 *        — 实际 portfolio 表现作对比基准
 *      - calculator_version: PR-014 calculator 版本号 (debug 用)
 *      - 4 baseline 语义 (来自 PRD US-103 AC):
 *        * hold    — 持有不动 (任何信号都不处理, 看自然演进 baseline)
 *        * zero    — 满仓清空 (全部触发瞬间卖出, 仅留现金, 看保命 baseline)
 *        * plan    — 按预案执行 (用户既定 risk plan 触发: 减仓 / 对冲 / 止损)
 *        * perfect — 完美执行 (事后视角最优: 提前 X 日清仓, 上限 baseline)
 *
 *   3. `event_timeline` JSONB — PR-015 EventTimelineReplayer (US-104) 填充:
 *      - lookback_days: 时间轴回溯天数 (PRD US-104 N 天前; 默认 7)
 *      - timeline[]: 按时间排序事件流数组
 *        { ts: ISO timestamp, type: 'risk_alert' | 'watchdog_trigger' | 'price_break' |
 *               'volume_spike' | 'news' | 'shareholder_action' | 'rebalance' | 'manual_action',
 *          source_id?: number, source_table?: string,
 *          symbol?: string, severity?: 'low'|'medium'|'high'|'critical',
 *          title: string, description?: string,
 *          metadata?: { ... } }
 *      - alert_count_by_level: { low: n, medium: n, high: n, critical: n }
 *      - replayer_version: PR-015 replayer 版本号
 *      - 数据源 (来自 PRD US-104 AC):
 *        * 前 N 天 RiskAlert (level / created_at / message)
 *        * 前 N 天 BlackSwanWatchdog 输出 (signature / trigger_data)
 *        * 价格 / 成交量异动 (DailyBar 算法标记)
 *        * 公告事件 (NewsItem / Announcement)
 *
 *   4. `improvement_suggestions` JSONB — PR-016 ImprovementSuggestor (US-105) 填充:
 *      - suggestions[]: 改进建议数组 (4 类短板归类, 来自 PRD US-105 AC)
 *        { category: 'detection' | 'response' | 'execution' | 'risk_control',
 *          key: string, title: string, body: string,
 *          priority: number (0..100), template_id?: string,
 *          evidence: { sample_event_ids?: number[], metric?: { ... } },
 *          action?: { type: 'noop' | 'tune_risk_param' | ..., payload: { ... } } }
 *      - top_findings[]: 综合 top N (≤ 5) 最优先建议 (类似 ErrorPatternReport.top_findings)
 *      - suggestor_version: PR-016 suggestor 版本号
 *      - 4 类短板 (来自 PRD US-105 AC):
 *        * detection      — 信号未及时检出 (cron 频率 / 阈值 / 数据源缺失)
 *        * response       — 检出后响应慢 (告警未触发 / 触发但 ops 未跟进)
 *        * execution      — 响应后执行失败 (订单失败 / 滑点 / 流动性不足)
 *        * risk_control   — 风控配置欠缺 (止损位 / 集中度 / 对冲缺失)
 *
 * **status 字段四态** (lifecycle, 与 ErrorPatternReport / DailyAttributionReport 同款 fail-OPEN):
 *   - 'pending'  — PR-013 service 调度但还未跑完 (生成中; 各段可能为空 {})
 *   - 'ok'       — 4 段全部生成成功 (含 fallback 路径也算合规)
 *   - 'partial'  — 部分段生成成功 (其余段失败但允许保留; metadata.errors 记录)
 *   - 'failed'   — 全部段生成失败 (service throw, 仍尝试落留痕)
 *
 * **source 字段** — postmortem 触发来源:
 *   - 'service_auto' — PR-013 cron 触发后 30min 内自动生成 (默认)
 *   - 'manual'       — ops 手动触发 review 重生成 (留痕)
 *   - 'external'     — 外部 webhook (e.g. 飞书人工触发 / 邮件解析)
 *
 * **generated_at** —— 报告生成瞬间; UPSERT 覆盖时更新 (与 created_at 区分: 后者首次 INSERT 时戳).
 *
 * **fail-safe 默认值** (与 BlackSwanEvent / ErrorPatternReport 同款思想):
 *   - title / summary 默认 '' (NOT NULL trivially INSERT 通过)
 *   - event_summary / counterfactual_baselines / event_timeline / improvement_suggestions 默认 '{}'::jsonb
 *   - metadata 默认 '{}'::jsonb
 *   - status 默认 'pending' (新建报告默认生成中)
 *   - source 默认 'service_auto'
 *
 * 主要消费方 (后续 story 接入):
 *   - PR-013 BlackSwanPostmortemService (US-102) - 主入口 bulkUpsert
 *   - PR-014/015/016 各段 calculator/replayer/suggestor 直接 update JSONB 段
 *   - 前端 ops 看板 (postmortem 详情页, 后续 EV story 接入)
 *   - 飞书 push (与 PM-009 同款 dispatcher; 后续 story 接入)
 */
@Table({
  tableName: 'black_swan_postmortem_reports',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['black_swan_event_id'],
      unique: true,
      name: 'black_swan_postmortem_reports_event_uniq',
    },
    { fields: ['black_swan_event_id'] },
    { fields: ['status'] },
    { fields: ['source'] },
    { fields: ['generated_at'] },
  ],
})
export class BlackSwanPostmortemReport extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @ForeignKey(() => BlackSwanEvent)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'black_swan_event_id',
    comment: '关联 BlackSwanEvent.id (FK; 业务唯一键 — 一事件一份最新 postmortem)',
  })
  declare black_swan_event_id: number;

  @BelongsTo(() => BlackSwanEvent)
  declare black_swan_event: BlackSwanEvent;

  @Column({
    type: DataType.STRING(200),
    allowNull: false,
    field: 'title',
    defaultValue: '',
    comment: '报告标题 (≤ 100 字, e.g. "贵州茅台 600519 ST 事件复盘"; cap 由 service 守)',
  })
  declare title: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'summary',
    defaultValue: '',
    comment: '≤ 500 字 heuristic / LLM 摘要 (与 ErrorPatternReport.summary 同款思想)',
  })
  declare summary: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'event_summary',
    defaultValue: {},
    comment:
      '4 段第 1 段: 事件 snapshot (PR-013 主入口填; event_type/severity/scope/symbol/duration_minutes/severity_change?/linked_risk_alert_ids[])',
  })
  declare event_summary: Record<string, unknown>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'counterfactual_baselines',
    defaultValue: {},
    comment:
      '4 段第 2 段: counterfactual 4 baseline 模拟 (PR-014 填; baselines[]={type:hold|zero|plan|perfect}, actual{}, calculator_version)',
  })
  declare counterfactual_baselines: Record<string, unknown>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'event_timeline',
    defaultValue: {},
    comment:
      '4 段第 3 段: 事件时间轴 (PR-015 填; lookback_days, timeline[]={ts,type,severity,title,...}, alert_count_by_level{}, replayer_version)',
  })
  declare event_timeline: Record<string, unknown>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'improvement_suggestions',
    defaultValue: {},
    comment:
      '4 段第 4 段: 改进建议 (PR-016 填; suggestions[]={category:detection|response|execution|risk_control, priority, evidence, action?}, top_findings[], suggestor_version)',
  })
  declare improvement_suggestions: Record<string, unknown>;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'source',
    defaultValue: 'service_auto',
    comment: '触发来源: service_auto / manual / external',
  })
  declare source: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'status',
    defaultValue: 'pending',
    comment: '生成状态: pending / ok / partial / failed (与 ErrorPatternReport 对齐, fail-OPEN)',
  })
  declare status: string;

  @Column({
    type: DataType.STRING(200),
    allowNull: true,
    field: 'reason',
    comment:
      'partial / failed 时的简短原因 (e.g. calculator_threw / no_baseline_data / replayer_no_input)',
  })
  declare reason: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'metadata',
    defaultValue: {},
    comment:
      '调用 metadata (cron_run_id / service_version / errors[] / history[] 历史版本 snapshot / 各段 calculator/replayer/suggestor 版本号)',
  })
  declare metadata: Record<string, unknown>;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'generated_at',
    comment: '报告生成时间戳 (UPSERT 时更新; 与 created_at 区分: 后者首次 INSERT)',
  })
  declare generated_at: Date;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
