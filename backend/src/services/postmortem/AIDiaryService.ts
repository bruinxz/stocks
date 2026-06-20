/**
 * AIDiaryService — L8-Postmortem / US-090 [PM-019] 每日 AI 投资日记主入口
 *
 * 输入 (user_id, date) → 取当日 DailyAttributionReport (主账户) → 调 LLM
 * 生成 ≤ 500 字日记 (失败用 heuristic 兜底) → upsert AIDiaryEntry. 永不 throw.
 *
 * PM-020 (US-091) AI_DIARY_GENERATE cron 在工作日 18:00 触发, 对所有 active
 * 用户调本 service 的 `generateForUser`. 本 story 只做 service 层 + 单测.
 *
 * ─── 设计 (与 [[AIAttributionSummary 5 件套]] / [[DailyAttributionFeishuPushService 6 件套]] 对齐) ───
 *
 * (1) 常量 / 类型 / 纯函数 helpers 全 export 便于单测
 * (2) AIDiaryDataSource interface 把所有 I/O (取 attribution / 取 user / upsert)
 *     抽干净 — 单测注入 fake 完全脱离 DB
 * (3) PRODUCTION_AI_DIARY_DATA_SOURCE lazy-require model / external HTTP
 * (4) 主入口 `generateForUser` 三层 fail-OPEN — 任何异常 → heuristic fallback +
 *     落库 status='failed'/'skipped', 永不向上抛
 * (5) AIDiaryLLMSource (LLM 调用) 单独抽 interface, 与 AIAttributionSummary 同款
 *
 * ─── 三层校验 (AI_VIEW_MAX_CHARS 5 件套同款) ────────────────────────────────
 *
 * (1) prompt 上游 — buildDiaryPrompt 显式告诉 LLM "≤ {MAX_CHARS} 字"
 * (2) 中游 hard-cap — enforceDiaryConstraints 收到 LLM 返值后, 超 cap 截断;
 *     空白 / 非 string / 超低字符 (< MIN_CHARS) → fallback
 * (3) 下游 fallback — heuristicDiary 从 DailyAttributionReport 静态拼一段
 *     "{date} 当日盈亏 ±X 元..." 永远满足 cap 契约
 *
 * ─── fail-OPEN 三层 ───────────────────────────────────────────────────────
 *
 * - 取 attribution 失败 / 无当日 report → skipped + reason='no_attribution_today'
 *   仍 upsert 一行做"今日跑过但跳过"留痕 (与 DailyAttributionCronRunner buildPersistRow
 *   全零留痕同款思想); 不强制必须有 report 才能写日记 — 留痕方便 PM-020 cron 看
 *   "用户 X 今天没 attribution"
 * - LLM 调用失败 / 超时 → heuristic fallback + status='ok' + source='heuristic'
 * - upsert 自身失败 → 顶层 try/catch + logger.warn, 返 status='failed' + 不抛
 *
 * ─── (user_id, date) idempotent ────────────────────────────────────────────
 *
 * 与 AIDiaryEntry model (user_id, date) UNIQUE 索引对齐, 一天重跑 (LLM 失败 +
 * cron 第二次跑 / 手动 replay) 覆盖最新结果 — sequelize upsert 走 ON CONFLICT
 * DO UPDATE.
 *
 * ─── 与既有 service 边界 ─────────────────────────────────────────────────
 *
 * - 输入端: 复用 DailyAttributionReport 落库结果 — 不重复算 6 维归因
 * - 输出端: 写 AIDiaryEntry (本 story 已上 model + migration, US-089 PM-018)
 * - PM-020 cron: 后续 story 接入 SchedulerService, 调本 service generateForUser
 *   for each active user
 * - EV-014 GET /api/me/diary/recent: 后续 story 查 AIDiaryEntry 表
 *
 * 本 story 只创建 service + 单测; cron + route 由后续 PM-020 / EV-014 各自接入.
 */

import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** PRD US-090 AC: AI 日记 ≤ 500 字. */
export const AI_DIARY_MAX_CHARS = 500;

