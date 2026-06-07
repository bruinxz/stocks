import axios from 'axios';
import { logger } from '../utils/logger';
import { DataSourceHealthService } from '../data/services/DataSourceHealthService';
import { AIStockAnalysisReport } from '../models/AIStockAnalysisReport';
import { Stock } from '../models/Stock';
import { normalizeSymbol } from '../utils/stockSymbol';

const TRADING_AGENTS_URL = process.env.TRADING_AGENTS_URL || 'http://47.93.224.109:8000';

export function normalizeTradingAgentsError(error: any): string {
  let raw = '';
  if (typeof error === 'string') {
    raw = error;
  } else if (error?.message || error?.error || error?.detail) {
    raw = error.message || error.error || error.detail;
  } else {
    try {
      raw = JSON.stringify(error || '');
    } catch {
      raw = String(error || '');
    }
  }
  const message = String(raw || '').trim();

  if (!message) return 'TradingAgents 远端任务失败，未返回具体原因';

  if (
    message === "'日期'" ||
    message.includes("KeyError: '日期'") ||
    message.includes("Remote AI task failed: '日期'")
  ) {
    return [
      'TradingAgents 行情缓存日期字段异常：本地 CSV/接口返回缺少“日期”列，或并发写入缓存时读到了半成品文件。',
      '系统已补强日期字段归一化与原子写入；如仍出现，请重启 TradingAgents 并重跑该股票分析。',
    ].join('');
  }

  if (message.includes('Cannot calculate requested indicators')) {
    return 'TradingAgents 技术指标计算失败：模型请求了不支持的指标，已降级为跳过该指标并继续分析。';
  }

  return message;
}

// ---------------------------------------------------------------------------
//  US-055 — 单股深度问答 (analyzeSingleStock)
// ---------------------------------------------------------------------------

/**
 * AC 指定的 5 个 dimensions。
 *
 * `Object.freeze` 防止模块级常量被意外 mutate（US-037 codebase pattern）。
 */
export const ANALYSIS_DIMENSIONS = Object.freeze([
  'fundamental',
  'technical',
  'capital',
  'news',
  'sentiment',
] as const);

export type AnalysisDimension = (typeof ANALYSIS_DIMENSIONS)[number];

/**
 * 5 大维度的中文标签 —— 用于 buildAnalysisSummary 的 markdown 拼装。
 */
export const ANALYSIS_DIMENSION_LABELS: Record<AnalysisDimension, string> = Object.freeze({
  fundamental: '基本面',
  technical: '技术面',
  capital: '资金面',
  news: '新闻面',
  sentiment: '情绪面',
});

/** US-055 analyzeSingleStock 选项 */
export interface SingleStockAnalysisOptions {
  /** 要分析的维度子集；不传默认全部 5 维度 */
  dimensions?: AnalysisDimension[];
  /** 目标分析日期（YYYY-MM-DD）；不传则为当日 */
  target_date?: string;
  /** 触发用户 ID（system / cron 触发可省略） */
  user_id?: number;
  /** 已知股票名称（避免 DataSource 再查一次） */
  stock_name?: string;
  /** dry_run=true 时只跑 TradingAgents 不写表，UI 预演用 */
  dry_run?: boolean;
  /**
   * 异步任务模式：传 true 时 TradingAgents 后台跑，立即返回 task_id；
   * 默认 false 同步返回 final report。
   */
  is_async?: boolean;
  /**
   * 任务来源标签（PaperTradingWorkspace / FactorWorkspace 等）。
   * 写入 metadata.task_label 让 ops 区分入口。
   */
  task_label?: string;
}

/**
 * AnalyzeSingleStockResult — 内部返回类型 + DB 持久化记录的并集形态。
 * 与 OptimizationResultRecord (US-037) 同款 "plain-object 返回类型" 范式：
 * persist=true 和 persist=false 都返回同一类型，让单测无需 boot Sequelize。
 */
export interface AnalyzeSingleStockResult {
  report_id: string;
  stock_code: string;
  stock_name: string | null;
  dimensions: AnalysisDimension[];
  summary: string;
  recommendation: string;
  confidence_score: number | null;
  risk_level: string | null;
  key_points: Record<string, string[]>;
  status: 'completed' | 'partial' | 'failed' | 'pending';
  task_id: string | null;
  target_date: string | null;
  error: string | null;
  generated_at: string; // ISO timestamp
  metadata: Record<string, unknown>;
  /** True iff a row was actually persisted (false = dry_run / persist disabled). */
  persisted: boolean;
}

