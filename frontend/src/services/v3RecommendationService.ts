import api from './api';

/**
 * CA-1 v3 推荐 (抖音风刷卡片) 前端 API 客户端.
 *
 * 调用 2 个后端端点 (backend/src/api/controllers/V3RecommendationController.ts):
 *   GET /api/today/v3-recommendations?limit=N&date=YYYY-MM-DD  → getV3Recommendations()
 *   GET /api/today/v3-funnel?date=YYYY-MM-DD                   → getV3Funnel()
 *
 * Service 边界与 todayWorkspaceService 一致:
 *   - 响应封套 `{ success, data, message? }` 在 service 层解开, 直接返 `data`;
 *   - `success === false` 抛 JS Error (component try/catch 接);
 *   - 不在 service 层做格式化 / colorize — UI 自己挑色.
 */

// ---------------------------------------------------------------------------
//  类型 — 字段名严格匹配 V3RecommendationController.enrichSignal() 输出
// ---------------------------------------------------------------------------

/** 4 维评分单项 (人气 / 逻辑 / 资金 / 结构), 由 aggregateToV3Dimensions 折叠 8 维 analyzer 而来. */
export interface V3DimensionItem {
  /** 维度 key — 'popularity' / 'logic' / 'capital' / 'structure'. */
  key: 'popularity' | 'logic' | 'capital' | 'structure';
  /** 中文 label — '人气' / '逻辑' / '资金' / '结构'. */
  label: string;
  /** UI 进度条直接用的归一值 ∈ [0,100]. */
  bar_value: number;
  /** 原始加权分 ∈ [-100,+100], 让上层算 tier 用. */
  raw_score: number;
  /** 子维 confidence 简单平均 ∈ [0,1]. */
  confidence: number;
  /** 命中的子 analyzer 数 (0 = 全缺数据, raw_score 兜底 0). */
  subs_present: number;
}

/** 20d sparkline 点 — backend 升序排列 (oldest → newest). */
export interface V3SparklinePoint {
  date: string;
  close: number;
}

/** 决策子对象 — analysis_engine archive metadata + decision 字段透传. */
export interface V3RecommendationDecision {
  /** 引擎原始 action — strong_buy / buy / add / ... */
  action: string;
  /** Normalize 后的 decision ('buy' / 'strong_buy' / ...). */
  normalized_decision: string;
  /** 0-100 标度 confidence_score (analysis_engine 落库时已乘 100). */
  confidence_score: number | null;
  /** 'high' / 'medium' / 'low' / null. */
  risk_level: string | null;
  /** [低, 高] 入场区间, 缺数据 null. */
  entry_zone: [number, number] | null;
  /** 单一止损价, 缺数据 null. */
  stop_loss: number | null;
  /** 单一止盈价, 缺数据 null. */
  take_profit: number | null;
  /** 建议仓位百分比 ∈ [0,1]. */
  suggested_position_pct: number | null;
  /** 'open' / 'maintain' / 'close' / 'avoid'. */
  position_action: string | null;
  /** 引擎自定义 tier (与 confidence_tier 同义, 透传防 UI 双计算). */
  confidence_tier_engine: 'high' | 'medium' | 'low' | null;
  /** 风险提示文本数组, 卡片侧栏 / detail modal 用. */
  risk_warnings: string[];
}

/**
 * CA-2 场景化 5 档 playbook — 由 backend `buildScenarioPlaybook` 生成. null = 不适用
 * (action=sell/strong_sell 或 prev_close 缺失).
 *
 * 5 档 bucket 固定顺序: high_strong → high_weak → flat → low_mild → low_hard.
 * UI 渲染按数组顺序即可, 不需要 sort.
 */
export type V3ScenarioBucket = 'high_strong' | 'high_weak' | 'flat' | 'low_mild' | 'low_hard';

export interface V3PlaybookItem {
  bucket: V3ScenarioBucket;
  /** "高开 +2% 以上" — UI 直接展示. */
  trigger: string;
  /** "可积极参与 · 放量突破信号 · 止损 ¥99.96" — UI 直接展示. */
  action: string;
  /** 数值止损价 (元), 仅 high_strong / high_weak / low_mild 会给; null 不渲染止损. */
  stop_loss: number | null;
  /** "buy" / "hold" / "observe" / "avoid" — UI 决定颜色 / 强弱. */
  verdict: 'buy' | 'hold' | 'observe' | 'avoid';
  /** true → 红色 left-border + 警告 icon. */
  avoid: boolean;
}