/** 日记最少字符数 (LLM 仅返 "今日平稳" 这种 ≤ MIN_CHARS 字 → fallback). */
export const AI_DIARY_MIN_CHARS = 20;

/** trading_agents 端点 (与 AIAttributionSummary 同款 path 风格). */
export const AI_DIARY_ENDPOINT = '/api/diary-summary';

/** axios timeout — 30s, 与 NLP summary / AIAttributionSummary 同款. */
export const AI_DIARY_TIMEOUT_MS = 30_000;

/** 日记生成 source 枚举 (与 AIDiaryEntry.source 对齐). */
export const AI_DIARY_SOURCE = Object.freeze({
  LLM: 'llm',
  HEURISTIC: 'heuristic',
  MANUAL: 'manual',
} as const);

export type AIDiarySource = (typeof AI_DIARY_SOURCE)[keyof typeof AI_DIARY_SOURCE];

/** 日记生成 status 枚举 (与 AIDiaryEntry.status 对齐, 与 DailyAttributionReport 范式同源). */
export const AI_DIARY_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const);

export type AIDiaryStatus = (typeof AI_DIARY_STATUS)[keyof typeof AI_DIARY_STATUS];

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 投资日记输入摘要 — 从 DailyAttributionReport / behavior bias 等抽取的
 * 最小关键字段集. 不依赖具体 model 类型, 让本 service 与 attribution module
 * 解耦 (DataSource adapter 在 PRODUCTION 端把 DailyAttributionReport 映射成本类型).
 */
export interface DiaryContext {
  user_id: number;
  date: string;
  /** 当日 attribution report id (evidence.daily_attribution_report_id), null 表示无 */
  daily_attribution_report_id: number | null;
  /** 当日总盈亏 (元) */
  total_pnl: number;
  /** 当日总盈亏百分比 (× 100), null 表示前日 total <= 0 算不出 */
  total_pnl_pct: number | null;
  /** 当日 BUY+SELL 总笔数 */
  trade_count: number;
  /** 当日 BUY 笔数 */
  buy_count: number;
  /** 当日 SELL 笔数 */
  sell_count: number;
  /** 当日盈利 top N 股票 code (≤ 3) */
  best_trades_codes: string[];
  /** 当日亏损 top N 股票 code (≤ 3) */
  worst_trades_codes: string[];
  /** 主贡献行业 (e.g. '银行 +1500 元'); 缺数据时 [] */
  top_industries: Array<{ industry: string; pnl: number }>;
  /** 行为偏差命中条数 (PM-008 后续接入, 本 story 默认 0) */
  bias_findings_count: number;
  /** 用户名 (LLM 风格化称呼, 缺失走 '操盘手') */
  user_name?: string | null;
}

export interface AIDiaryLLMSource {
  /**
   * 调远端 LLM 生成日记正文. 返 string 表示 LLM 返值 (未经校验, caller 会跑
   * enforceDiaryConstraints), 返 null 表示失败 (caller 用 fallback).
   * **永不 throw** (实现侧 try/catch 兜底).
   */
  callLLMDiary(prompt: string): Promise<string | null>;
}

/**
 * 单测 / 生产环境的 I/O 注入点. 把 DB 调用 (取 attribution / 取 user /
 * upsert) 抽干净, 让 service 主逻辑可完全脱离 DB 单测.
 */
export interface AIDiaryDataSource {
  /**
   * 取目标 user + date 的 diary context. 找不到 attribution (今日未跑 / 用户无主账户)
   * → 返 null, caller 走 skipped 路径. **永不 throw**.
   */
  loadDiaryContext(input: { user_id: number; date: string }): Promise<DiaryContext | null>;
  /**
   * upsert 到 ai_diary_entries 表. (user_id, date) UNIQUE 走 ON CONFLICT DO UPDATE.
   * 失败返 {ok:false, reason}, **永不 throw**.
   */
  upsertDiaryEntry(
    row: AIDiaryUpsertRow
  ): Promise<{ ok: boolean; reason?: string; error?: string }>;
}