/**
 * DataSource 注入接口 —— 与 US-040/041/042/044 等 "可测诊断工具" 范式一致：
 * (1) 定义 `interface XxxSource`；
 * (2) 提供 `PRODUCTION_XXX_SOURCE` singleton 走真实数据源；
 * (3) options.<xxx>_source 默认走 PRODUCTION；
 * (4) 测试 makeFakeXxxSource(...) 完全脱离 DB + 外部网络。
 */
export interface AIStockAnalysisDataSource {
  /** 远端 TradingAgents 调用 (一次同步分析，返回 raw payload)。 */
  callRemoteAnalyze(
    ticker: string,
    targetDate?: string,
    isAsync?: boolean
  ): Promise<RemoteAnalyzePayload>;
  /** 持久化报告到 AIStockAnalysisReport 表；dry_run / persist=false 时跳过。 */
  saveReport(record: AnalyzeSingleStockResult): Promise<void>;
  /** 反查股票名称（report 落库时 snapshot stock_name 用）。返回 null 表示未找到。 */
  resolveStockName(stockCode: string): Promise<string | null>;
}

/** TradingAgents /api/analyze 的 raw 返回形态。 */
export interface RemoteAnalyzePayload {
  status?: string;
  task_id?: string;
  ticker?: string;
  target_date?: string;
  data?: {
    decision?: string;
    rationale?: string;
    detail?: any;
    confidence?: number;
    confidence_score?: number;
    risk_level?: string;
    /** key_points 可由 TradingAgents 自带，或留空让 buildKeyPoints 从 rationale 推断 */
    key_points?: Record<string, string[]>;
    /** 失败时由 service 自身写入的错误描述（不是 TradingAgents 的字段） */
    error?: string;
    [k: string]: any;
  };
  [k: string]: any;
}

// ---------------------------------------------------------------------------
//  Pure helpers (export for unit tests — no DB / no axios)
// ---------------------------------------------------------------------------

/**
 * 净化 dimensions 数组：
 * - 不在 ANALYSIS_DIMENSIONS 中的字符串静默丢弃；
 * - 去重保持顺序；
 * - 空 / 不传 → 全 5 维度（与 AC 默认一致）；
 * - 大小写不敏感 (FUNDAMENTAL → fundamental)。
 *
 * 与 normalizeXxxConfig (US-047..US-053) 同款"沉默退回默认不 4xx"。
 */
export function normalizeAnalysisDimensions(raw: any): AnalysisDimension[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...ANALYSIS_DIMENSIONS];
  }
  const seen = new Set<AnalysisDimension>();
  const out: AnalysisDimension[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const lower = item.trim().toLowerCase();
    if ((ANALYSIS_DIMENSIONS as readonly string[]).includes(lower)) {
      const d = lower as AnalysisDimension;
      if (!seen.has(d)) {
        seen.add(d);
        out.push(d);
      }
    }
  }
  return out.length > 0 ? out : [...ANALYSIS_DIMENSIONS];
}

/**
 * 把 TradingAgents 原始 decision string ("BUY" / "买入" / "强烈推荐") 规范化为
 * AISignalDecision enum 值 ("buy" / "strong_buy" / "hold" 等)。
 *
 * - 与 AIInvestmentSignalService.normalizeDecisionLabel 同款映射规则（避免两套口径）；
 * - 空 / 无法识别 → 'unknown'；
 * - 大小写不敏感；中英文混排都能识别。
 */
export function normalizeRecommendation(raw: any): string {
  if (!raw) return 'unknown';
  const text = String(raw).trim().toLowerCase();
  if (!text) return 'unknown';

  // 强烈类
  if (/(strong[_\-\s]*buy|强烈[买推]|重点推荐)/.test(text)) return 'strong_buy';
  if (/(strong[_\-\s]*sell|强烈[卖减]|强烈减持)/.test(text)) return 'strong_sell';

  // 中性类
  if (/(hold|持[有仓]|观[望察]|中性|neutral)/.test(text)) return 'hold';

  // 普通买卖
  if (/(buy|加仓|增持|推荐|买入)/.test(text)) return 'buy';
  if (/(sell|减[仓持]|卖出|清仓)/.test(text)) return 'sell';

  return 'unknown';
}

