import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { paperTradingDashboardService } from '../portfolio/internal/PaperTradingDashboardService';
import { paperTradingRiskProfileService } from '../portfolio/internal/PaperTradingRiskProfileService';
import { taskAutomationHealthService } from './TaskAutomationHealthService';
import { quantSignalService } from '../quant/services/QuantSignalService';
import { quantFusionAuditService } from '../quant/services/QuantFusionAuditService';
import { realtimeQuoteService } from '../data/services/RealtimeQuoteService';
import { AIInvestmentSignal } from '../models/AIInvestmentSignal';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { normalizeSymbol } from '../utils/stockSymbol';
import { logger } from '../utils/logger';
import { openingReadinessService } from './OpeningReadinessService';
import { paperTradingTuningApplyService } from '../portfolio/internal/PaperTradingTuningApplyService';

type CommandAction = 'buy' | 'watch' | 'hold' | 'sell' | 'avoid';

interface TodayCommandOptions {
  user_id?: number;
  username?: string;
  trade_date?: string;
  limit?: number;
}

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundNumber(value: any, digits = 2): number {
  const parsed = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(parsed * base) / base;
}

function safeText(value: any, maxLength = 80): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function splitReasons(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(item => safeText(item, 80)).filter(Boolean);
  return String(value)
    .split(/[；;\n]/)
    .map(item => safeText(item, 80))
    .filter(Boolean);
}

function normalizeAction(value: any): CommandAction {
  const normalized = String(value || '').toLowerCase();
  if (['strong_buy', 'buy', 'strong_recommend', 'trial_position'].includes(normalized)) {
    return 'buy';
  }
  if (['sell', 'strong_sell', 'reduce', 'exit', 'sell_signal'].includes(normalized)) {
    return 'sell';
  }
  if (['avoid', 'pause', 'block'].includes(normalized)) return 'avoid';
  if (['hold'].includes(normalized)) return 'hold';
  return 'watch';
}

function actionLabel(action: CommandAction): string {
  const labels: Record<CommandAction, string> = {
    buy: '买入/试仓',
    watch: '观察',
    hold: '持有',
    sell: '卖出/减仓',
    avoid: '回避',
  };
  return labels[action];
}

function disciplineLabel(level: 'strict' | 'normal' | 'relaxed') {
  if (level === 'strict') return '严格防守';
  if (level === 'relaxed') return '可小幅进攻';
  return '正常执行';
}

