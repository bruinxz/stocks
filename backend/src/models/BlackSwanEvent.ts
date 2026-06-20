import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * BlackSwanEvent — L4-Portfolio + Risk / US-099 [PR-010] 黑天鹅事件落库
 *
 * 一行 = 一次黑天鹅事件 (检测瞬间持久化, 用于 ops 仪表 / 复盘 / 触发链路审计).
 *
 * **本 story (PR-010) 只新增 model schema + migration**, 真持久化 (write / read)
 * 由后续 story 接入:
 *   - PR-011 BlackSwanDetector cron (US-100): 30min 巡 5 类信号 → bulkCreate 本表
 *   - PR-012 BlackSwanPostmortemReport (US-101): 本表 → 报告模型 (一对多 FK)
 *   - PR-013 BlackSwanPostmortemService (US-102): 触发后 30min 内生成 4 段
 *   - PR-014 CounterfactualBaselineCalculator (US-103)
 *   - PR-015 EventTimelineReplayer (US-104)
 *   - PR-016 ImprovementSuggestor (US-105)
 *
 * **与既有 BlackSwanWatchdog (US-053) 的边界**:
 *   - BlackSwanWatchdog = 每日 cron + per-user 持仓维度 + RiskAlert (level=HIGH) 写入
 *     + dedup signature 存 User.risk_config.black_swan_seen JSONB. 它是"event 检测 +
 *     用户级告警"两件事的混合体, 仅按 user × position 维度发 RiskAlert; 不留事件本身的
 *     全局快照, 无法回答"7 天内全市场出现了几次 ST"/"复盘上次 ST 风暴的因果链".
 *   - 本表 BlackSwanEvent = 事件本身的 global 视角, 一次事件一行, 与 user 无关 (scope
 *     = 'market'/'sector'/'symbol'/'portfolio' 区分影响面). 便于:
 *       - PR-011 cron 巡 5 类信号 → 这里集中落表 (与 BlackSwanWatchdog 互补, 不取代);
 *       - PR-012/013 postmortem 报告 → FK 本表;
 *       - ops 看板 → "近 90 天严重事件数 / 类型分布 / 平均恢复时长" 全靠本表;
 *       - PR-014 counterfactual baseline → 引用具体事件 id 跑情景模拟.
 *
 * **(event_type, signature, detected_at::date) 业务唯一**:
 *   - PRD US-099 AC: 字段含 (id, detected_at, event_type, severity, scope).
 *   - 同一事件 cron 重跑必须 idempotent (PR-011 cron 30min 巡一次, 同 ST event 30min 内
 *     会重复 detect); 用 (event_type, signature, detected_at::date) 作复合唯一键.
 *   - signature 字段语义沿用 BlackSwanWatchdog.signatureForEvent (ST::SYM / SUSPENDED::SYM
 *     / NEWS::SYM::KW::HASH / SHAREHOLDER_REDUCTION::SYM::WINDOW), PR-011 cron 调它生成.
 *   - 不同日跑 (跨午夜)  → 重新落一行新事件 (业务上是新一天的同 type 事件); 这是与
 *     User.risk_config.black_swan_seen 永久 LRU 去重的关键差异.
 *
 * **event_type 字段** —— 与 BlackSwanWatchdog.BlackSwanEventType 对齐 + PR-011 扩展:
 *   - 'ST'                    — 股票被 ST 标记 (e.g. 600519 → *ST)
 *   - 'SUSPENDED'             — 停牌 (单日 list)
 *   - 'NEWS_KEYWORD'          — 重大利空关键词命中 (立案/退市/重大违规/处罚/问询函)
 *   - 'SHAREHOLDER_REDUCTION' — 大股东减持 (公告 N 日累计窗口)
 *   - 'MARKET_REGIME'         — 大盘极端 (e.g. 指数死叉 / 单日大跌阈值 / VIX 暴涨)
 *     ↑ PR-011 cron 才接入; 本 story 仅留枚举位.
 *   未来 PR-016 / 长尾扩展走 'OTHER' (避免 enum 收紧导致 migration 灾难).
 *
 * **severity 字段四态** (与 RiskAlert.level 对齐):
 *   - 'low'      — 风险信号, 仅 ops 告知, 不发飞书 (e.g. 减持公告 < 1%)
 *   - 'medium'   — 中度, ops + 飞书 ops_alert (e.g. 重大新闻关键词命中 1 条)
 *   - 'high'     — 高度, ops + 飞书 + 短信 (e.g. ST / 立案)
 *   - 'critical' — 极端, ops + 飞书 + 短信 + 电话 (e.g. 退市 / 市场熔断)
 *   PR-011 detector 启发式映射默认值 (e.g. ST=high, NEWS_KEYWORD=medium, ...);
 *   PR-013 postmortem 可能下调/上调 severity (人工 review 后).
 *
 * **scope 字段四态** —— 影响面归类:
 *   - 'symbol'    — 单股 (ST/停牌/单股新闻 — symbol 字段必填)
 *   - 'sector'    — 行业 (e.g. 教培行业被监管; symbol=null, scope_detail.sector 必填)
 *   - 'market'    — 全市场 (e.g. 大盘熔断; symbol=null, scope_detail.index 可填)
 *   - 'portfolio' — 某用户 portfolio 维度 (e.g. 集中度突破阈值; scope_detail.user_id 必填)
 *
 * **status 字段三态** (lifecycle):
 *   - 'open'      — 事件 active 中 (e.g. ST 状态未解除; 停牌未复牌)
 *   - 'resolved'  — 事件 resolved (e.g. ST 撤销, 复牌); resolved_at + resolved_reason 必填
 *   - 'expired'   — 自然过期 (e.g. 新闻关键词命中 30 天后 ops review 已无影响 → 标 expired)
 *   PR-011 detector 默认 'open'; PR-013 postmortem 可能标 resolved.
 *
 * **symbol 字段** (nullable VARCHAR(20)):
 *   - scope='symbol' 时必填 (e.g. '600519.SH')
 *   - scope='sector'/'market'/'portfolio' 时 NULL
 *
 * **detail JSONB** — 事件详情 snapshot (与 BlackSwanWatchdog.BlackSwanTrigger.detail 对齐):
 *   - ST          : { latest_price, change_pct, raw_name }
 *   - SUSPENDED   : { latest_price, change_pct, last_trade_price }
 *   - NEWS_KEYWORD: { keyword, title, content, publish_time, source, url }
 *   - SHAREHOLDER_REDUCTION: { holder_name, reduce_ratio, ann_date, raw_record }
 *   - MARKET_REGIME: { index_code, signal_type, threshold, observed_value }
 *
 * **scope_detail JSONB** — 影响面附加上下文:
 *   - scope='sector'   : { sector: '教育', sub_sector?: '在线教育' }
 *   - scope='market'   : { index: '000001', region?: 'A股' }
 *   - scope='portfolio': { user_id: 7, portfolio_id: 12 }
 *   - scope='symbol'   : {} (symbol 字段已表达)
 *
 * **signature 字段** (业务键的字符串签名):
 *   - 同 BlackSwanWatchdog.signatureForEvent 输出, e.g. 'ST::600519' / 'NEWS::600519::立案::abc12345'
 *   - 落库 + INDEX 让 detector cron 用 (event_type, signature, detected_at::date) 三件套
 *     去重 → 同 type 同 signature 同日只一行
 *
 * **source 字段** (检测来源):
 *   - 'detector_cron' — PR-011 cron 默认
 *   - 'watchdog'      — BlackSwanWatchdog 触发时回填 (后续 story 接入)
 *   - 'manual'        — admin 手动录入 (留痕)
 *   - 'external'      — 外部 webhook (e.g. 飞书人工录入 / 邮件解析)
 *
 * **fail-safe 默认值**:
 *   - title / description 默认 '' (NOT NULL trivially INSERT 通过)
 *   - detail / scope_detail / metadata 默认 '{}'::jsonb
 *   - source 默认 'detector_cron'
 *   - status 默认 'open' (新建事件默认 active)
 *   - severity 默认 'medium' (安全态; 与 normalizeBlackSwanSeverity 对齐, 减少飞书风暴)
 *
 * 主要消费方 (后续 story 接入):
 *   - PR-011 BlackSwanDetector cron → bulkCreate / upsert
 *   - PR-012 BlackSwanPostmortemReport (FK black_swan_event_id)
 *   - PR-013 BlackSwanPostmortemService
 *   - PR-014 CounterfactualBaselineCalculator
 *   - PR-015 EventTimelineReplayer
 *   - PR-016 ImprovementSuggestor
 *   - 前端 ops 看板 (近 N 天事件分布, 后续 EV story 接入)
 *   - 飞书 push (与 PM-009 同款 dispatcher; 后续 story 接入)
 */