/** 单条 v3 推荐. */
export interface V3RecommendationItem {
  symbol: string;
  name: string | null;
  industry: string | null;
  /** 单位: 元 (1e8 = 1 亿). UI 自己换算. */
  circulating_market_cap: number | null;
  total_market_cap: number | null;
  current_price: number | null;
  change_pct: number | null;
  turnover_rate: number | null;
  amplitude_pct: number | null;
  /** 20d 累计涨跌 %. */
  cumulative_change_pct_20d: number | null;
  sparkline: V3SparklinePoint[];
  dimensions: V3DimensionItem[];
  /** 4 维 bar_value 平均归类 — UI 卡片左上角徽标用. */
  confidence_tier: 'high' | 'medium' | 'low';
  /** 引擎 overall_confidence ∈ [0,1], 缺数据 null. */
  overall_confidence: number | null;
  /** 最多 3 个高亮 tag — ['超大市值','题材活跃','放量突破']. */
  highlight_tags: string[];
  /** 一句话推荐理由, 缺数据 null. */
  recommend_reason: string | null;
  decision: V3RecommendationDecision;
  /** CA-2: 场景化 5 档操作建议. null = 不适用 (action=sell 或 prev_close 缺失). */
  playbook: V3PlaybookItem[] | null;
  /**
   * CA-3: 结构化技术面摘要 — 一段 markdown 文本.
   *   例: "今日+1.37%, 窄幅震荡, 换手率 13.9% 适中, 量比 13.85 巨量,
   *        成交额 41.3 亿 (大额成交), 市值 3204 亿 (超大盘),
   *        上涨逻辑: 题材活跃 · 资金流入, 近 20 日 -6.4% 中期调整."
   * 缺数据时仍出至少 "上涨逻辑: 技术形态."; ctx 全 null 给兜底文案; minimal view = null.
   */
  technical_summary?: string | null;
  /**
   * CA-3: 观察点 — 最多 5 条 bullet, "接下来需要盯什么".
   * 任一触发器不满足则该条不出, 至少 0 条 (UI 0 条整段不渲染).
   */
  observation_points?: string[];
  /**
   * CA-3: 风险硬规则 — 最多 3 条, "什么情况就放弃".
   * 默认 2 条 always 出 (低开 -3% / 竞价缩量), ST/超买/遇阻 追加, ST 命中优先级最高.
   * UI 必须用红框 + warning icon 突出.
   */
  risk_rules?: string[];
  /** AIInvestmentSignal.id, 跳详情用. */
  signal_id: number;
  /** 后端归档时的 signal_date (YYYY-MM-DD). */
  signal_date: string;
  /**
   * PR-W (2026-06-30) — 信号创建时间 ISO (后端 signal.created_at 透传).
   * 前端 /home 推荐卡用 formatHourMin 显示 "信号 HH:MM". 缺失则不显示时间标签.
   */
  created_at?: string | null;
  /**
   * PR-W (2026-06-30) — 信号分类: 区分 "推荐" vs "盘中异动观察".
   *   recommendation — 真推荐 (多因子综合 / 涨停板战法 / 题材发酵等, 应当行动)
   *   watch          — 仅观察 (盘中价量异动单点信号, 用户自己判断)
   * 前端应 2 个 section 分开展示, 不能让用户误把 "watch" 当推荐跟单.
   */
  signal_kind?: 'recommendation' | 'watch';
  /**
   * PR-H (2026-06-29) — 推荐时机标签 (后端透传, 缺失默认 'overnight').
   *   opening_rush     — 🌅 早盘抢 (9:25 集合竞价后, 9:30-10:00 买)
   *   afternoon_kick   — ☀️ 午后攻 (12:55, 13:00-13:30 买)
   *   closing_grab     — 🌆 尾盘埋 (14:30, 14:30-14:55 买)
   *   overnight        — 🌙 隔夜潜伏 (15:32, **次日** 9:30 集合竞价后买)
   *   intraday_anomaly — ⚡ 盘中异动 (实时, 30 min 内买)
   */
  timing_tag?: 'opening_rush' | 'afternoon_kick' | 'closing_grab' | 'overnight' | 'intraday_anomaly';
  /**
   * PR-O2 (2026-06-29) — 涨停板战法 pattern key (后端 LimitUpBoardDetector 写入).
   * 仅 source_type='limit_up_board' 的 signal 才非空; 其它 source 默认 null.
   * 前端 /home 推荐卡见到非空就额外加一个 "🚀 一字板" / "📈 二板加速" 等 badge.
   * 值域: one_word / t_word / broken / strong_first_board / weak_to_strong / zhongjun /
   *       second_board_accelerate / second_board_refill / second_board_filling / two_to_three /
   *       high_consecutive_accelerate / consecutive_height_play / consecutive_ladder /
   *       di_tian / broken_refill_next_day / limit_down_refill /
   *       broken_refill / broken_refill_with_turnover /
   *       leader_takeover / follow_play
   */
  limit_up_pattern?: string | null;
  /** PR-O2 — 中文 label (e.g. "一字板", "二板加速"), 后端 PR-I-v2 战法名透传. */
  limit_up_pattern_label?: string | null;
  /** PR-O2 — 当日连板数 (含当日). 1 = 首板; 2 = 二板. */
  limit_up_continuous_days?: number | null;
  /**
   * PR-O5 (2026-06-30) — 题材发酵 5 阶段 (后端透传, 缺失 → 字段 null, badge 自动隐藏).
   *   germinate — 🌱 萌芽 (1-3 只票轻微异动, 信号弱, 不推)
   *   launch    — 🚀 启动 (首只涨停, 推次龙头 + 跟风)
   *   outbreak  — 🔥 爆发 (涨停 5+, 推中军 + 龙头接力)
   *   climax    — 💥 高潮 (涨停 10+, **不推, 持仓 reduce**)
   *   recession — 📉 退潮 (炸板率高 / 较昨日减半, 推主线切换)
   */
  theme_phase?: 'germinate' | 'launch' | 'outbreak' | 'climax' | 'recession' | null;
  theme_phase_label?: string | null;
  theme_phase_icon?: string | null;
  /** 当日热点主线 (composite_score top-3 + phase ∈ {launch, outbreak, climax}). */
  theme_is_mainline?: boolean;
  /** enrichSignal 失败兜底视图标记 — UI 可选显示 "数据加载部分失败" 提示. */
  enrich_failed?: boolean;
}

