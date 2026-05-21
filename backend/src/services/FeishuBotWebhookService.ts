import axios, { AxiosInstance } from 'axios';
import moment from 'moment-timezone';
import { logger } from '../utils/logger';

export type FeishuRecommendationScenario =
  | 'quant_daily_pipeline'
  | 'automated_recommendation_loop'
  | 'paper_trading_auto_sync'
  | 'paper_trading_risk_check';

export interface FeishuRecommendationSummaryPayload {
  scenario: FeishuRecommendationScenario;
  result: any;
  record_type?: string;
  title?: string;
  max_items?: number;
}

export interface FeishuBotWebhookSendResult {
  success: boolean;
  skipped?: boolean;
  message?: string;
  data?: any;
}

type FeishuPostElement = {
  tag: 'text' | 'a';
  text: string;
  href?: string;
};

type NormalizedRecommendation = {
  symbol: string;
  name: string;
  current_price?: number;
  score?: number;
  action_label?: string;
  position_pct?: number;
  status?: string;
  reason?: string;
  risk_level?: string;
  amount?: number;
  trace_url?: string;
};

type NormalizedRiskExit = {
  symbol: string;
  name: string;
  latest_price?: number;
  execute_price?: number;
  pnl_pct?: number;
  reason_label?: string;
  status?: string;
  holding_days?: number;
  realized_pnl?: number;
};

const DEFAULT_MAX_ITEMS = 5;