@Table({
  tableName: 'black_swan_events',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['event_type', 'signature', 'detected_at'],
      unique: true,
      name: 'black_swan_events_type_sig_detected_uniq',
    },
    { fields: ['event_type'] },
    { fields: ['severity'] },
    { fields: ['scope'] },
    { fields: ['status'] },
    { fields: ['symbol'] },
    { fields: ['detected_at'] },
  ],
})
export class BlackSwanEvent extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'detected_at',
    comment:
      '事件检测瞬间时间戳 (PR-011 cron 写入时 NOW(); 与 created_at 区分: 后者是 ORM 落库时刻)',
  })
  declare detected_at: Date;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    field: 'event_type',
    comment:
      '事件类型: ST / SUSPENDED / NEWS_KEYWORD / SHAREHOLDER_REDUCTION / MARKET_REGIME / OTHER',
  })
  declare event_type: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'severity',
    defaultValue: 'medium',
    comment: '严重度: low / medium / high / critical (与 RiskAlert.level 对齐)',
  })
  declare severity: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'scope',
    defaultValue: 'symbol',
    comment: '影响面: symbol / sector / market / portfolio',
  })
  declare scope: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    field: 'symbol',
    comment: 'scope=symbol 时必填 (e.g. "600519.SH"); 其它 scope 为 NULL',
  })
  declare symbol: string | null;

  @Column({
    type: DataType.STRING(255),
    allowNull: false,
    field: 'signature',
    defaultValue: '',
    comment:
      'BlackSwanWatchdog.signatureForEvent 输出 (e.g. "ST::600519" / "NEWS::600519::立案::abc12345"); 与 (event_type, detected_at::date) 组成业务唯一键',
  })
  declare signature: string;

  @Column({
    type: DataType.STRING(200),
    allowNull: false,
    field: 'title',
    defaultValue: '',
    comment: '事件中文标题 (e.g. "贵州茅台 600519 被 ST"); ≤ 100 字, cap 由 detector 守',
  })
  declare title: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'description',
    defaultValue: '',
    comment: '事件描述详情 (≤ 500 字, cap 由 detector 守, model 层不校验)',
  })
  declare description: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'detail',
    defaultValue: {},
    comment:
      '事件 detail snapshot (与 BlackSwanWatchdog.BlackSwanTrigger.detail 对齐: ST/SUSPENDED/NEWS_KEYWORD/SHAREHOLDER_REDUCTION/MARKET_REGIME 各自 schema)',
  })
  declare detail: Record<string, unknown>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'scope_detail',
    defaultValue: {},
    comment:
      '影响面附加上下文 (sector: {sector, sub_sector?} / market: {index, region?} / portfolio: {user_id, portfolio_id} / symbol: {})',
  })
  declare scope_detail: Record<string, unknown>;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'source',
    defaultValue: 'detector_cron',
    comment: '检测来源: detector_cron / watchdog / manual / external',
  })
  declare source: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'status',
    defaultValue: 'open',
    comment: '生命周期: open / resolved / expired',
  })
  declare status: string;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'resolved_at',
    comment: 'status=resolved 时填; 默认 NULL',
  })
  declare resolved_at: Date | null;

  @Column({
    type: DataType.STRING(255),
    allowNull: true,
    field: 'resolved_reason',
    comment: 'resolved/expired 时的简短原因 (e.g. "st_removed" / "manual_review_no_impact")',
  })
  declare resolved_reason: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'metadata',
    defaultValue: {},
    comment:
      '调用 metadata (cron_run_id / detector_version / raw_payload_hash / linked_risk_alert_ids[] 等)',
  })
  declare metadata: Record<string, unknown>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
