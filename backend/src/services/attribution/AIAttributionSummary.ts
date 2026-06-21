/**
 * AIAttributionSummary — L8-Postmortem / US-082 [PM-005]
 *
 * 把 PM-001 `heuristicSummary` 静态 6 维归因摘要升级到 LLM 生成: 输入 6 维
 * report → ≤ 200 字摘要 (AC §E.3: ≥ 3 数字).
 *
 * ─── 设计 (与 [[shadow→hard 三态范式]] / [[先建框架 + 后填实]] 对齐) ──────
 *
 * 本 module 纯函数 + DataSource DI seam:
 *   - AIAttributionSummaryDataSource.callLLMSummary(prompt) → string | null
 *   - buildAttributionSummaryPrompt(report) — 纯函数, 把 6 维拼成 LLM 指令
 *   - enforceAttributionSummaryConstraints(text, fallback) — hard-cap 200 字 +
 *     ≥ 3 数字 校验; 不达标退到 fallback (PM-001 heuristicSummary)
 *   - generateAIAttributionSummary(report, source?) — 主入口异步, 调 LLM →
 *     校验 → 不达标用 heuristic 兜底, 永不 throw
 *   - createProductionAIAttributionSummaryDataSource() — lazy require axios +
 *     TRADING_AGENTS_BASE_URL, 调 `/api/attribution-summary`, 与
 *     AnnouncementNLPService.callRemoteSummarize 同款 pattern
 *
 * ─── 三层校验 (US-043 AI_VIEW_MAX_CHARS 5 件套同款) ──────────────────────
 *
 * (1) prompt 上游 — buildAttributionSummaryPrompt 显式告诉 LLM
 *     "≤ {MAX_CHARS} 字 + ≥ {MIN_NUMBERS} 个具体数字"
 * (2) 中游 hard-cap — enforceAttributionSummaryConstraints 收到 LLM 返值后,
 *     超 cap 截断 + 计数字; 不达标返 fallback
 * (3) 下游 fallback — heuristic summary 由 caller 传入 (PM-001 已实现, 形如
 *     `${date} 总盈亏 ±X 元 (Y%); 主贡献行业 Z +A 元; 执行成本 B 元; 成交 N 笔`)
 *     fallback 本身天然满足 ≤200 + 含 3+ 数字 (date/total_pnl/trade_count)
 *
 * ─── fail-OPEN 三层 ───────────────────────────────────────────────────────
 *
 * - DataSource.callLLMSummary throw / 返 null/empty → fallback
 * - PRODUCTION DataSource 顶层 try/catch + axios timeout 30s + 转 null 不 throw
 * - generateAIAttributionSummary 主入口任何异常 → fallback + logger.warn
 *
 * 与 [[shadow→hard 三态]] PaperTradingFacade 等 fail-CLOSED 对偶 — AI 摘要失败
 * 用户照拿 heuristic, 不阻塞 cron / 飞书 push.
 *
 * ─── 数字计数规则 (countNumeric) ─────────────────────────────────────────
 *
 * AC §E.3 要求"≥ 3 个数字". 我们用 `/-?\d+(?:\.\d+)?/g` 全局匹配,
 * 命中浮点数/整数/负数算 1 个. 中文"3.14% 增长 12 笔" → ['3.14','12'] → 2 个.
 * 注意:
 *   - 日期 '2026-06-19' → 命中 '2026', '-06', '-19' = 3 个 (有 - 号)
 *   - "5%" → '5' = 1 个
 *   - 这条规则与 PM-001 heuristicSummary 输出 ("2026-06-19 总盈亏 +500.00 元
 *     (5%)...") 天然兼容, fallback 永远 ≥ 6 个
 *
 * 不去重 — "1000 vs 1000" 视为 2 个 (LLM 复述视为不同强调).
 *
 * ─── 与既有 service 边界 ─────────────────────────────────────────────────
 *
 * - 本 module 与 AnnouncementNLPService.callRemoteSummarize / AIAdvisorService
 *   .callRemoteAnalyze 同形态 (axios → trading_agents → 失败兜底).
 * - 调用方 = DailyAttributionService.generateDailyReport 末尾 (替换 ai_summary
 *   字段, 不破坏 PM-001 buildDailyAttributionReport 主入口签名).
 * - PM-006 cron 接入后, ai_summary 优先 LLM, 失败自动退 heuristic.
 */

import { logger } from '../../utils/logger';
import {
  DAILY_ATTRIBUTION_AI_SUMMARY_MAX_CHARS,
  DailyAttributionReport,
  heuristicSummary,
} from './DailyAttributionService';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** AC §E.3: 摘要必须含 ≥ 3 个数字 (具体业绩数). */
export const AI_ATTRIBUTION_SUMMARY_MIN_NUMBERS = 3;

/** AI 摘要 hard-cap 字数 (复用 PM-001 全局常量, 同源跨边界). */
export const AI_ATTRIBUTION_SUMMARY_MAX_CHARS = DAILY_ATTRIBUTION_AI_SUMMARY_MAX_CHARS;