export interface AIDiaryUpsertRow {
  user_id: number;
  date: string;
  text: string;
  evidence: Record<string, unknown>;
  source: string;
  status: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  generated_at: Date;
}

export interface GenerateDiaryResult {
  status: AIDiaryStatus;
  /** ok 时 = 落库日记正文; skipped/failed 时 = 占位 (heuristic 或 '') */
  text: string;
  source: AIDiarySource;
  /** skipped / failed / heuristic fallback 时的原因; ok+llm 时 null */
  reason: string | null;
  /** evidence snapshot (与 AIDiaryEntry.evidence 字段对应) */
  evidence: Record<string, unknown>;
  /** 是否真的 upsert 落库成功 (failed 时仍可能 = false) */
  persisted: boolean;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/**
 * 构造 LLM prompt — 把 DiaryContext 关键字段拼成自然语言指令.
 * 显式告知 LLM ≤ MAX_CHARS 字 (上游守约), 缺失维度不强提防 LLM 编造.
 */
export function buildDiaryPrompt(ctx: DiaryContext): string {
  const lines: string[] = [];
  const name = ctx.user_name || '操盘手';
  lines.push(
    `请以"${name}"的口吻, 用 ≤ ${AI_DIARY_MAX_CHARS} 字写一则当日投资日记 (第一人称, 客观反思):`
  );
  lines.push(`日期: ${ctx.date}`);
  const sign = ctx.total_pnl > 0 ? '+' : '';
  const pctStr =
    ctx.total_pnl_pct == null
      ? ''
      : ` (${ctx.total_pnl_pct >= 0 ? '+' : ''}${ctx.total_pnl_pct.toFixed(2)}%)`;
  lines.push(`当日盈亏: ${sign}${ctx.total_pnl.toFixed(2)} 元${pctStr}`);
  lines.push(`成交: ${ctx.trade_count} 笔 (买 ${ctx.buy_count} / 卖 ${ctx.sell_count})`);
  if (ctx.top_industries.length > 0) {
    const top = ctx.top_industries
      .slice(0, 3)
      .map(i => `${i.industry} ${i.pnl >= 0 ? '+' : ''}${i.pnl.toFixed(2)}`)
      .join(', ');
    lines.push(`行业贡献: ${top}`);
  }
  if (ctx.best_trades_codes.length > 0) {
    lines.push(`盈利标的: ${ctx.best_trades_codes.slice(0, 3).join(', ')}`);
  }
  if (ctx.worst_trades_codes.length > 0) {
    lines.push(`亏损标的: ${ctx.worst_trades_codes.slice(0, 3).join(', ')}`);
  }
  if (ctx.bias_findings_count > 0) {
    lines.push(`行为偏差命中: ${ctx.bias_findings_count} 条`);
  }
  lines.push(
    `要求: 第一人称、客观、可执行的复盘语气, 包含 1 条经验教训, 不预测、不给买卖建议, 不超过 ${AI_DIARY_MAX_CHARS} 字.`
  );
  return lines.join('\n');
}

/**
 * 校验 LLM 返值 — trim + 合并多重空白 + 超 cap 截断 + 检查最少字符数.
 * 不达标返 ok=false (caller 用 fallback); 达标返清理后字符串.
 */
export function enforceDiaryConstraints(text: unknown): {
  ok: boolean;
  text: string | null;
  reason: string | null;
} {
  if (typeof text !== 'string') return { ok: false, text: null, reason: 'not_string' };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, text: null, reason: 'empty' };
  // 多重空白合并 (LLM 常输出 markdown 风格的空行 / 缩进)
  let cleaned = trimmed.replace(/\s+/g, ' ');
  const chars = Array.from(cleaned);
  if (chars.length > AI_DIARY_MAX_CHARS) {
    cleaned = chars.slice(0, AI_DIARY_MAX_CHARS - 1).join('') + '…';
  }
  const finalLen = Array.from(cleaned).length;
  if (finalLen < AI_DIARY_MIN_CHARS) {
    return { ok: false, text: null, reason: `too_short_${finalLen}` };
  }
  return { ok: true, text: cleaned, reason: null };
}