function toNumber(value: any): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstNumber(...values: any[]): number | undefined {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function firstText(...values: any[]): string {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function toBoolean(value: any, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

/**
 * 飞书自定义机器人 webhook 客户端。
 *
 * 只负责“短消息通知”：
 * - 多维表格仍由 FeishuTaskReportService 负责沉淀完整记录；
 * - 这里发送给用户决策用的简洁摘要，失败不影响主流程。
 */
class FeishuBotWebhookService {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      timeout: Number(process.env.FEISHU_BOT_WEBHOOK_TIMEOUT_MS || 10000),
    });
  }

  isEnabled(): boolean {
    if (toBoolean(process.env.DISABLE_FEISHU_BOT_WEBHOOK, false)) return false;
    return Boolean(this.getWebhookUrl());
  }

  async sendRecommendationSummary(
    payload: FeishuRecommendationSummaryPayload
  ): Promise<FeishuBotWebhookSendResult> {
    const webhook = this.getWebhookUrl();
    if (!this.isEnabled() || !webhook) {
      return {
        success: false,
        skipped: true,
        message: '飞书机器人 webhook 未配置，已跳过荐股摘要推送',
      };
    }

    const post = this.buildRecommendationPost(payload);
    if (post.content.length === 0) {
      return {
        success: false,
        skipped: true,
        message: '荐股摘要为空，已跳过飞书机器人推送',
      };
    }

    try {
      const response = await this.http.post(webhook, {
        msg_type: 'post',
        content: {
          post: {
            zh_cn: post,
          },
        },
      });
      const body = response.data || {};
      const rawCode = body.code ?? body.StatusCode ?? body.status_code ?? 0;
      const code = Number(rawCode);
      if (Number.isFinite(code) && code !== 0) {
        const message = body.msg || body.message || body.StatusMessage || '飞书机器人返回失败';
        logger.warn(`飞书机器人荐股摘要推送失败: code=${code}, message=${message}`);
        return { success: false, message, data: body };
      }

      logger.info(`飞书机器人荐股摘要已推送: ${post.title}`);
      return { success: true, data: body };
    } catch (error: any) {
      const message = error?.response?.data?.msg || error?.message || '飞书机器人推送异常';
      logger.warn(`飞书机器人荐股摘要推送异常: ${message}`);
      return { success: false, message };
    }
  }

  private getWebhookUrl(): string {
    return firstText(process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK, process.env.FEISHU_BOT_WEBHOOK);
  }

  private buildRecommendationPost(payload: FeishuRecommendationSummaryPayload): {
    title: string;
    content: FeishuPostElement[][];
  } {
    if (payload.scenario === 'paper_trading_risk_check') {
      return this.buildRiskCheckPost(payload);
    }

    const result = payload.result || {};
    const scenarioLabel = this.getScenarioLabel(payload.scenario, payload.record_type);
    const maxItems = Math.max(
      1,
      Math.min(
        8,
        firstNumber(payload.max_items, process.env.FEISHU_RECOMMENDATION_BOT_MAX_ITEMS) ||
          DEFAULT_MAX_ITEMS
      )
    );
    const recommendations = this.extractRecommendations(result).slice(0, maxItems);
    const totalCount = this.resolveTotalRecommendationCount(result, recommendations.length);
    const paper = this.resolvePaperTrading(result);
    const riskLine = this.buildRiskLine(result);
    const scopeLine = this.buildScopeLine(result, payload.scenario);
    const timeLine = moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm');
    const runtimeBlockLine = this.buildRuntimeBlockLine(result);

    const lines = [
      runtimeBlockLine || this.buildConclusionLine(totalCount, recommendations.length, paper),
      scopeLine,
      runtimeBlockLine ? this.buildConclusionLine(totalCount, recommendations.length, paper) : '',
      recommendations.length ? '' : '标的：暂无满足条件的买入候选，建议观望。',
    ].filter(Boolean);

    return {
      title: payload.title || this.getScenarioTitle(payload.scenario, scenarioLabel),
      content: [
        ...lines.map(line => [{ tag: 'text' as const, text: line }]),
        ...recommendations.map((item, index) => this.formatRecommendationLine(item, index + 1)),
        [{ tag: 'text' as const, text: `${riskLine}｜时间：${timeLine}` }],
      ],
    };
  }

  private buildRiskCheckPost(payload: FeishuRecommendationSummaryPayload): {
    title: string;
    content: FeishuPostElement[][];
  } {
    const result = payload.result || {};
    const scenarioLabel = this.getScenarioLabel(payload.scenario, payload.record_type);
    const maxItems = Math.max(
      1,
      Math.min(
        5,
        firstNumber(payload.max_items, process.env.FEISHU_RECOMMENDATION_BOT_MAX_ITEMS) ||
          DEFAULT_MAX_ITEMS
      )
    );
    const exits = this.extractRiskExits(result).slice(0, maxItems);
    const timeLine = moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm');
    const riskLine = this.buildRiskLine(result);
    const lines = [
      this.buildRiskCheckConclusionLine(result, exits.length),
      this.buildRiskScopeLine(result),
      exits.length ? '' : '卖出标的：暂无触发止损/止盈/卖出信号，继续观察持仓。',
      ...exits.map((item, index) => this.formatRiskExitLine(item, index + 1)),
      `${riskLine}｜时间：${timeLine}`,
    ].filter(Boolean);

    return {
      title: payload.title || this.getScenarioTitle(payload.scenario, scenarioLabel),
      content: lines.map(line => [{ tag: 'text', text: line }]),
    };
  }

  private getScenarioLabel(scenario: FeishuRecommendationScenario, recordType?: string): string {
    if (recordType) return recordType;
    if (scenario === 'quant_daily_pipeline') return '量化交易场景推荐';
    if (scenario === 'automated_recommendation_loop') return '全市场荐股闭环';
    if (scenario === 'paper_trading_risk_check') return '模拟盘风控退出';
    return '模拟盘推荐同步';
  }

  private getScenarioTitle(scenario: FeishuRecommendationScenario, scenarioLabel: string): string {
    if (scenario === 'paper_trading_risk_check') return `风控摘要｜${scenarioLabel}`;
    if (scenario === 'paper_trading_auto_sync') return `模拟盘摘要｜${scenarioLabel}`;
    if (scenario === 'automated_recommendation_loop') return `荐股闭环摘要｜${scenarioLabel}`;
    return `开盘荐股摘要｜${scenarioLabel}`;
  }

  private buildConclusionLine(
    totalCount: number,
    shownCount: number,
    paper: Record<string, any>
  ): string {
    const executed = Number(paper.executed || 0);
    const planned = Number(paper.planned || 0);
    const skipped = Number(paper.skipped || 0);
    const tradeText =
      executed > 0
        ? `模拟盘已买入 ${executed} 笔`
        : planned > 0
        ? `模拟盘计划买入 ${planned} 笔`
        : '模拟盘未新增买入';
    if (totalCount <= 0) {
      return `结论：本轮暂无可执行推荐，${tradeText}。`;
    }
    const skipText = skipped > 0 ? `，跳过 ${skipped} 条` : '';
    const topText = totalCount > shownCount ? `，下方展示 Top ${shownCount}` : '';
    return `结论：本轮推荐 ${totalCount} 只，${tradeText}${skipText}${topText}。`;
  }

  private buildScopeLine(result: any, scenario: FeishuRecommendationScenario): string {
    const generated = result?.generated || {};
    const agent = result?.agent_analysis || {};
    const tradeDate =
      result?.trade_date ||
      generated?.as_of ||
      (result?.generated_at ? String(result.generated_at).slice(0, 10) : '');
    const universe =
      result?.universe === 'favorites' || generated?.universe === 'favorites' ? '自选池' : '全市场';
    const scanCount =
      generated?.scanned_stocks ??
      generated?.analyzed_candidates ??
      generated?.total_candidates ??
      result?.scanned;
    const agentText =
      agent?.enabled === false
        ? 'Agent未启用'
        : Array.isArray(agent?.submitted)
        ? `Agent复核 ${agent.submitted.length} 只`
        : '';
    const scenarioText =
      scenario === 'quant_daily_pipeline'
        ? '量化'
        : scenario === 'automated_recommendation_loop'
        ? '闭环'
        : scenario === 'paper_trading_risk_check'
        ? '风控'
        : '模拟盘';

    return [
      `范围：${universe}`,
      tradeDate ? `交易日 ${tradeDate}` : '',
      scanCount !== undefined ? `${scenarioText}扫描 ${scanCount} 只` : '',
      agentText,
    ]
      .filter(Boolean)
      .join('｜');
  }

  private buildRiskLine(result: any): string {
    const paper = this.resolvePaperTrading(result);
    const riskProfile = result?.risk_profile || paper?.risk_profile || {};
    const riskGate = result?.risk_profile_gate || paper?.risk_profile_gate || {};
    const status = riskProfile?.status || {};
    const gateAction = String(riskGate?.action || '').toLowerCase();
    const gateLabel =
      gateAction === 'pause'
        ? '暂停新增'
        : gateAction === 'reduce'
        ? '降仓验证'
        : gateAction === 'observe'
        ? '小仓观察'
        : '';
    const label = firstText(status.label, gateLabel, '正常');
    const conclusion = this.safeText(firstText(status.conclusion, riskGate.reason), 54);
    return `风控：${label}${conclusion ? `｜${conclusion}` : ''}`;
  }

  private buildRuntimeBlockLine(result: any): string {
    if (!result?.runtime_risk_blocked) return '';
    const runtimeHealth = result?.runtime_health || {};
    const conclusion = this.safeText(
      firstText(runtimeHealth?.summary?.conclusion, result?.message, '运行时健康存在风险项'),
      68
    );
    const score = runtimeHealth?.score !== undefined ? `，健康分 ${runtimeHealth.score}` : '';
    return `结论：运行时风险阻断，本轮只归档观察，不执行模拟买入${score}。原因：${conclusion}`;
  }

  private resolvePaperTrading(result: any): Record<string, any> {
    return result?.paper_trading || (Array.isArray(result?.trades) ? result : {}) || {};
  }

  private resolveTotalRecommendationCount(result: any, fallback: number): number {
    const generatedRecommendations = Array.isArray(result?.generated?.recommendations)
      ? result.generated.recommendations.length
      : undefined;
    return (
      firstNumber(
        result?.fusion?.selected_count,
        result?.archive?.total,
        generatedRecommendations,
        result?.eligible,
        Array.isArray(result?.trades) ? result.trades.length : undefined,
        fallback
      ) || 0
    );
  }

  private buildRiskCheckConclusionLine(result: any, shownCount: number): string {
    const checked = firstNumber(result?.checked, result?.positions?.length) || 0;
    const exited = firstNumber(result?.exited) || 0;
    const planned = firstNumber(result?.planned) || 0;
    const held = firstNumber(result?.held) || 0;
    const skipped = firstNumber(result?.skipped) || 0;
    const actionCount = exited > 0 ? exited : planned;
    const actionLabel = exited > 0 ? '已模拟卖出' : planned > 0 ? '计划卖出' : '暂无卖出';
    const shownText = actionCount > shownCount && shownCount > 0 ? `，展示 Top ${shownCount}` : '';
    const skippedText = skipped > 0 ? `，跳过 ${skipped} 只` : '';
    return `结论：检查 ${checked} 只持仓，${actionLabel} ${actionCount} 只，继续持有 ${held} 只${skippedText}${shownText}。`;
  }

  private buildRiskScopeLine(result: any): string {
    const dryRun = toBoolean(result?.dry_run, false);
    const portfolioText = result?.portfolio_id ? `组合#${result.portfolio_id}` : '自主模拟盘';
    const policy = result?.adaptive_risk_policy || {};
    const policyText = policy?.applied
      ? `自适应风控：止损${this.formatNumber(
          policy.effective_stop_loss_pct,
          1
        )}%/止盈${this.formatNumber(policy.effective_take_profit_pct, 1)}%`
      : '固定风控阈值';
    return `范围：${portfolioText}｜${dryRun ? '预演不成交' : '已按规则结算'}｜${policyText}`;
  }

  private extractRiskExits(result: any): NormalizedRiskExit[] {
    const sources = [
      Array.isArray(result?.exits) ? result.exits : [],
      Array.isArray(result?.exit_candidates) ? result.exit_candidates : [],
    ];
    const items: NormalizedRiskExit[] = [];
    for (const source of sources) {
      for (const raw of source) {
        if (!raw?.symbol) continue;
        items.push({
          symbol: String(raw.symbol).trim(),
          name: firstText(raw.name, raw.stock_name, raw.symbol),
          latest_price: firstNumber(raw.latest_price, raw.current_price, raw.execute_price),
          execute_price: firstNumber(raw.execute_price),
          pnl_pct: firstNumber(raw.pnl_pct, raw.realized_pnl_pct, raw.unrealized_pnl_pct),
          reason_label: firstText(raw.reason_label, raw.reason, raw.message),
          status: firstText(raw.status),
          holding_days: firstNumber(raw.holding_days),
          realized_pnl: firstNumber(raw.realized_pnl),
        });
      }
      if (items.length > 0) break;
    }
    return items.sort(
      (a, b) => Math.abs(Number(b.pnl_pct || 0)) - Math.abs(Number(a.pnl_pct || 0))
    );
  }

  private extractRecommendations(result: any): NormalizedRecommendation[] {
    const sources: any[][] = [
      Array.isArray(result?.fusion?.top_candidates) ? result.fusion.top_candidates : [],
      Array.isArray(result?.generated?.recommendations) ? result.generated.recommendations : [],
      Array.isArray(result?.archive?.candidates) ? result.archive.candidates : [],
      Array.isArray(result?.paper_trading?.trades) ? result.paper_trading.trades : [],
      Array.isArray(result?.trades) ? result.trades : [],
    ];

    const bySymbol = new Map<string, NormalizedRecommendation>();
    for (const items of sources) {
      for (const raw of items) {
        const normalized = this.normalizeRecommendation(raw);
        if (!normalized?.symbol) continue;
        const exists = bySymbol.get(normalized.symbol);
        bySymbol.set(normalized.symbol, {
          ...(exists || {}),
          ...normalized,
          current_price: normalized.current_price ?? exists?.current_price,
          score: normalized.score ?? exists?.score,
          position_pct: normalized.position_pct ?? exists?.position_pct,
          reason: normalized.reason || exists?.reason,
          action_label: normalized.action_label || exists?.action_label,
          status: normalized.status || exists?.status,
          amount: normalized.amount ?? exists?.amount,
          trace_url: normalized.trace_url || exists?.trace_url,
        });
      }
    }

    return [...bySymbol.values()].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  }

  private normalizeRecommendation(raw: any): NormalizedRecommendation | null {
    if (!raw || !raw.symbol) return null;
    const metadata = raw.metadata || {};
    const rawFactors = raw.factors?.best_raw_factors || {};
    const symbol = String(raw.symbol).trim();
    const reasons = Array.isArray(raw.reasons)
      ? raw.reasons
      : Array.isArray(metadata.reasons)
      ? metadata.reasons
      : [];
    const reason = this.safeReason(
      firstText(raw.reason, raw.tier_reason, reasons[0], raw.rationale, metadata.tier_reason)
    );
    const status = firstText(raw.status);
    const actionLabel = this.resolveActionLabel(raw, status);

    return {
      symbol,
      name: firstText(raw.name, raw.stock_name, metadata.name, symbol),
      current_price: firstNumber(
        raw.current_price,
        raw.latest_price,
        raw.execute_price,
        raw.entry_price,
        raw.price,
        metadata.current_price,
        rawFactors.current_price,
        rawFactors.latest_price
      ),
      score: firstNumber(raw.score, raw.confidence_score, raw.final_score, metadata.fusion_score),
      action_label: actionLabel,
      position_pct: firstNumber(
        raw.suggested_position_pct,
        raw.target_position_pct,
        metadata.suggested_position_pct
      ),
      status,
      reason,
      risk_level: firstText(raw.risk_level, metadata.risk_level),
      amount: firstNumber(raw.amount, raw.total_cost, raw.strategy_allocation_amount),
      trace_url: firstText(raw.trace_url, metadata.trace_url),
    };
  }

  private resolveActionLabel(raw: any, status: string): string {
    if (status === 'executed') return '已模拟买入';
    if (status === 'planned') return '计划买入';
    if (status === 'skipped') return '已跳过';
    const action = String(
      raw.action || raw.decision || raw.normalized_decision || ''
    ).toLowerCase();
    if (action === 'buy') return firstText(raw.action_label, '建议买入');
    if (action === 'watch') return firstText(raw.action_label, '观察');
    if (action === 'hold') return firstText(raw.action_label, '持有');
    if (action === 'avoid') return firstText(raw.action_label, '回避');
    return firstText(raw.action_label, raw.decision, '观察');
  }

  private formatRecommendationLine(
    item: NormalizedRecommendation,
    index: number
  ): FeishuPostElement[] {
    const chunks = [
      `${index}. ${item.name || item.symbol}(${item.symbol})`,
      `现价${this.formatPrice(item.current_price)}`,
      item.action_label,
      item.score !== undefined ? `分${this.formatNumber(item.score, 1)}` : '',
      item.position_pct !== undefined ? `仓位${this.formatNumber(item.position_pct, 1)}%` : '',
      item.reason ? this.safeText(item.reason, 30) : '',
    ].filter(Boolean);
    const text = chunks.join('｜');
    if (!item.trace_url || !/^https?:\/\//i.test(item.trace_url)) {
      return [{ tag: 'text', text }];
    }
    return [
      { tag: 'text', text: `${text}｜` },
      { tag: 'a', text: '链路', href: item.trace_url },
    ];
  }

  private formatRiskExitLine(item: NormalizedRiskExit, index: number): string {
    const statusLabel =
      item.status === 'exited' ? '已卖出' : item.status === 'planned' ? '计划卖出' : '卖出关注';
    const chunks = [
      `${index}. ${item.name || item.symbol}(${item.symbol})`,
      `现价${this.formatPrice(item.latest_price)}`,
      item.execute_price ? `执行价${this.formatPrice(item.execute_price)}` : '',
      statusLabel,
      item.reason_label ? this.safeText(item.reason_label, 18) : '',
      item.pnl_pct !== undefined ? `盈亏${this.formatSignedPercent(item.pnl_pct)}` : '',
      item.holding_days !== undefined ? `${item.holding_days}天` : '',
    ].filter(Boolean);
    return chunks.join('｜');
  }

  private formatPrice(value?: number): string {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '--';
    return `¥${Number(value).toFixed(2)}`;
  }

  private formatNumber(value: any, digits = 2): string {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return '--';
    return parsed.toFixed(digits).replace(/\.0+$/, '');
  }

  private formatSignedPercent(value: any): string {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return '--';
    const prefix = parsed > 0 ? '+' : '';
    return `${prefix}${parsed.toFixed(2)}%`;
  }

  private safeReason(value: string): string {
    return this.safeText(
      value
        .replace(/当前股价\s*¥?\d+(\.\d+)?[；;，,]?\s*/g, '')
        .replace(/融合分\s*\d+(\.\d+)?[；;，,]?\s*/g, '')
        .replace(/量化原始分\s*\d+(\.\d+)?[；;，,]?\s*/g, '')
        .trim(),
      42
    );
  }

  private safeText(value: any, maxLength: number): string {
    const text = String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
  }
}

export const feishuBotWebhookService = new FeishuBotWebhookService();