/**
 * 从 TradingAgents detail 字段抽取 per-dimension 核心要点。
 *
 * - detail.key_points 直接传过来：直接采用并按 dimensions 过滤；
 * - detail 是 string：把整段当 fundamental 一条 key point；
 * - detail 是 object 含 fundamental_summary 等子字段：智能映射；
 * - 缺失维度填空数组而非省略（前端 UI 渲染统一）。
 */
export function buildKeyPoints(
  detail: any,
  dimensions: AnalysisDimension[]
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const d of dimensions) out[d] = [];

  if (!detail) return out;

  // 优先采用 TradingAgents 已结构化的 key_points
  if (
    detail.key_points &&
    typeof detail.key_points === 'object' &&
    !Array.isArray(detail.key_points)
  ) {
    for (const d of dimensions) {
      const v = detail.key_points[d];
      if (Array.isArray(v)) {
        out[d] = v.map((x: any) => String(x)).filter(s => s.trim().length > 0);
      } else if (typeof v === 'string' && v.trim().length > 0) {
        out[d] = [v.trim()];
      }
    }
    return out;
  }

  // 智能映射子字段（fundamental_summary / technical_summary 等）
  const subfieldMap: Record<AnalysisDimension, string[]> = {
    fundamental: ['fundamental_summary', 'fundamental', 'financials', 'valuation'],
    technical: ['technical_summary', 'technical', 'indicators'],
    capital: ['capital_summary', 'capital_flow', 'fund_flow', 'main_flow'],
    news: ['news_summary', 'news', 'announcements'],
    sentiment: ['sentiment_summary', 'sentiment', 'mood', 'kol_summary'],
  };
  let hitAny = false;
  for (const d of dimensions) {
    for (const key of subfieldMap[d]) {
      const v = detail[key];
      if (Array.isArray(v)) {
        out[d] = v.map((x: any) => String(x)).filter(s => s.trim().length > 0);
        hitAny = true;
        break;
      } else if (typeof v === 'string' && v.trim().length > 0) {
        out[d] = [v.trim()];
        hitAny = true;
        break;
      }
    }
  }
  if (hitAny) return out;

  // 兜底：detail 整体是 string → 当 fundamental
  if (
    typeof detail === 'string' &&
    detail.trim().length > 0 &&
    dimensions.includes('fundamental')
  ) {
    out.fundamental = [detail.trim()];
  }

  return out;
}

/**
 * 拼装人类可读 markdown 摘要 —— 前端 Modal 顶部直接渲染。
 *
 * Layout:
 *   **【AI 解读 · sh.600519 · 贵州茅台】**
 *   - 综合建议：买入 (置信 85 / 风险 低)
 *   - 基本面：核心要点 1...
 *   - 技术面：...
 *   ...
 *
 * - dimensions 缺失或 key_points 为空时该维度行省略；
 * - stock_name 缺失时只显示 stock_code。
 */