/**
 * heuristic 兜底日记 — 从 DiaryContext 静态拼接, 永远满足 ≤ MAX_CHARS + 含
 * 关键数字 (日期 / 盈亏 / 成交). 不抛.
 */
export function heuristicDiary(ctx: DiaryContext): string {
  const lines: string[] = [];
  const name = ctx.user_name || '操盘手';
  const sign = ctx.total_pnl > 0 ? '+' : '';
  const pctStr =
    ctx.total_pnl_pct == null
      ? ''
      : ` (${ctx.total_pnl_pct >= 0 ? '+' : ''}${ctx.total_pnl_pct.toFixed(2)}%)`;
  lines.push(`${ctx.date} ${name}: 当日盈亏 ${sign}${ctx.total_pnl.toFixed(2)} 元${pctStr}`);
  lines.push(`成交 ${ctx.trade_count} 笔 (买${ctx.buy_count}/卖${ctx.sell_count})`);
  if (ctx.top_industries.length > 0) {
    const topI = ctx.top_industries[0];
    const indSign = topI.pnl >= 0 ? '+' : '';
    lines.push(`主贡献行业 ${topI.industry} ${indSign}${topI.pnl.toFixed(2)} 元`);
  }
  if (ctx.best_trades_codes.length > 0) {
    lines.push(`盈利标的 ${ctx.best_trades_codes.slice(0, 3).join('/')}`);
  }
  if (ctx.worst_trades_codes.length > 0) {
    lines.push(`亏损标的 ${ctx.worst_trades_codes.slice(0, 3).join('/')}`);
  }
  if (ctx.bias_findings_count > 0) {
    lines.push(`行为偏差命中 ${ctx.bias_findings_count} 条, 待复盘`);
  }
  lines.push(`备忘: 严格止损 / 避免追涨 / 仓位纪律.`);
  let out = lines.join('; ');
  const chars = Array.from(out);
  if (chars.length > AI_DIARY_MAX_CHARS) {
    out = chars.slice(0, AI_DIARY_MAX_CHARS - 1).join('') + '…';
  }
  return out;
}

/**
 * 从 DiaryContext 构造 evidence snapshot — 落到 AIDiaryEntry.evidence JSONB.
 * 与 AIDiaryEntry model 注释的 evidence 字段对齐.
 */
export function buildDiaryEvidence(ctx: DiaryContext): Record<string, unknown> {
  return {
    daily_attribution_report_id: ctx.daily_attribution_report_id,
    total_pnl: ctx.total_pnl,
    total_pnl_pct: ctx.total_pnl_pct,
    trade_count: ctx.trade_count,
    bias_findings_count: ctx.bias_findings_count,
    best_trades_codes: ctx.best_trades_codes.slice(0, 3),
    worst_trades_codes: ctx.worst_trades_codes.slice(0, 3),
    top_industries: ctx.top_industries.slice(0, 3),
    data_sources: buildDataSourcesList(ctx),
  };
}