/** trading_agents 端点 (与 AnnouncementNLPService.callRemoteSummarize 同款 path 风格). */
export const AI_ATTRIBUTION_SUMMARY_ENDPOINT = '/api/attribution-summary';

/** axios timeout — 30s, 与 NLP summary 同款. */
export const AI_ATTRIBUTION_SUMMARY_TIMEOUT_MS = 30_000;

/** 数字识别正则 — 浮点/整数/负数全收, 全局匹配. */
const NUMERIC_TOKEN_RE = /-?\d+(?:\.\d+)?/g;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface AIAttributionSummaryDataSource {
  /**
   * 调远端 LLM 生成摘要. 返 string 表示 LLM 返值 (未经校验, caller 会跑
   * enforceAttributionSummaryConstraints), 返 null 表示失败 (caller 用 fallback).
   * **永不 throw** (实现侧 try/catch 兜底).
   */
  callLLMSummary(prompt: string): Promise<string | null>;
}

export interface GenerateAIAttributionSummaryResult {
  /** 最终摘要 (LLM 或 fallback). 保证 ≤ MAX_CHARS + ≥ MIN_NUMBERS 数字. */
  text: string;
  /** 来源 — 'llm' (LLM 生成且合规) / 'fallback' (兜底 heuristic). */
  source: 'llm' | 'fallback';
  /** fallback 触发原因 (source='llm' 时为 null). */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/**
 * 统计文本中数字 token 个数 (含负数 / 浮点). 不去重 — 重复算多个.
 */
export function countNumericTokens(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const matches = text.match(NUMERIC_TOKEN_RE);
  return matches ? matches.length : 0;
}

/**
 * 拼 LLM prompt — 把 6 维 report 关键字段揉成自然语言指令.
 *
 * 显式告知 LLM ≤ MAX_CHARS 字 + ≥ MIN_NUMBERS 数字 (上游守约), 缺失维度
 * (factor_contrib_total=0 / placeholder) 不强提防 LLM 编造.
 */
export function buildAttributionSummaryPrompt(report: DailyAttributionReport): string {
  const lines: string[] = [];
  lines.push(
    `请用 ≤ ${AI_ATTRIBUTION_SUMMARY_MAX_CHARS} 字概述以下投资组合归因 (必须含 ≥ ${AI_ATTRIBUTION_SUMMARY_MIN_NUMBERS} 个具体数字):`
  );
  lines.push(`日期: ${report.date}`);
  lines.push(
    `总盈亏: ${report.total_pnl.toFixed(2)} 元${
      report.total_pnl_pct == null ? '' : ` (${report.total_pnl_pct.toFixed(2)}%)`
    }`
  );
  lines.push(
    `已实现: ${report.realized_pnl.toFixed(2)} 元 / 未实现增量: ${report.unrealized_delta.toFixed(
      2
    )} 元`
  );
  lines.push(`成交: ${report.trade_count} 笔 (买 ${report.buy_count} / 卖 ${report.sell_count})`);
  if (report.breakdown.industry_contrib.length > 0) {
    const top = report.breakdown.industry_contrib
      .slice(0, 3)
      .map(i => `${i.industry} ${i.pnl >= 0 ? '+' : ''}${i.pnl.toFixed(2)}`)
      .join(', ');
    lines.push(`行业贡献 top: ${top}`);
  }
  if (report.breakdown.execution_cost > 0) {
    lines.push(`执行成本: ${report.breakdown.execution_cost.toFixed(2)} 元`);
  }
  if (report.best_trades.length > 0) {
    const b = report.best_trades[0];
    lines.push(`盈利冠军: ${b.symbol} +${b.realized_pnl.toFixed(2)} 元`);
  }
  if (report.worst_trades.length > 0) {
    const w = report.worst_trades[0];
    lines.push(`亏损冠军: ${w.symbol} ${w.realized_pnl.toFixed(2)} 元`);
  }
  lines.push(
    `要求: 客观、不预测、避免"建议"动词、直接陈述事实, 不超过 ${AI_ATTRIBUTION_SUMMARY_MAX_CHARS} 字.`
  );
  return lines.join('\n');
}

/**
 * 校验 LLM 返值 — 截断到 MAX_CHARS + 检查 ≥ MIN_NUMBERS 数字.
 * 不达标返 null (caller 用 fallback); 达标返清理后的字符串.
 *
 * 清理: trim + 收敛多重换行/空格为单个空格 (LLM 常输出带"```" / "好的, 这是..."
 * 等冗余, 这里仅做轻量清理, 重处理交回 caller 决策).
 */
export function enforceAttributionSummaryConstraints(text: unknown): {
  ok: boolean;
  text: string | null;
  reason: string | null;
} {
  if (typeof text !== 'string') return { ok: false, text: null, reason: 'not_string' };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, text: null, reason: 'empty' };
  // 轻量清理 — 多重空白合并为单空格 (保留中文标点)
  let cleaned = trimmed.replace(/\s+/g, ' ');
  // hard-cap 截断 (slice 不在中间断 unicode surrogate pair, 但 200 字内的常见
  // 中英混排不会有 surrogate; 安全起见用 Array.from 算字符)
  const chars = Array.from(cleaned);
  if (chars.length > AI_ATTRIBUTION_SUMMARY_MAX_CHARS) {
    cleaned = chars.slice(0, AI_ATTRIBUTION_SUMMARY_MAX_CHARS - 1).join('') + '…';
  }
  const numCount = countNumericTokens(cleaned);
  if (numCount < AI_ATTRIBUTION_SUMMARY_MIN_NUMBERS) {
    return { ok: false, text: null, reason: `numeric_too_few_${numCount}` };
  }
  return { ok: true, text: cleaned, reason: null };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 生成 AI 摘要 — 调 LLM → 校验 → 不达标 fallback. 永不 throw.
 *
 * 行为:
 *   - source 缺失 → 直接 fallback (用 heuristicSummary)
 *   - LLM 返 null/empty → fallback
 *   - LLM 返值 < MIN_NUMBERS 数字 / 空白 → fallback
 *   - LLM 超 MAX_CHARS → 截断后再校验数字
 *
 * 反例 — 不在本 module 内决定"是否调 LLM" (caller 决定, e.g. PM-006 cron 配置
 * `ai_summary_mode: 'off'/'shadow'/'hard'` 控制是否调). 本 module 只在收到
 * source 后调一次; source=null 时直接走 fallback.
 */
export async function generateAIAttributionSummary(
  report: DailyAttributionReport,
  source?: AIAttributionSummaryDataSource | null
): Promise<GenerateAIAttributionSummaryResult> {
  // fallback 始终由 PM-001 heuristicSummary 提供, 保证 ≤ cap + ≥ 3 数字
  const fallback = enforceFallbackSummary(report);

  if (!source) {
    return { text: fallback, source: 'fallback', reason: 'no_data_source' };
  }

  let llmRaw: string | null = null;
  try {
    const prompt = buildAttributionSummaryPrompt(report);
    llmRaw = await source.callLLMSummary(prompt);
  } catch (err) {
    logger.warn(
      `[ai-attribution-summary] callLLMSummary threw: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return { text: fallback, source: 'fallback', reason: 'llm_threw' };
  }

  const check = enforceAttributionSummaryConstraints(llmRaw);
  if (!check.ok || !check.text) {
    return { text: fallback, source: 'fallback', reason: check.reason || 'llm_invalid' };
  }
  return { text: check.text, source: 'llm', reason: null };
}

/**
 * fallback summary — 调 PM-001 heuristicSummary, 保证 ≤ cap + 含 3+ 数字.
 * 极端边界 (heuristic 自身退化 < 3 数字) 兜底补 "0 元" 类占位.
 */
function enforceFallbackSummary(report: DailyAttributionReport): string {
  const h = heuristicSummary(report);
  const chars = Array.from(h);
  let safe =
    chars.length > AI_ATTRIBUTION_SUMMARY_MAX_CHARS
      ? chars.slice(0, AI_ATTRIBUTION_SUMMARY_MAX_CHARS - 1).join('') + '…'
      : h;
  // 极端 fallback — heuristic 不应失败 (输出含 date + total_pnl + trade_count
  // 至少 3 个数字), 但保险起见若 <3 数字补 placeholder
  if (countNumericTokens(safe) < AI_ATTRIBUTION_SUMMARY_MIN_NUMBERS) {
    safe = `${safe}; 默认占位 0.00 元 0 笔`.slice(0, AI_ATTRIBUTION_SUMMARY_MAX_CHARS);
  }
  return safe;
}

// ---------------------------------------------------------------------------
// PRODUCTION DataSource — lazy require axios + TRADING_AGENTS_BASE_URL
// ---------------------------------------------------------------------------

/**
 * 与 AnnouncementNLPService.callRemoteSummarize 同款形态: axios POST →
 * trading_agents → 失败转 null 不 throw. 单测进程不需要 axios 也能加载本 module
 * (PRODUCTION 在调用时才 require, 缺失时 fail-OPEN 返 null).
 */
export function createProductionAIAttributionSummaryDataSource(): AIAttributionSummaryDataSource {
  return {
    async callLLMSummary(prompt: string): Promise<string | null> {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const axios = require('axios');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { TRADING_AGENTS_BASE_URL } = require('../../config/externalServices');
        const response = await axios.default.post(
          `${TRADING_AGENTS_BASE_URL}${AI_ATTRIBUTION_SUMMARY_ENDPOINT}`,
          { prompt, max_chars: AI_ATTRIBUTION_SUMMARY_MAX_CHARS },
          { timeout: AI_ATTRIBUTION_SUMMARY_TIMEOUT_MS }
        );
        const data = response?.data;
        if (data && typeof data.summary === 'string') return data.summary;
        if (typeof data === 'string') return data;
        return null;
      } catch (err) {
        logger.warn(
          `[ai-attribution-summary] PRODUCTION callLLMSummary failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return null;
      }
    },
  };
}

export const PRODUCTION_AI_ATTRIBUTION_SUMMARY_DATA_SOURCE: AIAttributionSummaryDataSource =
  createProductionAIAttributionSummaryDataSource();