function getChinaToday(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

class TodayCommandCenterService {
  async getCommandCenter(options: TodayCommandOptions = {}) {
    const tradeDate = options.trade_date || getChinaToday();
    const limit = Math.min(Math.max(Number(options.limit || 8), 3), 20);

    const [
      dashboard,
      riskProfile,
      automationHealth,
      rankings,
      quotePersistence,
      latestFeishuLog,
      openingReadiness,
      tuningCandidates,
      canarySnapshots,
    ] = await Promise.all([
      paperTradingDashboardService
        .getAutonomousDashboard({
          user_id: options.user_id,
          username: options.username,
          lookback_days: 60,
          limit: 120,
        })
        .catch(error => {
          logger.warn(`今日作战台读取自主模拟盘失败: ${error?.message || error}`);
          return null;
        }),
      paperTradingRiskProfileService
        .getRiskProfile({
          user_id: options.user_id,
          include_family: true,
        })
        .catch(error => {
          logger.warn(`今日作战台读取组合风险画像失败: ${error?.message || error}`);
          return null;
        }),
      taskAutomationHealthService.getHealth().catch(error => {
        logger.warn(`今日作战台读取自动化健康失败: ${error?.message || error}`);
        return null;
      }),
      this.getRankings(tradeDate, Math.max(limit, 12)).catch(error => {
        logger.warn(`今日作战台读取量化排行榜失败: ${error?.message || error}`);
        return null;
      }),
      realtimeQuoteService.getPersistenceSummary({ trade_date: tradeDate }).catch(error => {
        logger.warn(`今日作战台读取实时行情落盘状态失败: ${error?.message || error}`);
        return null;
      }),
      this.getLatestFeishuRecommendationLog().catch(error => {
        logger.warn(`今日作战台读取飞书任务日志失败: ${error?.message || error}`);
        return null;
      }),
      openingReadinessService
        .getReadiness({
          user_id: options.user_id,
          username: options.username,
          trade_date: tradeDate,
          factor_limit: 220,
          use_cache: true,
          cache_ttl_ms: 90_000,
        })
        .catch(error => {
          logger.warn(`今日作战台读取开盘可信检查失败: ${error?.message || error}`);
          return null;
        }),
      paperTradingTuningApplyService
        .getTuningCandidates({
          user_id: options.user_id,
          username: options.username,
          use_family_hindsight: true,
          family_hindsight_lookback_days: 45,
          family_hindsight_min_consensus: 2,
          family_hindsight_min_evaluated: 5,
          canary_max_parameters: 1,
        })
        .catch(error => {
          logger.warn(`今日作战台读取只读调参候选失败: ${error?.message || error}`);
          return null;
        }),
      paperTradingTuningApplyService
        .listCanaryReviewSnapshots({
          user_id: options.user_id,
          username: options.username,
          limit: 5,
        })
        .catch(error => {
          logger.warn(`今日作战台读取 Canary 评审快照失败: ${error?.message || error}`);
          return null;
        }),
    ]);

    const candidates = await this.buildCandidates({
      trade_date: tradeDate,
      rankings,
      limit,
    });
    const positions = this.normalizePositions(
      dashboard?.all_open_positions?.length
        ? dashboard.all_open_positions
        : dashboard?.positions || [],
      dashboard?.portfolio_family_summary?.summary || dashboard?.summary || {}
    );
    const sellCandidates = this.buildSellCandidates({
      positions,
      tracking_items: dashboard?.recommendation_tracking?.items || [],
      limit: 8,
    });
    const summary = this.buildSummary({
      dashboard,
      riskProfile,
      automationHealth,
      candidates,
      positions,
      sellCandidates,
      quotePersistence,
      latestFeishuLog,
    });
    const readiness = this.buildReadiness({
      automationHealth,
      candidates,
      riskProfile,
      quotePersistence,
      latestFeishuLog,
      summary,
    });
    const discipline = this.buildDiscipline({
      summary,
      riskProfile,
      candidates,
      sellCandidates,
      positions,
      readiness,
    });

    return {
      generated_at: moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss'),
      trade_date: tradeDate,
      conclusion: this.buildConclusion({
        candidates,
        positions,
        sellCandidates,
        summary,
        riskProfile,
        openingReadiness,
      }),
      summary,
      buy_candidates: candidates.filter(item => item.action === 'buy'),
      watch_candidates: candidates.filter(item => item.action !== 'buy').slice(0, limit),
      all_candidates: candidates,
      sell_candidates: sellCandidates,
      positions,
      readiness,
      discipline,
      opening_readiness: openingReadiness,
      risk_profile: riskProfile,
      automation_health: automationHealth
        ? {
            status: automationHealth.status,
            summary: automationHealth.summary,
            issues: (automationHealth.issues || []).slice(0, 8),
            next_actions: (automationHealth.next_actions || []).slice(0, 6),
          }
        : null,
      quote_persistence: quotePersistence,
      latest_feishu: latestFeishuLog,
      tuning_radar: tuningCandidates
        ? {
            generated_at: tuningCandidates.generated_at,
            summary: tuningCandidates.summary,
            canary_candidates: (tuningCandidates.canary_candidates || []).slice(0, 3),
            candidates: (tuningCandidates.candidates || []).slice(0, 5),
            family_hindsight: tuningCandidates.family_hindsight,
          }
        : null,
      canary_memory: canarySnapshots
        ? {
            generated_at: canarySnapshots.generated_at,
            summary: canarySnapshots.summary,
            snapshots: (canarySnapshots.snapshots || []).slice(0, 5),
          }
        : null,
      links: {
        quant_signals: '/quant/signals',
        trading_overview: '/autonomous-trading/overview',
        review_trades: '/review/trades',
        tasks: '/tasks',
      },
      guardrails: {
        default_position_pct: discipline.default_position_pct,
        max_position_pct: discipline.single_position_cap_pct,
        min_cash_reserve_pct: discipline.min_cash_reserve_pct,
        max_exposure_pct: discipline.max_total_exposure_pct,
        note: '今日作战台只做聚合与决策提示，不会触发真实交易/Agent 调用；买卖仍由模拟盘任务记录。',
      },
    };
  }

  private async getRankings(tradeDate: string, limit: number) {
    const [quantDashboard, fusionDashboard] = await Promise.all([
      quantSignalService.getRankingDashboard({ trade_date: tradeDate, limit }),
      quantFusionAuditService.getRankingDashboard({ signal_date: tradeDate, limit }),
    ]);
    const quantSummary: any = quantDashboard.summary || {};
    const fusionSummary: any = fusionDashboard.summary || {};
    return {
      quant_rankings: quantDashboard.quant_rankings || [],
      fusion_rankings: fusionDashboard.fusion_rankings || [],
      summary: {
        ...fusionSummary,
        ...quantSummary,
        fusion_count: fusionSummary.fusion_count || 0,
        fusion_buy_count: fusionSummary.fusion_buy_count ?? fusionSummary.buy_count ?? 0,
        fusion_watch_count: fusionSummary.fusion_watch_count ?? fusionSummary.watch_count ?? 0,
        fusion_avoid_count: fusionSummary.fusion_avoid_count ?? fusionSummary.avoid_count ?? 0,
        agent_rescored: Boolean(fusionSummary.agent_rescored),
      },
    };
  }

  private async buildCandidates(options: { trade_date: string; rankings: any; limit: number }) {
    const sourceItems: any[] = [
      ...(options.rankings?.fusion_rankings || []).map((item: any) => ({
        source_key: 'fusion',
        source_label: '量化+Agent融合',
        symbol: item.symbol,
        name: item.name,
        action: item.final_decision || item.agent_decision,
        score: item.final_score,
        current_price: item.current_price,
        reason: item.rationale,
        risk: item.risk_level,
        strategy_keys: item.strategy_keys || [],
        signal_date: item.signal_date,
      })),
      ...(options.rankings?.quant_rankings || []).map((item: any) => ({
        source_key: 'quant',
        source_label: '纯量化指标',
        symbol: item.symbol,
        name: item.name,
        action: item.signal,
        score: item.score,
        current_price: item.entry_price,
        reason: item.reason,
        risk: Array.isArray(item.risk_flags) ? item.risk_flags.slice(0, 2).join('、') : '',
        strategy_keys: item.strategy_keys || [item.strategy_key].filter(Boolean),
        signal_date: item.trade_date,
      })),
    ];

    if (sourceItems.length < options.limit) {
      sourceItems.push(...(await this.getArchivedSignals(options.trade_date, options.limit)));
    }

    const latestQuotes = await realtimeQuoteService
      .getLatestQuotes(sourceItems.map(item => item.symbol).filter(Boolean))
      .catch(() => []);
    const quoteBySymbol = new Map<string, any>(
      latestQuotes.map((quote: any) => [normalizeSymbol(quote.symbol), quote] as [string, any])
    );

    const bySymbol = new Map<string, any>();
    for (const raw of sourceItems) {
      const symbol = normalizeSymbol(raw.symbol);
      if (!symbol) continue;
      const quote: any = quoteBySymbol.get(symbol);
      const action = normalizeAction(raw.action);
      const score = roundNumber(raw.score, 2);
      const existing = bySymbol.get(symbol);
      const item = {
        key: `${raw.source_key || 'signal'}-${symbol}`,
        symbol,
        name: raw.name || quote?.name || symbol,
        source: raw.source_label || '归档信号',
        source_key: raw.source_key || 'signal',
        action,
        action_label: actionLabel(action),
        score,
        current_price: roundNumber(raw.current_price || quote?.current_price, 4),
        price_change_pct:
          quote?.change_percent !== undefined ? roundNumber(quote.change_percent, 2) : undefined,
        suggested_position_pct: this.suggestPositionPct({ score, action, risk: raw.risk }),
        reason: safeText(splitReasons(raw.reason)[0] || raw.reason, 64),
        risk: safeText(raw.risk || '按默认仓位和止损纪律控制', 48),
        strategy_keys: raw.strategy_keys || [],
        signal_date: raw.signal_date || options.trade_date,
        priority: this.candidatePriority({ action, score, source_key: raw.source_key }),
      };

      if (!existing || item.priority > existing.priority) {
        bySymbol.set(symbol, item);
      }
    }

    return [...bySymbol.values()]
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))
      .slice(0, options.limit)
      .map((item, index) => ({ ...item, rank: index + 1 }));
  }

  private async getArchivedSignals(tradeDate: string, limit: number) {
    const signals = await AIInvestmentSignal.findAll({
      where: {
        signal_date: tradeDate,
        normalized_decision: { [Op.in]: ['strong_buy', 'buy', 'hold'] },
      },
      order: [
        ['confidence_score', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit: Math.max(limit * 2, 20),
      raw: true,
    });

    return signals.map((signal: any) => {
      const metadata = signal.metadata || {};
      return {
        source_key: 'signal',
        source_label:
          signal.source_type === 'tradingagents'
            ? 'TradingAgents'
            : signal.source_type === 'daily_screener'
            ? 'AI每日优选'
            : '归档信号',
        symbol: signal.symbol,
        name: signal.name,
        action: metadata.action || signal.normalized_decision,
        score: signal.confidence_score,
        current_price: signal.current_price,
        reason: metadata.tier_reason || metadata.reasons?.[0] || signal.rationale,
        risk: signal.risk_level,
        strategy_keys: metadata.strategy_key ? [metadata.strategy_key] : [],
        signal_date: signal.signal_date,
      };
    });
  }

  private normalizePositions(positions: any[], summary: any) {
    const totalValue = toNumber(summary.total_value, 0);
    return positions
      .map(position => {
        const marketValue = toNumber(position.market_value);
        const avgCost = toNumber(position.avg_cost);
        const currentPrice = toNumber(position.current_price);
        const pnlPct = avgCost > 0 ? ((currentPrice - avgCost) / avgCost) * 100 : 0;
        return {
          symbol: normalizeSymbol(position.symbol),
          name: position.name,
          account_key: position.account_key,
          account_label: position.account_label,
          account_name: position.account_name,
          quantity: toNumber(position.quantity),
          avg_cost: roundNumber(avgCost, 4),
          current_price: roundNumber(currentPrice, 4),
          market_value: roundNumber(marketValue, 2),
          unrealized_pnl: roundNumber(position.unrealized_pnl, 2),
          unrealized_pnl_pct: roundNumber(position.unrealized_pnl_pct ?? pnlPct, 4),
          weight_pct:
            position.weight_pct !== undefined
              ? roundNumber(position.weight_pct, 2)
              : totalValue > 0
              ? roundNumber((marketValue / totalValue) * 100, 2)
              : 0,
        };
      })
      .sort((a, b) => Number(b.weight_pct || 0) - Number(a.weight_pct || 0));
  }

  private buildSellCandidates(options: { positions: any[]; tracking_items: any[]; limit: number }) {
    const fromSignals = (options.tracking_items || [])
      .filter((item: any) =>
        ['sell', 'sell_signal', 'reduce', 'exit'].includes(
          String(item.command || item.status || '').toLowerCase()
        )
      )
      .map((item: any) => ({
        symbol: normalizeSymbol(item.symbol),
        name: item.name,
        action: 'sell',
        action_label: item.command_label || '卖出/减仓',
        current_price: roundNumber(item.latest_price || item.current_price || item.entry_price, 4),
        reason: item.exit_reason_label || item.rationale || '出现卖出/风控信号',
        urgency: 'high',
      }));

    const fromPositions = options.positions
      .map(position => {
        const pnlPct = toNumber(position.unrealized_pnl_pct, 0);
        const weight = toNumber(position.weight_pct, 0);
        if (pnlPct <= -7) {
          return {
            symbol: position.symbol,
            name: position.name,
            action: 'sell',
            action_label: '优先风控',
            current_price: position.current_price,
            reason: `浮亏 ${roundNumber(pnlPct, 2)}%，接近默认止损线`,
            urgency: 'high',
          };
        }
        if (pnlPct >= 12) {
          return {
            symbol: position.symbol,
            name: position.name,
            action: 'sell',
            action_label: '保护利润',
            current_price: position.current_price,
            reason: `浮盈 ${roundNumber(pnlPct, 2)}%，关注移动止盈`,
            urgency: 'medium',
          };
        }
        if (weight >= 12) {
          return {
            symbol: position.symbol,
            name: position.name,
            action: 'reduce',
            action_label: '控制集中度',
            current_price: position.current_price,
            reason: `单票仓位 ${roundNumber(weight, 2)}%，避免继续加仓`,
            urgency: 'medium',
          };
        }
        return null;
      })
      .filter(Boolean);

    const bySymbol = new Map<string, any>();
    [...fromSignals, ...fromPositions].forEach((item: any) => {
      if (!item?.symbol) return;
      const existing = bySymbol.get(item.symbol);
      if (!existing || item.urgency === 'high') bySymbol.set(item.symbol, item);
    });

    return [...bySymbol.values()].slice(0, options.limit);
  }

  private buildSummary(payload: {
    dashboard: any;
    riskProfile: any;
    automationHealth: any;
    candidates: any[];
    positions: any[];
    sellCandidates: any[];
    quotePersistence: any;
    latestFeishuLog: any;
  }) {
    const dashboardSummary = payload.dashboard?.summary || {};
    const familySummary = payload.dashboard?.portfolio_family_summary?.summary || {};
    const riskMetrics = payload.riskProfile?.risk_metrics || {};
    const totalValue = toNumber(
      familySummary.champion?.total_value ?? dashboardSummary.total_value,
      200000
    );
    const cashPct = toNumber(riskMetrics.cash_pct ?? dashboardSummary.cash_pct, 0);
    const exposurePct = toNumber(riskMetrics.exposure_pct ?? dashboardSummary.exposure_pct, 0);
    return {
      total_value: roundNumber(totalValue, 2),
      total_pnl: roundNumber(familySummary.total_pnl ?? dashboardSummary.total_pnl, 2),
      total_return_pct: roundNumber(
        familySummary.champion?.total_return_pct ?? dashboardSummary.total_return_pct,
        4
      ),
      current_cash: roundNumber(
        payload.riskProfile?.portfolio?.current_cash ?? dashboardSummary.current_cash,
        2
      ),
      cash_pct: roundNumber(cashPct, 2),
      exposure_pct: roundNumber(exposurePct, 2),
      open_position_count: payload.positions.length,
      strategy_account_count: Number(familySummary.active_family_count || 0),
      buy_candidate_count: payload.candidates.filter(item => item.action === 'buy').length,
      watch_candidate_count: payload.candidates.filter(item => item.action !== 'buy').length,
      sell_candidate_count: payload.sellCandidates.length,
      automation_status: payload.automationHealth?.status || 'warning',
      quote_status: payload.quotePersistence?.freshness_status || 'missing',
      feishu_last_status: payload.latestFeishuLog?.status || null,
    };
  }

  private buildReadiness(payload: {
    automationHealth: any;
    candidates: any[];
    riskProfile: any;
    quotePersistence: any;
    latestFeishuLog: any;
    summary: any;
  }) {
    const automationStatus = payload.automationHealth?.status || 'warning';
    const riskLevel = String(payload.riskProfile?.status?.level || 'safe').toLowerCase();
    const quoteOk =
      Boolean(payload.quotePersistence?.persisted) &&
      (payload.quotePersistence?.is_fresh !== false ||
        Number(payload.quotePersistence?.age_minutes || 0) <= 90);
    return [
      {
        key: 'data',
        label: '行情数据新鲜',
        status: quoteOk ? 'ok' : payload.quotePersistence?.persisted ? 'warn' : 'danger',
        ok: quoteOk,
        detail: payload.quotePersistence?.persisted
          ? `最新 ${payload.quotePersistence.latest_quote_time || '--'}`
          : '尚未发现实时行情落盘',
      },
      {
        key: 'tasks',
        label: '自动任务链路',
        status:
          automationStatus === 'healthy'
            ? 'ok'
            : automationStatus === 'warning'
            ? 'warn'
            : 'danger',
        ok: automationStatus === 'healthy',
        detail: `${payload.automationHealth?.summary?.active_tasks || 0}/${
          payload.automationHealth?.summary?.total_tasks || 0
        } 个任务启用`,
      },
      {
        key: 'signals',
        label: '推荐信号生成',
        status: payload.candidates.length > 0 ? 'ok' : 'warn',
        ok: payload.candidates.length > 0,
        detail: `今日候选 ${payload.candidates.length} 只`,
      },
      {
        key: 'risk',
        label: '风控允许新增',
        status:
          riskLevel === 'danger' || payload.summary.cash_pct < 6
            ? 'danger'
            : riskLevel === 'watch' || payload.summary.cash_pct < 10
            ? 'warn'
            : 'ok',
        ok: riskLevel !== 'danger' && payload.summary.cash_pct >= 10,
        detail: `现金 ${payload.summary.cash_pct}% · 仓位 ${payload.summary.exposure_pct}%`,
      },
      {
        key: 'feishu',
        label: '飞书摘要链路',
        status: payload.latestFeishuLog?.status === 'FAILED' ? 'warn' : 'ok',
        ok: payload.latestFeishuLog?.status !== 'FAILED',
        detail: payload.latestFeishuLog
          ? `${payload.latestFeishuLog.task_name} · ${payload.latestFeishuLog.status}`
          : '等待最近荐股飞书任务',
      },
    ];
  }

  private buildDiscipline(payload: {
    summary: any;
    riskProfile: any;
    candidates: any[];
    sellCandidates: any[];
    positions: any[];
    readiness: any[];
  }) {
    const riskLevel = String(payload.riskProfile?.status?.level || 'safe').toLowerCase();
    const cashPct = toNumber(payload.summary.cash_pct, 0);
    const exposurePct = toNumber(payload.summary.exposure_pct, 0);
    const quoteReady = payload.readiness.find((item: any) => item.key === 'data')?.ok !== false;
    const signalsReady =
      payload.readiness.find((item: any) => item.key === 'signals')?.ok !== false;
    const base = {
      level: 'normal' as 'strict' | 'normal' | 'relaxed',
      max_new_positions: 2,
      suggested_new_position_count: Math.min(
        2,
        payload.candidates.filter(item => item.action === 'buy').length
      ),
      default_position_pct: 3,
      single_position_cap_pct: 6,
      max_total_exposure_pct: 85,
      min_cash_reserve_pct: 10,
      review_time: '14:35',
      buy_allowed: true,
      buy_reason: '数据、仓位与风控处于可执行区间，可按小仓位验证。',
      forbidden_industries: [],
      forbidden_symbols: [],
      sell_priority_count: payload.sellCandidates.length,
      conclusion: '今日可继续小仓验证，但只处理高置信前排候选。',
      actions: [] as string[],
    };

    if (!quoteReady || !signalsReady || riskLevel === 'danger' || cashPct < 8 || exposurePct > 88) {
      base.level = 'strict';
      base.buy_allowed = false;
      base.max_new_positions = 0;
      base.suggested_new_position_count = 0;
      base.default_position_pct = 0;
      base.single_position_cap_pct = 4;
      base.max_total_exposure_pct = 80;
      base.min_cash_reserve_pct = 12;
      base.buy_reason =
        !quoteReady || !signalsReady
          ? '行情/信号链路尚未完全就绪，今天不新增，先等任务完成。'
          : '现金水位或总体风险已触发红线，今天优先减仓和保护利润。';
      base.conclusion = '今日以风控为主，暂停新增仓位。';
      base.actions = [
        '优先处理卖出/减仓候选，再考虑新增。',
        '不追高、不补跌，等待下一轮开盘/收盘信号确认。',
        '收盘前只复查已有持仓与止损止盈条件。',
      ];
    } else if (riskLevel === 'watch' || cashPct < 12 || exposurePct > 75) {
      base.level = 'normal';
      base.max_new_positions = 1;
      base.suggested_new_position_count = Math.min(
        1,
        payload.candidates.filter(item => item.action === 'buy').length
      );
      base.default_position_pct = 2;
      base.single_position_cap_pct = 4;
      base.max_total_exposure_pct = 82;
      base.min_cash_reserve_pct = 10;
      base.buy_reason = '组合进入谨慎区，只允许处理最强 1 只候选，并降低默认仓位。';
      base.conclusion = '今日可谨慎试仓 1 只，但先看卖出/风控候选。';
      base.actions = [
        '只跟最强 1 只候选，默认仓位不超过 2%-4%。',
        '如已有卖出候选，先减仓再考虑新增。',
        '避免继续加到同一行业或高相关策略来源。',
      ];
    } else {
      base.level = 'relaxed';
      base.max_new_positions = 2;
      base.suggested_new_position_count = Math.min(
        2,
        payload.candidates.filter(item => item.action === 'buy').length
      );
      base.default_position_pct = 3;
      base.single_position_cap_pct = 6;
      base.max_total_exposure_pct = 85;
      base.min_cash_reserve_pct = 10;
      base.buy_reason = '组合风险、现金和数据状态良好，可按默认节奏小仓扩样本。';
      base.conclusion = '今日可小仓跟随高分候选，优先分散建仓。';
      base.actions = [
        '最多新增 2 只，优先不同策略/不同行业来源。',
        '单票默认 3%，高分且低风险可放大到 5%-6%。',
        '14:35 前复查持仓是否触发保护利润或止损规则。',
      ];
    }

    const topIndustry = payload.riskProfile?.top_industries?.[0];
    if (topIndustry && toNumber(topIndustry.exposure_pct, 0) >= 24) {
      base.forbidden_industries = [topIndustry.industry];
      base.actions.unshift(`避免继续买入 ${topIndustry.industry}，行业集中度已偏高。`);
    }
    const highRiskSymbols = (payload.riskProfile?.position_risks || [])
      .filter((item: any) => Array.isArray(item.risk_flags) && item.risk_flags.length > 0)
      .slice(0, 5)
      .map((item: any) => item.symbol);
    if (highRiskSymbols.length) {
      base.forbidden_symbols = highRiskSymbols;
    }

    return {
      ...base,
      level_label: disciplineLabel(base.level),
    };
  }

  private buildConclusion(payload: {
    candidates: any[];
    positions: any[];
    sellCandidates: any[];
    summary: any;
    riskProfile: any;
    openingReadiness?: any;
  }) {
    if (payload.openingReadiness) {
      const readiness = payload.openingReadiness;
      const buyGate = readiness.buy_gate || {};
      const nextActions = Array.isArray(readiness.next_actions) ? readiness.next_actions : [];
      return {
        tone:
          readiness.status === 'ready'
            ? 'action'
            : readiness.status === 'degraded'
            ? 'hold'
            : 'wait',
        headline: readiness.status_label || readiness.conclusion,
        reason: readiness.conclusion,
        risk:
          buyGate.reason ||
          readiness.portfolio?.risk_label ||
          payload.riskProfile?.status?.conclusion ||
          '按开盘可信检查执行',
        next_actions: nextActions.length
          ? nextActions.slice(0, 3).map((item: any) => item.title || item.description)
          : [
              buyGate.allowed
                ? `最多新增 ${buyGate.max_new_positions || 0} 只，默认仓位 ${
                    buyGate.default_position_pct || 0
                  }%`
                : '暂停新增买入，先修复开盘链路',
              '收盘后进入收益复盘中心看模拟交易是否赚钱',
            ],
      };
    }
    const buyCount = payload.candidates.filter(item => item.action === 'buy').length;
    const watchCount = payload.candidates.filter(item => item.action !== 'buy').length;
    const sellCount = payload.sellCandidates.length;
    const riskLabel = payload.riskProfile?.status?.label || '按默认纪律';
    const headline =
      buyCount > 0
        ? `谨慎买入 ${buyCount} 只，观察 ${watchCount} 只，卖出/减仓 ${sellCount} 只`
        : payload.positions.length > 0
        ? `暂无强买入，持仓 ${payload.positions.length} 只优先做风控复查`
        : '暂无强买入，等待量化/Agent 信号确认';
    const reason = `候选 ${payload.candidates.length} 只；现金 ${payload.summary.cash_pct}%；总仓位 ${payload.summary.exposure_pct}%；风控 ${riskLabel}`;
    return {
      tone: buyCount > 0 ? 'action' : payload.positions.length > 0 ? 'hold' : 'wait',
      headline,
      reason,
      risk: payload.riskProfile?.status?.conclusion || '按仓位、止损和数据新鲜度执行',
      next_actions: [
        buyCount > 0 ? '只处理买入候选前排，单票默认 3%-6%' : '不追高，等待下一轮确认',
        sellCount > 0 ? '优先检查卖出/风控候选' : '持仓未触发强制退出时继续观察',
        '收盘后进入收益复盘中心看模拟交易是否赚钱',
      ],
    };
  }

  private suggestPositionPct(params: { score: number; action: CommandAction; risk?: string }) {
    if (params.action !== 'buy') return 0;
    const risk = String(params.risk || '').toLowerCase();
    if (risk.includes('high') || risk.includes('高')) return 2;
    if (params.score >= 85) return 6;
    if (params.score >= 78) return 5;
    return 3;
  }

  private candidatePriority(params: { action: CommandAction; score: number; source_key?: string }) {
    const actionBonus = params.action === 'buy' ? 100 : params.action === 'watch' ? 40 : 10;
    const sourceBonus = params.source_key === 'fusion' ? 20 : params.source_key === 'quant' ? 8 : 0;
    return actionBonus + sourceBonus + toNumber(params.score, 0);
  }

  private async getLatestFeishuRecommendationLog() {
    const logs = await TaskExecutionLog.findAll({
      where: {
        task_name: {
          [Op.or]: [
            { [Op.iLike]: '%量化策略%' },
            { [Op.iLike]: '%全市场荐股%' },
            { [Op.iLike]: '%推荐信号模拟盘%' },
          ],
        },
      },
      order: [['started_at', 'DESC']],
      limit: 1,
      raw: true,
    });
    const log: any = logs[0];
    if (!log) return null;
    return {
      id: log.id,
      task_id: log.task_id,
      task_name: log.task_name,
      status: log.status,
      started_at: log.started_at,
      completed_at: log.completed_at,
      error_message: safeText(log.error_message, 120),
    };
  }
}

export const todayCommandCenterService = new TodayCommandCenterService();