/** evidence.data_sources — 字符串数组, 标记日记引用了哪些上游数据源. */
export function buildDataSourcesList(ctx: DiaryContext): string[] {
  const sources: string[] = [];
  if (ctx.daily_attribution_report_id != null) sources.push('attribution');
  if (ctx.bias_findings_count > 0) sources.push('bias');
  if (ctx.top_industries.length > 0) sources.push('industry');
  if (ctx.best_trades_codes.length > 0 || ctx.worst_trades_codes.length > 0) {
    sources.push('trades');
  }
  return sources;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * generateForUser — PM-019 主入口.
 *
 * 流程:
 *   (1) 调 ds.loadDiaryContext(user_id, date) → null = skipped 落留痕行返回
 *   (2) 有 LLMSource 调 callLLMDiary → 校验 → 不达标 fallback heuristic
 *   (3) 无 LLMSource 直接 heuristic
 *   (4) upsert ai_diary_entries — 失败 logger.warn 不抛, 返 persisted=false
 *
 * 行为契约:
 *   - 任何阶段异常 (loadDiaryContext throw / upsert throw / LLM throw) →
 *     fail-OPEN 转 status='failed' + 仍尝试落留痕 (LLM 失败时落 heuristic)
 *   - persisted=false 时调用方 (PM-020 cron) 应 logger.warn + Prometheus 计数
 *     但不阻塞批内其他用户
 *   - 日记主旨 = 留痕 / 可解释, 不是关键路径; 失败默默吞错符合 [[fail-OPEN]] 范式
 */
export async function generateForUser(
  userId: number,
  options: {
    date: string;
    data_source: AIDiaryDataSource;
    /** LLM 调用源, null/缺失 = 跳过 LLM 直接 heuristic */
    llm_source?: AIDiaryLLMSource | null;
    /** 'cron' / 'manual' / 'replay' 等; 落 metadata.cron_run_id 用 */
    cron_run_id?: string | null;
  }
): Promise<GenerateDiaryResult> {
  const { date, data_source: ds, llm_source: llmSource, cron_run_id } = options;
  const baseMetadata: Record<string, unknown> = {};
  if (cron_run_id != null) baseMetadata.cron_run_id = cron_run_id;

  // (1) 取 context
  let ctx: DiaryContext | null = null;
  try {
    ctx = await ds.loadDiaryContext({ user_id: userId, date });
  } catch (err) {
    logger.warn(
      `[ai-diary] loadDiaryContext user=${userId} date=${date} threw: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    // 上游 throw 视为 skipped — 不落留痕 (无 context 无 evidence)
    return {
      status: AI_DIARY_STATUS.SKIPPED,
      text: '',
      source: AI_DIARY_SOURCE.HEURISTIC,
      reason: 'load_context_threw',
      evidence: {},
      persisted: false,
    };
  }

  if (!ctx) {
    // 无 attribution today — upsert 留痕行 (空 text + status=skipped)
    const upsertRes = await safeUpsert(ds, {
      user_id: userId,
      date,
      text: '',
      evidence: {},
      source: AI_DIARY_SOURCE.HEURISTIC,
      status: AI_DIARY_STATUS.SKIPPED,
      reason: 'no_attribution_today',
      metadata: { ...baseMetadata, skipped_reason: 'no_attribution_today' },
      generated_at: new Date(),
    });
    return {
      status: AI_DIARY_STATUS.SKIPPED,
      text: '',
      source: AI_DIARY_SOURCE.HEURISTIC,
      reason: 'no_attribution_today',
      evidence: {},
      persisted: upsertRes.ok,
    };
  }

  // (2/3) 调 LLM → 校验 → fallback heuristic
  const evidence = buildDiaryEvidence(ctx);
  const llmMetadata: Record<string, unknown> = { ...baseMetadata };
  const decision = await decideDiaryText(ctx, llmSource ?? null, llmMetadata, userId, date);

  // (4) upsert
  const upsertRes = await safeUpsert(ds, {
    user_id: userId,
    date,
    text: decision.text,
    evidence,
    source: decision.source,
    status: AI_DIARY_STATUS.OK,
    reason: decision.reason,
    metadata: llmMetadata,
    generated_at: new Date(),
  });

  if (!upsertRes.ok) {
    return {
      status: AI_DIARY_STATUS.FAILED,
      text: decision.text,
      source: decision.source,
      reason: upsertRes.reason || 'upsert_failed',
      evidence,
      persisted: false,
    };
  }
  return {
    status: AI_DIARY_STATUS.OK,
    text: decision.text,
    source: decision.source,
    reason: decision.reason,
    evidence,
    persisted: true,
  };
}

/**
 * 决定最终 diary text + source — 优先 LLM, 不达标 fallback heuristic. 永不 throw.
 * llmMetadata 边走边填 (latency / engine / fallback_reason).
 */
async function decideDiaryText(
  ctx: DiaryContext,
  llmSource: AIDiaryLLMSource | null,
  llmMetadata: Record<string, unknown>,
  userId: number,
  date: string
): Promise<{ text: string; source: AIDiarySource; reason: string | null }> {
  if (!llmSource) {
    llmMetadata.heuristic_fallback_reason = 'no_llm_source';
    return {
      text: heuristicDiary(ctx),
      source: AI_DIARY_SOURCE.HEURISTIC,
      reason: 'no_llm_source',
    };
  }

  let llmRaw: string | null = null;
  let threw = false;
  const t0 = Date.now();
  try {
    const prompt = buildDiaryPrompt(ctx);
    llmRaw = await llmSource.callLLMDiary(prompt);
  } catch (err) {
    threw = true;
    logger.warn(
      `[ai-diary] callLLMDiary user=${userId} date=${date} threw: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  llmMetadata.llm_latency_ms = Date.now() - t0;

  if (threw) {
    llmMetadata.heuristic_fallback_reason = 'llm_threw';
    return { text: heuristicDiary(ctx), source: AI_DIARY_SOURCE.HEURISTIC, reason: 'llm_threw' };
  }

  if (llmRaw === null) {
    llmMetadata.heuristic_fallback_reason = 'llm_returned_null';
    return {
      text: heuristicDiary(ctx),
      source: AI_DIARY_SOURCE.HEURISTIC,
      reason: 'llm_returned_null',
    };
  }

  const check = enforceDiaryConstraints(llmRaw);
  if (!check.ok || !check.text) {
    const reason = check.reason || 'llm_invalid';
    llmMetadata.heuristic_fallback_reason = reason;
    return { text: heuristicDiary(ctx), source: AI_DIARY_SOURCE.HEURISTIC, reason };
  }
  llmMetadata.llm_engine = 'trading_agents';
  return { text: check.text, source: AI_DIARY_SOURCE.LLM, reason: null };
}

/**
 * upsert 包一层 try/catch — DataSource 实现侧本身已 try/catch 不抛, 这里再
 * 兜一层防 fake / production 差异.
 */
async function safeUpsert(
  ds: AIDiaryDataSource,
  row: AIDiaryUpsertRow
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await ds.upsertDiaryEntry(row);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason || 'upsert_returned_false' };
  } catch (err) {
    logger.warn(
      `[ai-diary] upsertDiaryEntry user=${row.user_id} date=${row.date} threw: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return { ok: false, reason: 'upsert_threw' };
  }
}

// ---------------------------------------------------------------------------
// PRODUCTION LLM source — lazy require axios + TRADING_AGENTS_BASE_URL
// ---------------------------------------------------------------------------

/**
 * 与 AIAttributionSummary.createProductionAIAttributionSummaryDataSource 同款形态:
 * axios POST → trading_agents → 失败转 null 不 throw. 单测进程不需要 axios
 * 也能加载本 module (PRODUCTION 在调用时才 require).
 */
export function createProductionAIDiaryLLMSource(): AIDiaryLLMSource {
  return {
    async callLLMDiary(prompt: string): Promise<string | null> {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const axios = require('axios');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { TRADING_AGENTS_BASE_URL } = require('../../config/externalServices');
        const response = await axios.default.post(
          `${TRADING_AGENTS_BASE_URL}${AI_DIARY_ENDPOINT}`,
          { prompt, max_chars: AI_DIARY_MAX_CHARS },
          { timeout: AI_DIARY_TIMEOUT_MS }
        );
        const data = response?.data;
        if (data && typeof data.diary === 'string') return data.diary;
        if (data && typeof data.summary === 'string') return data.summary;
        if (typeof data === 'string') return data;
        return null;
      } catch (err) {
        logger.warn(
          `[ai-diary] PRODUCTION callLLMDiary failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// PRODUCTION DataSource — lazy require AIDiaryEntry + DailyAttributionReport + User
// ---------------------------------------------------------------------------

/**
 * 把 DailyAttributionReport 行映射成 DiaryContext. 缺数据时降级 (e.g. 行业
 * 列表为空 / best_trades 缺 symbol → 空数组), 永不 throw.
 */
export function mapAttributionRowToContext(
  row: Record<string, unknown>,
  userId: number,
  userName: string | null
): DiaryContext {
  const breakdown = (row.breakdown as Record<string, unknown>) || {};
  const industryContrib = Array.isArray(
    (breakdown as { industry_contrib?: unknown }).industry_contrib
  )
    ? ((breakdown as { industry_contrib?: unknown }).industry_contrib as Array<
        Record<string, unknown>
      >)
    : [];
  const best = Array.isArray(row.best_trades)
    ? (row.best_trades as Array<Record<string, unknown>>)
    : [];
  const worst = Array.isArray(row.worst_trades)
    ? (row.worst_trades as Array<Record<string, unknown>>)
    : [];
  return {
    user_id: userId,
    date: String(row.date),
    daily_attribution_report_id: row.id == null ? null : Number(row.id),
    total_pnl: Number(row.total_pnl) || 0,
    total_pnl_pct: row.total_pnl_pct == null ? null : Number(row.total_pnl_pct),
    trade_count: Number(row.trade_count) || 0,
    buy_count: Number(row.buy_count) || 0,
    sell_count: Number(row.sell_count) || 0,
    best_trades_codes: best
      .map(t => String(t.symbol || ''))
      .filter(s => s.length > 0)
      .slice(0, 3),
    worst_trades_codes: worst
      .map(t => String(t.symbol || ''))
      .filter(s => s.length > 0)
      .slice(0, 3),
    top_industries: industryContrib
      .slice(0, 3)
      .map(i => ({ industry: String(i.industry || ''), pnl: Number(i.pnl) || 0 }))
      .filter(i => i.industry.length > 0),
    bias_findings_count: Array.isArray(row.bias_findings)
      ? (row.bias_findings as unknown[]).length
      : 0,
    user_name: userName,
  };
}

export function createProductionAIDiaryDataSource(): AIDiaryDataSource {
  return {
    async loadDiaryContext({ user_id, date }) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PaperTradingPortfolio } = require('../../models/PaperTradingPortfolio');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DailyAttributionReport } = require('../../models/DailyAttributionReport');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { User } = require('../../models/User');

        // 取主账户 (用户第一个 is_active=true 的 paper portfolio); 多账户场景
        // 与 AIDiaryEntry doc "evidence.daily_attribution_report_id 取主账户" 对齐
        const portfolio = await PaperTradingPortfolio.findOne({
          where: { user_id, is_active: true },
          order: [['id', 'ASC']],
        });
        if (!portfolio) return null;
        const report = await DailyAttributionReport.findOne({
          where: { portfolio_id: portfolio.id, date, status: 'ok' },
        });
        if (!report) return null;
        const user = await User.findByPk(user_id);
        return mapAttributionRowToContext(
          report.toJSON ? report.toJSON() : report,
          user_id,
          user?.username ?? user?.name ?? null
        );
      } catch (err) {
        logger.warn(
          `[ai-diary] PRODUCTION loadDiaryContext user=${user_id} date=${date} failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return null;
      }
    },
    async upsertDiaryEntry(row) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { AIDiaryEntry } = require('../../models/AIDiaryEntry');
        await AIDiaryEntry.upsert(row);
        return { ok: true };
      } catch (err) {
        logger.warn(
          `[ai-diary] PRODUCTION upsertDiaryEntry user=${row.user_id} date=${row.date} failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return {
          ok: false,
          reason: 'persist_failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export const PRODUCTION_AI_DIARY_LLM_SOURCE: AIDiaryLLMSource = createProductionAIDiaryLLMSource();
export const PRODUCTION_AI_DIARY_DATA_SOURCE: AIDiaryDataSource =
  createProductionAIDiaryDataSource();