export function buildAnalysisSummary(
  stockCode: string,
  stockName: string | null,
  recommendation: string,
  confidenceScore: number | null,
  riskLevel: string | null,
  dimensions: AnalysisDimension[],
  keyPoints: Record<string, string[]>
): string {
  const header = stockName
    ? `**【AI 解读 · ${stockCode} · ${stockName}】**`
    : `**【AI 解读 · ${stockCode}】**`;

  const recoLabelMap: Record<string, string> = {
    strong_buy: '强烈买入',
    buy: '买入',
    hold: '持有 / 观望',
    sell: '卖出',
    strong_sell: '强烈卖出',
    unknown: '暂无明确建议',
  };
  const recoLabel = recoLabelMap[recommendation] || recommendation;

  const recoParts = [`- 综合建议：${recoLabel}`];
  if (confidenceScore !== null && Number.isFinite(confidenceScore)) {
    recoParts.push(`置信 ${Math.round(confidenceScore)}`);
  }
  if (riskLevel) {
    recoParts.push(`风险 ${riskLevel}`);
  }
  const recoLine =
    recoParts.length > 1 ? `${recoParts[0]} (${recoParts.slice(1).join(' / ')})` : recoParts[0];

  const lines: string[] = [header, recoLine];
  for (const d of dimensions) {
    const points = keyPoints[d] || [];
    if (points.length === 0) continue;
    const label = ANALYSIS_DIMENSION_LABELS[d];
    if (points.length === 1) {
      lines.push(`- ${label}：${points[0]}`);
    } else {
      lines.push(`- ${label}：`);
      for (const p of points) {
        lines.push(`  - ${p}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * 生成业务级唯一 report_id。
 *
 * 格式：`AI-{stock_code_short}-{YYYYMMDDHHmmss}-{rand4}`
 *   e.g. `AI-600519-20260608101530-a3f9`
 *
 * - stock_code_short 去掉 `sh.` / `sz.` 前缀（保持 ID 短便于 UI 引用）；
 * - 时间戳精度到秒（同一秒多次调用 rand4 兜底冲突）；
 * - 调用方可传入 `now` 让测试稳定化（不传则用 Date.now）。
 */
export function buildReportId(stockCode: string, now: Date = new Date()): string {
  const short = stockCode.replace(/^(sh|sz|bj)\./i, '');
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `AI-${short}-${y}${m}${d}${hh}${mm}${ss}-${rand}`;
}

/**
 * 把 TradingAgents raw payload 折叠成 AnalyzeSingleStockResult（pure transform）。
 *
 * - 失败 payload (status='FAILED' / 缺 data) → status='failed' + error；
 * - 异步任务 (is_async=true) → status='pending' + task_id；
 * - 同步完成 (status='COMPLETED' + data) → status='completed'；
 * - 部分维度缺数据（key_points 中存在空数组） → status='partial'。
 */
export function buildResultFromPayload(
  payload: RemoteAnalyzePayload,
  ctx: {
    report_id: string;
    stock_code: string;
    stock_name: string | null;
    dimensions: AnalysisDimension[];
    target_date: string | null;
    metadata: Record<string, unknown>;
    is_async: boolean;
    now: Date;
  }
): AnalyzeSingleStockResult {
  const statusRaw = String(payload?.status || '').toUpperCase();

  // 异步任务（TradingAgents 后台跑）
  if (ctx.is_async || statusRaw === 'PENDING' || statusRaw === 'RUNNING') {
    return {
      report_id: ctx.report_id,
      stock_code: ctx.stock_code,
      stock_name: ctx.stock_name,
      dimensions: ctx.dimensions,
      summary: '',
      recommendation: 'unknown',
      confidence_score: null,
      risk_level: null,
      key_points: Object.fromEntries(ctx.dimensions.map(d => [d, []])) as Record<string, string[]>,
      status: 'pending',
      task_id: payload?.task_id || null,
      target_date: ctx.target_date,
      error: null,
      generated_at: ctx.now.toISOString(),
      metadata: { ...ctx.metadata, raw_status: statusRaw },
      persisted: false,
    };
  }

  // 失败 payload
  if (statusRaw === 'FAILED' || !payload?.data) {
    const err =
      normalizeTradingAgentsError(payload?.data || payload) ||
      'TradingAgents 返回了未识别的响应结构';
    return {
      report_id: ctx.report_id,
      stock_code: ctx.stock_code,
      stock_name: ctx.stock_name,
      dimensions: ctx.dimensions,
      summary: '',
      recommendation: 'unknown',
      confidence_score: null,
      risk_level: null,
      key_points: Object.fromEntries(ctx.dimensions.map(d => [d, []])) as Record<string, string[]>,
      status: 'failed',
      task_id: payload?.task_id || null,
      target_date: ctx.target_date,
      error: err,
      generated_at: ctx.now.toISOString(),
      metadata: { ...ctx.metadata, raw_status: statusRaw },
      persisted: false,
    };
  }

  // 成功 payload
  const data = payload.data;
  const recommendation = normalizeRecommendation(data.decision);
  const keyPoints = buildKeyPoints(data.detail || data, ctx.dimensions);
  const filledDims = ctx.dimensions.filter(d => (keyPoints[d] || []).length > 0).length;
  const status: 'completed' | 'partial' =
    filledDims === ctx.dimensions.length ? 'completed' : 'partial';

  const confidence = Number.isFinite(data.confidence_score)
    ? Number(data.confidence_score)
    : Number.isFinite(data.confidence)
    ? Number(data.confidence)
    : null;

  const summary = buildAnalysisSummary(
    ctx.stock_code,
    ctx.stock_name,
    recommendation,
    confidence,
    data.risk_level || null,
    ctx.dimensions,
    keyPoints
  );

  return {
    report_id: ctx.report_id,
    stock_code: ctx.stock_code,
    stock_name: ctx.stock_name,
    dimensions: ctx.dimensions,
    summary,
    recommendation,
    confidence_score: confidence,
    risk_level: data.risk_level || null,
    key_points: keyPoints,
    status,
    task_id: payload?.task_id || null,
    target_date: ctx.target_date,
    error: status === 'partial' ? '部分维度缺失关键要点（key_points 不完整）' : null,
    generated_at: ctx.now.toISOString(),
    metadata: { ...ctx.metadata, raw_status: statusRaw || 'COMPLETED' },
    persisted: false,
  };
}

// ---------------------------------------------------------------------------
//  Default production DataSource
// ---------------------------------------------------------------------------

class DefaultAIStockAnalysisDataSource implements AIStockAnalysisDataSource {
  async callRemoteAnalyze(
    ticker: string,
    targetDate?: string,
    isAsync = false
  ): Promise<RemoteAnalyzePayload> {
    try {
      const response = await axios.post(`${TRADING_AGENTS_URL}/api/analyze`, {
        ticker,
        target_date: targetDate,
        is_async: isAsync,
      });
      return response.data;
    } catch (error: any) {
      const message = normalizeTradingAgentsError(error.response?.data?.detail || error);
      logger.error(`AIAdvisorService.analyzeSingleStock remote call failed: ${message}`);
      // 转成 FAILED payload 让上层 buildResultFromPayload 走失败分支（避免 throw 阻断主流程）
      return { status: 'FAILED', data: { error: message } };
    }
  }

  async saveReport(record: AnalyzeSingleStockResult): Promise<void> {
    await AIStockAnalysisReport.create({
      report_id: record.report_id,
      user_id: (record.metadata?.user_id as number | undefined) ?? null,
      stock_code: record.stock_code,
      stock_name: record.stock_name,
      dimensions: record.dimensions,
      summary: record.summary,
      recommendation: record.recommendation,
      confidence_score: record.confidence_score,
      risk_level: record.risk_level,
      key_points_json: record.key_points,
      status: record.status,
      task_id: record.task_id,
      target_date: record.target_date,
      error: record.error,
      generated_at: new Date(record.generated_at),
      metadata: record.metadata,
    } as any);
  }

  async resolveStockName(stockCode: string): Promise<string | null> {
    try {
      const stock = await Stock.findOne({
        where: { symbol: stockCode },
        attributes: ['name'],
      });
      return stock?.name || null;
    } catch (err: any) {
      logger.warn(`AIAdvisorService.resolveStockName failed for ${stockCode}: ${err.message}`);
      return null;
    }
  }
}

export const PRODUCTION_AI_STOCK_ANALYSIS_DATA_SOURCE: AIStockAnalysisDataSource =
  new DefaultAIStockAnalysisDataSource();

// ---------------------------------------------------------------------------
//  AIAdvisorService
// ---------------------------------------------------------------------------

export class AIAdvisorService {
  private readonly dataSource: AIStockAnalysisDataSource;

  constructor(dataSource: AIStockAnalysisDataSource = PRODUCTION_AI_STOCK_ANALYSIS_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 获取 TradingAgents 健康与能力元信息
   */
  async getHealth(refresh = false) {
    if (refresh) {
      await DataSourceHealthService.probeTradingAgents();
    }

    const providers = await DataSourceHealthService.getHealthSnapshots();
    const tradingAgents = providers.find(provider => provider.provider_name === 'tradingagents');

    if (tradingAgents) {
      return {
        ...tradingAgents,
        base_url: tradingAgents.metadata?.base_url || TRADING_AGENTS_URL,
      };
    }

    const startedAt = Date.now();
    try {
      const response = await axios.get(`${TRADING_AGENTS_URL}/health`, { timeout: 5000 });
      return {
        provider_name: 'tradingagents',
        provider_label: 'TradingAgents',
        status: response.data?.status === 'ok' ? 'healthy' : 'degraded',
        health_score: response.data?.status === 'ok' ? 90 : 60,
        base_url: TRADING_AGENTS_URL,
        last_latency_ms: Date.now() - startedAt,
        metadata: response.data || {},
      };
    } catch (error: any) {
      logger.warn(`TradingAgents health probe failed: ${error.message}`);
      return {
        provider_name: 'tradingagents',
        provider_label: 'TradingAgents',
        status: 'unhealthy',
        health_score: 0,
        base_url: TRADING_AGENTS_URL,
        last_latency_ms: Date.now() - startedAt,
        last_error: error.message,
      };
    }
  }

  /**
   * 提交同步/异步分析任务
   */
  async analyzeStock(ticker: string, targetDate?: string, isAsync = false) {
    try {
      const response = await axios.post(`${TRADING_AGENTS_URL}/api/analyze`, {
        ticker,
        target_date: targetDate,
        is_async: isAsync,
      });
      return response.data;
    } catch (error: any) {
      const message = normalizeTradingAgentsError(error.response?.data?.detail || error);
      logger.error(`AIAdvisorService analyzeStock failed: ${message}`);
      throw new Error(message || '调用 AI 智能体服务失败');
    }
  }

  /**
   * 查询异步任务状态
   */
  async getTaskStatus(taskId: string) {
    try {
      const response = await axios.get(`${TRADING_AGENTS_URL}/api/tasks/${taskId}`);
      return response.data;
    } catch (error: any) {
      const message = normalizeTradingAgentsError(error.response?.data?.detail || error);
      logger.error(`AIAdvisorService getTaskStatus failed: ${message}`);
      throw new Error(message || '查询 AI 智能体任务状态失败');
    }
  }

  /**
   * US-055 — 单股深度问答（接入 TradingAgents）。
   *
   * 对一只股票按指定 dimensions 跑一次完整 AI 解读，
   * 返回 AnalyzeSingleStockResult 并持久化到 AIStockAnalysisReport 表。
   *
   * 设计要点：
   *   - **5 维度复用单一 TradingAgents 调用**：远端 /api/analyze 一次返回多面解读，
   *     本地按 dimensions 切分 key_points。如未来 dimensions 需要分别调用不同的
   *     AI endpoint，DataSource 接口可扩展为 `callRemoteAnalyze(ticker, dimension)`
   *     并 Promise.all 合并，调用方无需感知；
   *   - **空 dimensions 默认 5 维度全跑**（与 AC 一致）；
   *   - **failed / partial 仍落表**（status 字段标记）—— 让用户能看到"曾经尝试过"
   *     避免重复触发；
   *   - **dry_run=true 不写表**仍返回 AnalyzeSingleStockResult（前端可预览结果再决定保存）；
   *   - **stock_name 自动反查**：option 未传时通过 DataSource.resolveStockName 取一次；
   *   - **fail-OPEN 在持久化层**：saveReport 抛错时记 logger.warn + 把 error 写到 metadata，
   *     **不**让 DB 故障阻塞返回（让 UI 能看到 AI 分析结果，DB 后补也行）；
   *   - **buildReportId 时间戳精度到秒** + 4-hex random suffix 防同秒冲突。
   */
  async analyzeSingleStock(
    stockCode: string,
    options: SingleStockAnalysisOptions = {}
  ): Promise<AnalyzeSingleStockResult> {
    const normalizedCode = normalizeSymbol(stockCode) || stockCode;
    const dimensions = normalizeAnalysisDimensions(options.dimensions);
    const isAsync = options.is_async === true;
    const dryRun = options.dry_run === true;
    const now = new Date();
    const reportId = buildReportId(normalizedCode, now);

    const stockName =
      typeof options.stock_name === 'string' && options.stock_name.trim().length > 0
        ? options.stock_name.trim()
        : await this.dataSource.resolveStockName(normalizedCode);

    const metadata: Record<string, unknown> = {
      user_id: options.user_id ?? null,
      task_label: options.task_label ?? null,
      request_dimensions: options.dimensions ?? null,
      requested_at: now.toISOString(),
    };

    // 调远端（同步/异步）
    let payload: RemoteAnalyzePayload;
    try {
      payload = await this.dataSource.callRemoteAnalyze(
        normalizedCode,
        options.target_date,
        isAsync
      );
    } catch (err: any) {
      // DataSource 实现层应该已经 try/catch，此处只是双重防御
      payload = { status: 'FAILED', data: { error: normalizeTradingAgentsError(err) } };
    }

    const result = buildResultFromPayload(payload, {
      report_id: reportId,
      stock_code: normalizedCode,
      stock_name: stockName,
      dimensions,
      target_date: options.target_date || null,
      metadata,
      is_async: isAsync,
      now,
    });

    if (dryRun) {
      return result;
    }

    try {
      await this.dataSource.saveReport(result);
      result.persisted = true;
    } catch (err: any) {
      // fail-OPEN：DB 故障不阻塞 UI 拿到结果；metadata 记 save_error 供事后调查
      logger.warn(
        `AIAdvisorService.analyzeSingleStock saveReport failed (report_id=${reportId}): ${err.message}`
      );
      result.metadata = { ...result.metadata, save_error: err.message };
    }

    return result;
  }
}

export const aiAdvisorService = new AIAdvisorService();