/** 漏斗统计 — 顶部条 "今日筛选 X 只候选 / Y 只达标 / 推荐 Z 只" 用. */
export interface V3FunnelStats {
  /** 全市场上市股票数 — Daily Screener universe 同口径. */
  scanned: number;
  /** 当日所有 AI 生成 signal 数 (analysis_engine + quant_recommendation + tradingagents). */
  candidate: number;
  /** 当日 BUY/STRONG_BUY 数. */
  selected: number;
  /** 'YYYY-MM-DD'. */
  as_of: string;
}

export interface V3RecommendationData {
  as_of: string;
  recommendations: V3RecommendationItem[];
  funnel: V3FunnelStats;
}

export interface V3RecommendationResponse {
  success: boolean;
  data: V3RecommendationData;
  message?: string;
}

// ---------------------------------------------------------------------------
//  API
// ---------------------------------------------------------------------------

export async function getV3Recommendations(
  opts: {
    limit?: number;
    date?: string;
  } = {}
): Promise<V3RecommendationData> {
  const res = await api.get('/today/v3-recommendations', {
    params: {
      ...(opts.limit ? { limit: opts.limit } : {}),
      ...(opts.date ? { date: opts.date } : {}),
    },
  });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取 v3 推荐失败');
  }
  return res.data.data as V3RecommendationData;
}

export async function getV3Funnel(date?: string): Promise<V3FunnelStats> {
  const res = await api.get('/today/v3-funnel', {
    params: date ? { date } : undefined,
  });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取 v3 漏斗失败');
  }
  return res.data.data as V3FunnelStats;
}

// ---------------------------------------------------------------------------
//  bundled export
// ---------------------------------------------------------------------------

export const v3RecommendationService = {
  getV3Recommendations,
  getV3Funnel,
};

export default v3RecommendationService;
