import { Op } from 'sequelize';
import { LiveBrokerAccount } from '../../models/LiveBrokerAccount';
import { LiveAccountSnapshot } from '../../models/LiveAccountSnapshot';
import { LivePosition } from '../../models/LivePosition';
import { LiveOrderDraft } from '../../models/LiveOrderDraft';
import { LiveOrder } from '../../models/LiveOrder';
import { LiveTrade } from '../../models/LiveTrade';
import { LiveExecutionAuditLog } from '../../models/LiveExecutionAuditLog';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingTrade } from '../../models/PaperTradingTrade';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { RealtimeQuote } from '../../models/RealtimeQuote';
import { AIInvestmentSignal } from '../../models/AIInvestmentSignal';
import { TaskExecutionLog } from '../../models/TaskExecutionLog';
import { TaskParameterAuditLog } from '../../models/TaskParameterAuditLog';
import { MockBrokerGateway } from '../brokers/MockBrokerGateway';
import { EnvReadonlyBrokerGateway } from '../brokers/EnvReadonlyBrokerGateway';
import { BrokerGateway } from '../brokers/BrokerGateway';
import { DatabaseQuoteProvider } from '../market-data/DatabaseQuoteProvider';
import { ConfiguredQuoteProvider } from '../market-data/ConfiguredQuoteProvider';
import { LiveMarketDataProvider } from '../market-data/LiveMarketDataProvider';
import { liveRiskGuardService } from './LiveRiskGuardService';
import { LIVE_ORDER_CONFIRM_TEXT, liveTradingSafetyService } from './LiveTradingSafetyService';
import { PAPER_PORTFOLIO_FAMILIES } from '../../portfolio/internal/PaperTradingPortfolioFamilies';

function toNumber(value: any): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function round(value: any, digits = 2): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function normalizeSymbol(symbol: string): string {
  const value = String(symbol || '').trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(value)) return value;
  if (/^(SH|SZ|BJ)\.\d{6}$/.test(value)) {
    const [market, code] = value.split('.');
    return `${code}.${market}`;
  }
  if (/^(SH|SZ|BJ)\d{6}$/.test(value)) return `${value.slice(2)}.${value.slice(0, 2)}`;
  if (/^\d{6}$/.test(value)) {
    const prefix = value.startsWith('6') ? 'SH' : value.startsWith('8') || value.startsWith('4') ? 'BJ' : 'SZ';
    return `${value}.${prefix}`;
  }
  return value;
}

function maskAccountNo(value?: string): string {
  const raw = String(value || '').replace(/\s+/g, '');
  if (!raw) return '未绑定';
  if (raw.length <= 4) return `****${raw}`;
  return `${raw.slice(0, 2)}****${raw.slice(-4)}`;
}

function quotePrice(quote: any): number {
  return toNumber(quote?.current_price);
}

function quoteLatency(quote: any): number | undefined {
  const value = Number(quote?.latency_seconds);
  return Number.isFinite(value) ? value : undefined;
}

function ageMinutes(value?: string | Date | null): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return round((Date.now() - time) / 60000, 2);
}

function envBool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function numberOrNull(value: any): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function priceOrNull(value: any): number | null {
  const num = numberOrNull(value);
  return num !== null && num > 0 ? num : null;
}

function roundNullable(value: any, digits = 2): number | null {
  const num = numberOrNull(value);
  if (num === null) return null;
  return round(num, digits);
}

function localDateKey(value?: string | Date | null): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(value: string | Date): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return new Date(0);
  date.setHours(0, 0, 0, 0);
  return date;
}

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function paperTradingMetaForPortfolio(
  metadata: Record<string, any>,
  portfolio_id?: number
): Record<string, any> {
  const legacy = asPlainObject(metadata.paper_trading);
  const byPortfolio = asPlainObject(metadata.paper_trading_by_portfolio);
  const keyed = portfolio_id ? asPlainObject(byPortfolio[String(portfolio_id)]) : {};
  return Object.keys(keyed).length > 0 ? keyed : legacy;
}

export class LiveTradingService {
  private brokerGateway: BrokerGateway;
  private quoteProvider: LiveMarketDataProvider;
  private databaseQuoteProvider: DatabaseQuoteProvider;
  private licensedQuoteProvider: ConfiguredQuoteProvider;

  constructor() {
    const configuredBrokerGateway = process.env.LIVE_BROKER_GATEWAY || 'mock_guarded';
    this.brokerGateway =
      configuredBrokerGateway === 'env_readonly'
        ? new EnvReadonlyBrokerGateway()
        : new MockBrokerGateway(configuredBrokerGateway);
    this.databaseQuoteProvider = new DatabaseQuoteProvider();
    this.licensedQuoteProvider = new ConfiguredQuoteProvider();
    this.quoteProvider =
      process.env.LIVE_MARKET_DATA_PROVIDER === 'licensed_configured' &&
      this.licensedQuoteProvider.isConfigured()
        ? this.licensedQuoteProvider
        : this.databaseQuoteProvider;
  }

  async getReadiness(user_id?: number) {
    const safety = liveTradingSafetyService.getStatus();
    const broker = this.brokerGateway.getCapabilities();
    const marketData = this.quoteProvider.getProviderInfo();
    const marketDataHealth = await this.getMarketDataHealth();
    const providerComparison = await this.getMarketDataProviderComparison(
      marketDataHealth.checked_symbols
    );
    const accountCount = user_id
      ? await LiveBrokerAccount.count({ where: { user_id, is_active: true } })
      : 0;
    return {
      generated_at: new Date().toISOString(),
      safety,
      broker,
      market_data: marketData,
      market_data_health: marketDataHealth,
      market_data_provider_comparison: providerComparison,
      account_count: accountCount,
      phases: [
        { key: 'safety_boundary', label: '安全边界', status: 'ready', detail: '默认禁止真实下单，强确认与熔断开关已内置。' },
        { key: 'market_data', label: '真实行情入口', status: marketDataHealth.status === 'ok' ? 'ready' : marketDataHealth.status === 'empty' ? 'locked' : 'partial', detail: marketDataHealth.conclusion },
        { key: 'broker_readonly', label: '券商只读', status: safety.can_sync_account ? 'partial' : 'locked', detail: '接口与模型已就绪；真实券商适配器尚未启用。' },
        { key: 'order_approval', label: '订单审批', status: 'ready', detail: '支持订单草稿、风控说明、强确认；提交券商默认阻断。' },
        { key: 'shadow_autopilot', label: '无人影子执行', status: safety.shadow_autopilot_enabled ? 'ready' : 'locked', detail: safety.unattended_policy.conclusion },
        { key: 'execution', label: '真实执行', status: safety.can_submit_orders ? 'restricted' : 'blocked', detail: safety.can_submit_orders ? '仅限受控内部灰度。' : '真实下单被环境开关和 Mock 网关阻断。' },
      ],
      conclusion: safety.can_submit_orders
        ? '实盘执行开关已开启，但仍必须走订单审批、强确认、风控与审计。'
        : '当前处于安全只读/模拟边界：可以查看实盘方案与订单草稿，但不会提交真实委托。',
    };
  }

  async getOverview(user_id: number) {
    const readiness = await this.getReadiness(user_id);
    const account = await LiveBrokerAccount.findOne({
      where: { user_id, is_active: true },
      order: [['updated_at', 'DESC']],
    });
    const accountId = account?.id ? Number(account.id) : undefined;
    const latestSnapshot = accountId
      ? await LiveAccountSnapshot.findOne({
          where: { user_id, account_id: accountId },
          order: [['snapshot_time', 'DESC']],
        })
      : null;
    const positions = accountId
      ? await LivePosition.findAll({
          where: { user_id, account_id: accountId, quantity: { [Op.gt]: 0 } },
          order: [['market_value', 'DESC']],
          limit: 20,
        })
      : [];
    const drafts = await LiveOrderDraft.findAll({
      where: { user_id },
      order: [['created_at', 'DESC']],
      limit: 10,
    });
    const shadowDashboard = await this.getShadowAutopilotDashboard(user_id, 8);
    const reconciliation = await this.getReconciliation(user_id);
    const openDrafts = drafts.filter(item =>
      ['preview', 'pending', 'blocked', 'shadow_executed'].includes(String((item as any).status))
    );
    const exposure = positions.reduce((sum, item: any) => sum + toNumber(item.market_value), 0);
    const totalAsset = toNumber((latestSnapshot as any)?.total_asset);
    const exposurePct = totalAsset > 0 ? round((exposure / totalAsset) * 100, 4) : 0;

    return {
      generated_at: new Date().toISOString(),
      readiness,
      account: account ? this.toPlain(account) : null,
      latest_snapshot: latestSnapshot ? this.toPlain(latestSnapshot) : null,
      positions: positions.map(item => this.toPlain(item)),
      order_drafts: drafts.map(item => this.toPlain(item)),
      shadow_autopilot: shadowDashboard,
      reconciliation,
      summary: {
        account_bound: Boolean(account),
        total_asset: totalAsset,
        available_cash: toNumber((latestSnapshot as any)?.available_cash),
        market_value: toNumber((latestSnapshot as any)?.market_value) || exposure,
        exposure_pct: exposurePct,
        position_count: positions.length,
        pending_draft_count: openDrafts.length,
        shadow_executed_count: shadowDashboard.summary.shadow_executed_count,
        can_submit_orders: readiness.safety.can_submit_orders,
        market_data_status: readiness.market_data_health.status,
        market_data_conclusion: readiness.market_data_health.conclusion,
        mode_label: readiness.safety.mode === 'approval_execution_enabled' ? '实盘审批执行' : readiness.safety.mode === 'read_only' ? '只读实盘观察' : '模拟/安全禁用',
        conclusion: readiness.conclusion,
      },
    };
  }

  async getReconciliation(user_id: number) {
    const staleThresholdMinutes = Math.max(
      Number(process.env.LIVE_RECONCILIATION_STALE_MINUTES || 180),
      15
    );
    const account = await LiveBrokerAccount.findOne({
      where: { user_id, is_active: true },
      order: [['updated_at', 'DESC']],
    });
    const accountId = account?.id ? Number(account.id) : undefined;
    const latestSnapshot = accountId
      ? await LiveAccountSnapshot.findOne({
          where: { user_id, account_id: accountId },
          order: [['snapshot_time', 'DESC']],
        })
      : null;
    const livePositions = accountId
      ? await LivePosition.findAll({
          where: { user_id, account_id: accountId, quantity: { [Op.gt]: 0 } },
          order: [['market_value', 'DESC']],
          limit: 200,
        })
      : [];
    const paperAccounts = await this.getPaperAccountReconciliationRows(user_id);
    const liveTotalAsset = toNumber((latestSnapshot as any)?.total_asset);
    const liveMarketValue = livePositions.reduce(
      (sum, item: any) => sum + toNumber(item.market_value),
      0
    );
    const paperTotalValue = paperAccounts.reduce(
      (sum, item) => sum + toNumber(item.total_value),
      0
    );
    const paperMarketValue = paperAccounts.reduce(
      (sum, item) => sum + toNumber(item.position_value),
      0
    );
    const liveBySymbol = new Map<string, any>();
    livePositions.forEach((item: any) => {
      liveBySymbol.set(normalizeSymbol(item.symbol), this.toPlain(item));
    });
    const paperBySymbol = new Map<string, any>();
    for (const accountRow of paperAccounts) {
      for (const position of accountRow.positions) {
        const symbol = normalizeSymbol(position.symbol);
        const existing = paperBySymbol.get(symbol) || {
          symbol,
          name: position.name,
          quantity: 0,
          market_value: 0,
          accounts: [],
        };
        existing.quantity += toNumber(position.quantity);
        existing.market_value += toNumber(position.market_value);
        existing.accounts.push({
          key: accountRow.key,
          label: accountRow.label,
          portfolio_id: accountRow.portfolio_id,
          quantity: toNumber(position.quantity),
          market_value: round(position.market_value),
        });
        paperBySymbol.set(symbol, existing);
      }
    }

    const symbols = Array.from(new Set([...liveBySymbol.keys(), ...paperBySymbol.keys()])).sort();
    const positionMatches = symbols.map(symbol => {
      const live = liveBySymbol.get(symbol);
      const paper = paperBySymbol.get(symbol);
      const liveValue = toNumber(live?.market_value);
      const paperValue = toNumber(paper?.market_value);
      const liveWeightPct = liveTotalAsset > 0 ? round((liveValue / liveTotalAsset) * 100, 4) : 0;
      const paperWeightPct =
        paperTotalValue > 0 ? round((paperValue / paperTotalValue) * 100, 4) : 0;
      const weightGapPct = round(liveWeightPct - paperWeightPct, 4);
      const status = !live
        ? 'paper_only'
        : !paper
        ? 'live_only'
        : Math.abs(weightGapPct) <= 2.5
        ? 'aligned'
        : weightGapPct > 0
        ? 'live_overweight'
        : 'live_underweight';
      return {
        symbol,
        name: live?.name || paper?.name || symbol,
        status,
        status_label:
          status === 'aligned'
            ? '权重接近'
            : status === 'live_only'
            ? '仅实盘持有'
            : status === 'paper_only'
            ? '仅模拟建议'
            : status === 'live_overweight'
            ? '实盘偏重'
            : '实盘偏轻',
        live_quantity: toNumber(live?.quantity),
        live_market_value: round(liveValue),
        live_weight_pct: liveWeightPct,
        live_current_price: toNumber(live?.current_price),
        paper_quantity: toNumber(paper?.quantity),
        paper_market_value: round(paperValue),
        paper_weight_pct: paperWeightPct,
        weight_gap_pct: weightGapPct,
        paper_accounts: paper?.accounts || [],
      };
    });

    const bothSideMatches = positionMatches.filter(item =>
      ['aligned', 'live_overweight', 'live_underweight'].includes(item.status)
    );
    const averageGapPct = bothSideMatches.length
      ? round(
          bothSideMatches.reduce((sum, item) => sum + Math.abs(item.weight_gap_pct), 0) /
            bothSideMatches.length,
          4
        )
      : 0;
    const liveOnlyCount = positionMatches.filter(item => item.status === 'live_only').length;
    const paperOnlyCount = positionMatches.filter(item => item.status === 'paper_only').length;
    const alignmentScore = round(
      Math.max(0, 100 - averageGapPct * 8 - (liveOnlyCount + paperOnlyCount) * 6),
      2
    );
    const snapshotAge = ageMinutes((latestSnapshot as any)?.snapshot_time);
    const status = !account
      ? 'not_bound'
      : !latestSnapshot
      ? 'no_snapshot'
      : snapshotAge !== null && snapshotAge > staleThresholdMinutes
      ? 'stale'
      : alignmentScore >= 80
      ? 'aligned'
      : alignmentScore >= 55
      ? 'diverged'
      : 'high_divergence';
    const suggestions = this.buildReconciliationSuggestions({
      status,
      snapshot_age_minutes: snapshotAge,
      stale_threshold_minutes: staleThresholdMinutes,
      live_only_count: liveOnlyCount,
      paper_only_count: paperOnlyCount,
      live_market_value: liveMarketValue,
      paper_market_value: paperMarketValue,
      alignment_score: alignmentScore,
    });

    return {
      generated_at: new Date().toISOString(),
      status,
      status_label:
        status === 'not_bound'
          ? '未接账户'
          : status === 'no_snapshot'
          ? '待同步'
          : status === 'stale'
          ? '快照过期'
          : status === 'aligned'
          ? '基本一致'
          : status === 'diverged'
          ? '存在偏离'
          : '偏离较大',
      account: account ? this.toPlain(account) : null,
      latest_snapshot: latestSnapshot ? this.toPlain(latestSnapshot) : null,
      snapshot_age_minutes: snapshotAge,
      stale_threshold_minutes: staleThresholdMinutes,
      paper_accounts: paperAccounts.map(item => ({
        ...item,
        positions: item.positions.slice(0, 10),
      })),
      position_matches: positionMatches
        .sort(
          (a, b) =>
            Math.max(Math.abs(b.live_market_value), Math.abs(b.paper_market_value)) -
            Math.max(Math.abs(a.live_market_value), Math.abs(a.paper_market_value))
        )
        .slice(0, 80),
      suggestions,
      summary: {
        live_total_asset: round(liveTotalAsset),
        live_available_cash: round((latestSnapshot as any)?.available_cash),
        live_market_value: round(liveMarketValue),
        live_position_count: livePositions.length,
        paper_total_value: round(paperTotalValue),
        paper_market_value: round(paperMarketValue),
        paper_position_count: Array.from(paperBySymbol.keys()).length,
        overlap_count: bothSideMatches.length,
        live_only_count: liveOnlyCount,
        paper_only_count: paperOnlyCount,
        average_weight_gap_pct: averageGapPct,
        alignment_score: alignmentScore,
        conclusion: this.buildReconciliationConclusion({
          status,
          alignment_score: alignmentScore,
          live_only_count: liveOnlyCount,
          paper_only_count: paperOnlyCount,
          snapshot_age_minutes: snapshotAge,
        }),
      },
    };
  }

  async getDraftCandidates(user_id: number, options: { limit?: number } = {}) {
    const reconciliation = await this.getReconciliation(user_id);
    const maxCandidates = Math.min(Math.max(Number(options.limit || 20), 1), 80);
    const accountReady = Boolean(reconciliation.account && reconciliation.latest_snapshot);
    const rawMatches = (reconciliation.position_matches || []).filter((item: any) =>
      ['paper_only', 'live_underweight'].includes(String(item.status))
    );
    const candidates = rawMatches.slice(0, maxCandidates);
    const existingDrafts = candidates.length
      ? await LiveOrderDraft.findAll({
          where: {
            user_id,
            symbol: { [Op.in]: candidates.map((item: any) => item.symbol) },
            side: 'BUY',
            status: { [Op.in]: ['preview', 'pending', 'blocked', 'approved'] },
          },
          order: [['created_at', 'DESC']],
        })
      : [];
    const latestDraftBySymbol = new Map<string, any>();
    for (const draft of existingDrafts) {
      const symbol = normalizeSymbol((draft as any).symbol);
      if (!latestDraftBySymbol.has(symbol)) latestDraftBySymbol.set(symbol, this.toPlain(draft));
    }

    const rows = await Promise.all(
      candidates.map(async (candidate: any) => {
        const quote = await this.quoteProvider.getQuote(candidate.symbol);
        const quotePx = quotePrice(quote);
        const targetGapValue =
          candidate.status === 'paper_only'
            ? toNumber(candidate.paper_market_value)
            : Math.max(0, toNumber(candidate.paper_market_value) - toNumber(candidate.live_market_value));
        const rawQuantity = quotePx > 0 ? Math.floor(targetGapValue / quotePx / 100) * 100 : 0;
        const quantity = Math.max(0, rawQuantity);
        const estimatedAmount = round(quantity * quotePx, 2);
        const duplicate = latestDraftBySymbol.get(normalizeSymbol(candidate.symbol));
        const eligible =
          accountReady &&
          quantity >= 100 &&
          quotePx > 0 &&
          !duplicate &&
          reconciliation.status !== 'stale';
        return {
          symbol: candidate.symbol,
          name: candidate.name,
          side: 'BUY',
          status: candidate.status,
          status_label: candidate.status_label,
          candidate_type: candidate.status,
          suggested_quantity: quantity,
          suggested_limit_price: round(quotePx, 4),
          estimated_amount: estimatedAmount,
          target_gap_value: round(targetGapValue, 2),
          live_weight_pct: candidate.live_weight_pct,
          paper_weight_pct: candidate.paper_weight_pct,
          weight_gap_pct: candidate.weight_gap_pct,
          paper_accounts: candidate.paper_accounts || [],
          quote_snapshot: quote || {},
          duplicate_draft: duplicate
            ? {
                id: duplicate.id,
                status: duplicate.status,
                created_at: duplicate.created_at,
              }
            : null,
          eligible,
          block_reason: eligible
            ? ''
            : duplicate
            ? `已有未完成草稿 #${duplicate.id}`
            : !accountReady
            ? '缺少券商只读账户/资产快照'
            : reconciliation.status === 'stale'
            ? '券商只读快照已过期'
            : quotePx <= 0
            ? '缺少可用行情'
            : quantity < 100
            ? '差额不足 100 股整手'
            : '不满足生成条件',
          rationale: this.buildCandidateRationale(candidate, quote),
        };
      })
    );

    const eligibleCount = rows.filter(item => item.eligible).length;
    return {
      generated_at: new Date().toISOString(),
      reconciliation_summary: reconciliation.summary,
      account_ready: accountReady,
      candidates: rows,
      summary: {
        total_count: rows.length,
        eligible_count: eligibleCount,
        duplicate_count: rows.filter(item => item.duplicate_draft).length,
        blocked_count: rows.length - eligibleCount,
        conclusion: accountReady
          ? eligibleCount > 0
            ? `发现 ${eligibleCount} 个可生成实盘草稿的策略候选；也可进入无人影子执行，但真实券商委托仍不会跳过确认。`
            : '当前没有满足整手、行情、账户快照和去重条件的实盘草稿候选。'
          : '尚未完成券商只读账户同步，策略候选只能观察，不能生成可提交草稿。',
      },
    };
  }

  async createDraftFromCandidate(user_id: number, input: any) {
    const symbol = normalizeSymbol(input.symbol);
    if (!symbol) throw new Error('缺少候选股票代码');
    const candidates = await this.getDraftCandidates(user_id, { limit: Number(input.limit || 80) });
    const candidate = candidates.candidates.find((item: any) => normalizeSymbol(item.symbol) === symbol);
    if (!candidate) throw new Error('未找到该股票的策略候选，请先刷新只读对账候选。');
    if (!candidate.eligible) {
      throw new Error(`该候选暂不可生成实盘草稿：${candidate.block_reason || '未满足风控前置条件'}`);
    }
    return this.createDraft(user_id, {
      symbol: candidate.symbol,
      name: candidate.name,
      side: 'BUY',
      quantity: input.quantity || candidate.suggested_quantity,
      limit_price: input.limit_price || candidate.suggested_limit_price,
      source_type: 'paper_strategy_reconciliation',
      source_id: input.source_id || `${candidate.candidate_type}:${candidate.symbol}`,
      rationale:
        input.rationale ||
        `${candidate.rationale} 该操作只生成实盘订单草稿，不会自动下单；确认前会再次复核行情、账户和风控。`,
      metadata: {
        created_from: 'live_reconciliation_candidate',
        candidate,
        reconciliation_summary: candidates.reconciliation_summary,
      },
    });
  }

  async runShadowAutopilot(
    user_id: number,
    options: { limit?: number; source?: string; dry_run?: boolean } = {}
  ) {
    const safety = liveTradingSafetyService.getStatus();
    const maxCount = Math.min(Math.max(Number(options.limit || 3), 1), 10);
    const dryRun = options.dry_run === true;

    if (!safety.shadow_autopilot_enabled) {
      throw new Error('无人影子执行未启用：请设置 LIVE_SHADOW_AUTOPILOT_ENABLED=true。');
    }

    const candidateDashboard = await this.getDraftCandidates(user_id, { limit: Math.max(maxCount, 10) });
    const candidates = (candidateDashboard.candidates || [])
      .filter((item: any) => item.eligible)
      .slice(0, maxCount);
    const results: any[] = [];

    for (const candidate of candidates) {
      if (dryRun) {
        results.push({
          symbol: candidate.symbol,
          name: candidate.name,
          side: candidate.side || 'BUY',
          quantity: candidate.suggested_quantity,
          limit_price: candidate.suggested_limit_price,
          estimated_amount: candidate.estimated_amount,
          status: 'dry_run',
          message: '影子执行预演：不会创建草稿，也不会提交券商。',
        });
        continue;
      }

      const draft = await this.createDraft(user_id, {
        symbol: candidate.symbol,
        name: candidate.name,
        side: candidate.side || 'BUY',
        quantity: candidate.suggested_quantity,
        limit_price: candidate.suggested_limit_price,
        source_type: 'shadow_autopilot',
        source_id: `${candidate.candidate_type}:${candidate.symbol}`,
        rationale: `${candidate.rationale} 无人确认模式仅执行影子实盘：记录假设成交与风控审计，不提交真实券商委托。`,
        metadata: {
          created_from: 'live_shadow_autopilot',
          shadow_autopilot: true,
          source: options.source || 'manual_shadow_autopilot',
          candidate,
          reconciliation_summary: candidateDashboard.reconciliation_summary,
          safety_status: safety,
        },
      });
      const executed = await this.markDraftShadowExecuted(user_id, Number(draft.id), {
        source: options.source || 'manual_shadow_autopilot',
      });
      results.push(executed);
    }

    const blockedCount = Math.max(0, Number(candidateDashboard.summary.total_count || 0) - candidates.length);
    const summary = {
      dry_run: dryRun,
      selected_count: candidates.length,
      shadow_executed_count: dryRun ? 0 : results.length,
      blocked_count: blockedCount,
      real_order_submitted: 0,
      conclusion: dryRun
        ? `影子执行预演完成：可选 ${candidates.length} 条，不会创建草稿或提交券商。`
        : candidates.length > 0
        ? `无人影子执行完成：记录 ${results.length} 条假设成交；真实券商委托提交数为 0。`
        : '暂无满足账户快照、行情、整手和去重条件的影子执行候选。',
    };

    await this.audit({
      user_id,
      event_type: dryRun ? 'live_shadow_autopilot_dry_run' : 'live_shadow_autopilot_completed',
      severity: dryRun ? 'info' : 'warning',
      message: summary.conclusion,
      metadata: {
        options,
        summary,
        candidate_summary: candidateDashboard.summary,
        safety_status: safety,
      },
    });

    return {
      generated_at: new Date().toISOString(),
      mode: 'shadow_only',
      safety: {
        can_submit_orders: safety.can_submit_orders,
        unattended_real_order_allowed: safety.unattended_real_order_allowed,
        conclusion: safety.unattended_policy.conclusion,
      },
      summary,
      results,
    };
  }

  async getShadowAutopilotDashboard(user_id: number, limit = 20) {
    const rows = await LiveOrderDraft.findAll({
      where: {
        user_id,
        source_type: 'shadow_autopilot',
      },
      order: [['updated_at', 'DESC']],
      limit: Math.min(Math.max(Number(limit || 20), 1), 100),
    });
    const drafts = rows.map(item => this.toPlain(item));
    const executed = drafts.filter(item => item.status === 'shadow_executed');
    const totalAmount = executed.reduce((sum, item) => sum + toNumber(item.estimated_amount), 0);
    const latest = drafts[0] || null;
    return {
      generated_at: new Date().toISOString(),
      enabled: liveTradingSafetyService.getStatus().shadow_autopilot_enabled,
      drafts,
      summary: {
        total_count: drafts.length,
        shadow_executed_count: executed.length,
        total_shadow_amount: round(totalAmount, 2),
        latest_at: latest?.updated_at || latest?.created_at || null,
        real_order_submitted: 0,
        conclusion: executed.length
          ? `已沉淀 ${executed.length} 条无人影子执行记录，用于后续和真实/模拟收益偏差对比。`
          : '暂无无人影子执行记录；可先从策略候选生成影子成交闭环。',
      },
    };
  }

  async getShadowAutopilotOutcomes(
    user_id: number,
    options: { limit?: number; horizons?: number[] } = {}
  ) {
    const limit = Math.min(Math.max(Number(options.limit || 20), 1), 100);
    const horizons = (options.horizons || [1, 3, 5])
      .map(value => Math.max(1, Math.min(30, Math.floor(Number(value)))))
      .filter(Boolean)
      .slice(0, 6);
    const uniqueHorizons = horizons.length ? Array.from(new Set(horizons)) : [1, 3, 5];
    const rows = await LiveOrderDraft.findAll({
      where: {
        user_id,
        source_type: 'shadow_autopilot',
        status: 'shadow_executed',
      },
      order: [['updated_at', 'DESC']],
      limit,
    });

    const items = await Promise.all(
      rows.map(async row => this.buildShadowOutcomeItem(this.toPlain(row), uniqueHorizons))
    );
    const evaluated = items.filter(item => item.evaluable);
    const wins = evaluated.filter(item => Number(item.latest_return_pct || 0) > 0);
    const totalAmount = items.reduce((sum, item) => sum + toNumber(item.shadow_amount), 0);
    const totalPnl = evaluated.reduce((sum, item) => sum + toNumber(item.latest_pnl), 0);
    const avgLatestReturn = evaluated.length
      ? evaluated.reduce((sum, item) => sum + toNumber(item.latest_return_pct), 0) /
        evaluated.length
      : null;
    const winRate = evaluated.length ? (wins.length / evaluated.length) * 100 : null;
    const best = evaluated
      .slice()
      .sort((a, b) => toNumber(b.latest_return_pct) - toNumber(a.latest_return_pct))[0] || null;
    const worst = evaluated
      .slice()
      .sort((a, b) => toNumber(a.latest_return_pct) - toNumber(b.latest_return_pct))[0] || null;
    const horizonSummary = uniqueHorizons.map(days => {
      const key = `${days}d`;
      const rowsWithHorizon = items.filter(item => item.horizon_returns?.[key]?.evaluable);
      const horizonWins = rowsWithHorizon.filter(
        item => Number(item.horizon_returns?.[key]?.return_pct || 0) > 0
      );
      return {
        horizon_days: days,
        evaluated_count: rowsWithHorizon.length,
        avg_return_pct: rowsWithHorizon.length
          ? round(
              rowsWithHorizon.reduce(
                (sum, item) => sum + toNumber(item.horizon_returns?.[key]?.return_pct),
                0
              ) / rowsWithHorizon.length,
              4
            )
          : null,
        win_rate_pct: rowsWithHorizon.length
          ? round((horizonWins.length / rowsWithHorizon.length) * 100, 2)
          : null,
      };
    });
    const baseline = await this.getShadowOutcomeBaseline(user_id, {
      since: items
        .map(item => item.entry_time)
        .filter(Boolean)
        .sort()[0],
      limit: 500,
    });

    const conclusion = this.buildShadowOutcomeConclusion({
      total_count: items.length,
      evaluated_count: evaluated.length,
      avg_latest_return_pct: avgLatestReturn,
      win_rate_pct: winRate,
      baseline,
    });
    const budgetDecision = this.buildShadowBudgetDecision({
      total_count: items.length,
      evaluated_count: evaluated.length,
      avg_latest_return_pct: avgLatestReturn,
      win_rate_pct: winRate,
      baseline,
    });

    return {
      generated_at: new Date().toISOString(),
      horizons: uniqueHorizons,
      items,
      summary: {
        shadow_trade_count: items.length,
        evaluated_count: evaluated.length,
        open_count: items.length - evaluated.length,
        win_count: wins.length,
        loss_count: evaluated.length - wins.length,
        win_rate_pct: roundNullable(winRate, 2),
        avg_latest_return_pct: roundNullable(avgLatestReturn, 4),
        total_shadow_amount: round(totalAmount, 2),
        total_latest_pnl: round(totalPnl, 2),
        real_order_submitted: 0,
        best,
        worst,
        horizon_summary: horizonSummary,
        baseline,
        budget_decision: budgetDecision,
        conclusion,
      },
    };
  }

  async getShadowAutopilotTrend(user_id: number, options: { limit?: number } = {}) {
    const limit = Math.min(Math.max(Number(options.limit || 12), 2), 60);
    const rows = await TaskExecutionLog.findAll({
      where: {
        status: 'COMPLETED',
        started_at: { [Op.gte]: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
      },
      order: [['completed_at', 'DESC']],
      limit: Math.max(limit * 4, 40),
      raw: true,
    }).catch(() => []);
    const points = (rows as any[])
      .filter(row =>
        ['live_shadow_autopilot', 'live_shadow_weekly_review'].includes(
          String(asPlainObject(row.result_summary).scenario || '')
        )
      )
      .slice(0, limit)
      .slice()
      .reverse()
      .map(row => {
        const summary = asPlainObject(row.result_summary);
        return {
          log_id: row.id,
          task_name: row.task_name,
          scenario: summary.scenario,
          completed_at: row.completed_at || row.updated_at || row.created_at,
          date: localDateKey(row.completed_at || row.updated_at || row.created_at),
          avg_return_pct: numberOrNull(
            summary.outcome_avg_latest_return_pct ?? summary.avg_latest_return_pct
          ),
          win_rate_pct: numberOrNull(summary.outcome_win_rate_pct ?? summary.win_rate_pct),
          total_pnl: numberOrNull(summary.outcome_total_latest_pnl ?? summary.total_latest_pnl),
          evaluated_count: toNumber(summary.outcome_evaluated_count ?? summary.evaluated_count),
          shadow_trade_count: toNumber(summary.outcome_trade_count ?? summary.shadow_trade_count),
          recommended_limit: numberOrNull(summary.budget_recommended_limit),
          budget_label: summary.budget_label || '',
          real_order_submitted: toNumber(summary.real_order_submitted),
        };
      });
    const latest = points[points.length - 1] || null;
    return {
      generated_at: new Date().toISOString(),
      user_id,
      points,
      summary: {
        point_count: points.length,
        latest_avg_return_pct: latest?.avg_return_pct ?? null,
        latest_win_rate_pct: latest?.win_rate_pct ?? null,
        latest_recommended_limit: latest?.recommended_limit ?? null,
        latest_budget_label: latest?.budget_label || '',
        real_order_submitted: points.reduce((sum, item) => sum + toNumber(item.real_order_submitted), 0),
        conclusion: points.length >= 2
          ? '影子执行趋势已可观察，用于判断预算是否应继续小流量、降温或扩大。'
          : '影子执行趋势样本仍少，等待更多定时任务执行日志。',
      },
    };
  }

  async getShadowBudgetAttribution(
    user_id: number,
    options: { limit?: number; lookback_days?: number; window_days?: number } = {}
  ) {
    const limit = Math.min(Math.max(Number(options.limit || 8), 1), 20);
    const lookbackDays = Math.min(Math.max(Number(options.lookback_days || 90), 14), 365);
    const windowDays = Math.min(Math.max(Number(options.window_days || 14), 3), 60);
    const now = Date.now();
    const since = new Date(now - lookbackDays * 24 * 60 * 60 * 1000);
    const horizons = [1, 3, 5];

    const auditRows = await TaskParameterAuditLog.findAll({
      where: {
        event_type: {
          [Op.in]: ['live_shadow_budget_suggestion', 'live_shadow_budget_applied'],
        },
        created_at: { [Op.gte]: since },
      },
      order: [['created_at', 'DESC']],
      limit: 200,
      raw: true,
    }).catch(() => []);
    const suggestions = (auditRows as any[])
      .filter(row => row.event_type === 'live_shadow_budget_suggestion')
      .slice(0, limit);
    const appliedRows = (auditRows as any[]).filter(
      row => row.event_type === 'live_shadow_budget_applied'
    );

    const draftRows = await LiveOrderDraft.findAll({
      where: {
        user_id,
        source_type: 'shadow_autopilot',
        status: 'shadow_executed',
        updated_at: {
          [Op.gte]: new Date(now - (lookbackDays + windowDays) * 24 * 60 * 60 * 1000),
        },
      },
      order: [['updated_at', 'DESC']],
      limit: 300,
    }).catch(() => []);
    const outcomes = await Promise.all(
      (draftRows as any[]).map(row => this.buildShadowOutcomeItem(this.toPlain(row), horizons))
    );

    const summarizeWindow = (fromTime: number, toTime: number) => {
      const scoped = outcomes.filter(item => {
        const entryTime = new Date(item.entry_time || item.entry_date || '').getTime();
        return Number.isFinite(entryTime) && entryTime >= fromTime && entryTime < toTime;
      });
      const evaluated = scoped.filter(item => numberOrNull(item.latest_return_pct) !== null);
      const wins = evaluated.filter(item => Number(item.latest_return_pct || 0) > 0);
      const avgLatest = evaluated.length
        ? evaluated.reduce((sum, item) => sum + Number(item.latest_return_pct || 0), 0) /
          evaluated.length
        : null;
      const horizon_summary = horizons.map(days => {
        const key = `${days}d`;
        const horizonRows = scoped.filter(item => item.horizon_returns?.[key]?.evaluable);
        const horizonWins = horizonRows.filter(
          item => Number(item.horizon_returns?.[key]?.return_pct || 0) > 0
        );
        return {
          horizon_days: days,
          evaluated_count: horizonRows.length,
          avg_return_pct: horizonRows.length
            ? round(
                horizonRows.reduce(
                  (sum, item) => sum + Number(item.horizon_returns?.[key]?.return_pct || 0),
                  0
                ) / horizonRows.length,
                4
              )
            : null,
          win_rate_pct: horizonRows.length
            ? round((horizonWins.length / horizonRows.length) * 100, 2)
            : null,
        };
      });
      const sorted = evaluated
        .slice()
        .sort((left, right) => Number(left.latest_return_pct || 0) - Number(right.latest_return_pct || 0));
      return {
        from: new Date(fromTime).toISOString(),
        to: new Date(toTime).toISOString(),
        sample_count: scoped.length,
        evaluated_count: evaluated.length,
        win_count: wins.length,
        win_rate_pct: evaluated.length ? round((wins.length / evaluated.length) * 100, 2) : null,
        avg_latest_return_pct: roundNullable(avgLatest, 4),
        total_latest_pnl: round(evaluated.reduce((sum, item) => sum + toNumber(item.latest_pnl), 0), 2),
        best_return_pct: sorted.length
          ? roundNullable(sorted[sorted.length - 1].latest_return_pct, 4)
          : null,
        worst_return_pct: sorted.length ? roundNullable(sorted[0].latest_return_pct, 4) : null,
        horizon_summary,
      };
    };

    const findApplyForSuggestion = (suggestion: any) => {
      const suggestionId = Number(suggestion.id);
      const suggestionTime = new Date(suggestion.created_at).getTime();
      const after = asPlainObject(suggestion.after_parameters);
      const suggestedLimit = Number(after.limit ?? after.shadow_budget_advice?.recommended_limit);
      return appliedRows
        .filter(row => {
          const metadata = asPlainObject(row.metadata);
          const afterParameters = asPlainObject(row.after_parameters);
          const advice = asPlainObject(afterParameters.shadow_budget_advice);
          const rowTime = new Date(row.created_at).getTime();
          if (!Number.isFinite(rowTime) || rowTime < suggestionTime) return false;
          if (Number(metadata.source_audit_id) === suggestionId) return true;
          if (Number(advice.source_audit_id) === suggestionId) return true;
          return (
            Number(row.task_id) === Number(suggestion.task_id) &&
            Number(afterParameters.limit) === suggestedLimit
          );
        })
        .sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime())[0] || null;
    };

    const periods = suggestions.map(suggestion => {
      const before = asPlainObject(suggestion.before_parameters);
      const after = asPlainObject(suggestion.after_parameters);
      const advice = asPlainObject(after.shadow_budget_advice);
      const applied = findApplyForSuggestion(suggestion);
      const anchorTime = new Date(applied?.created_at || suggestion.created_at).getTime();
      const safeAnchorTime = Number.isFinite(anchorTime) ? anchorTime : now;
      const pre = summarizeWindow(
        safeAnchorTime - windowDays * 24 * 60 * 60 * 1000,
        safeAnchorTime
      );
      const post = summarizeWindow(
        safeAnchorTime,
        Math.min(now, safeAnchorTime + windowDays * 24 * 60 * 60 * 1000)
      );
      const avgDelta =
        numberOrNull(pre.avg_latest_return_pct) !== null &&
        numberOrNull(post.avg_latest_return_pct) !== null
          ? round(Number(post.avg_latest_return_pct) - Number(pre.avg_latest_return_pct), 4)
          : null;
      const winRateDelta =
        numberOrNull(pre.win_rate_pct) !== null && numberOrNull(post.win_rate_pct) !== null
          ? round(Number(post.win_rate_pct) - Number(pre.win_rate_pct), 2)
          : null;
      const postAvg = numberOrNull(post.avg_latest_return_pct);
      const decision = !applied
        ? {
            action: 'pending_apply',
            label: '候选待应用',
            level: 'watch',
            reason: '该影子预算建议尚未应用，暂不能判断应用后的收益变化。',
          }
        : post.evaluated_count < 3
        ? {
            action: 'collecting_after_apply',
            label: '继续收集',
            level: 'watch',
            reason: `应用后可评估样本 ${post.evaluated_count} 条，暂不足以判断预算调整是否有效。`,
          }
        : pre.evaluated_count < 3
        ? {
            action: 'insufficient_baseline',
            label: '缺少前置基准',
            level: 'watch',
            reason: `应用前可评估样本 ${pre.evaluated_count} 条，缺少可靠对照。`,
          }
        : avgDelta !== null && avgDelta >= 0.5 && (postAvg === null || postAvg >= 0)
        ? {
            action: 'effective',
            label: '调整有效',
            level: 'ok',
            reason: `应用后平均收益较应用前提升 ${round(avgDelta, 2)}pct。`,
          }
        : avgDelta !== null && (avgDelta <= -0.5 || (postAvg !== null && postAvg < -1))
        ? {
            action: 'ineffective',
            label: '调整偏弱',
            level: 'risk',
            reason: `应用后平均收益较应用前变化 ${round(avgDelta, 2)}pct，建议降温观察。`,
          }
        : {
            action: 'neutral',
            label: '效果中性',
            level: 'watch',
            reason: `应用前后收益变化 ${avgDelta !== null ? round(avgDelta, 2) : '--'}pct，继续观察。`,
          };

      return {
        audit_id: Number(suggestion.id),
        task_id: Number(suggestion.task_id),
        task_name: suggestion.task_name,
        generated_at: suggestion.created_at,
        applied: Boolean(applied),
        applied_audit_id: applied ? Number(applied.id) : null,
        applied_at: applied?.created_at || null,
        before_limit: before.limit ?? advice.current_limit ?? null,
        suggested_limit: after.limit ?? advice.recommended_limit ?? null,
        budget_action: advice.action || '',
        budget_label: advice.label || '',
        budget_reason: advice.reason || '',
        pre_window: pre,
        post_window: post,
        delta: {
          avg_latest_return_pct: avgDelta,
          win_rate_pct: winRateDelta,
          evaluated_count: post.evaluated_count - pre.evaluated_count,
          total_latest_pnl: round(post.total_latest_pnl - pre.total_latest_pnl, 2),
        },
        decision,
      };
    });
    const latest = periods[0] || null;
    const appliedCount = periods.filter(item => item.applied).length;
    const effectiveCount = periods.filter(item => item.decision.action === 'effective').length;
    const ineffectiveCount = periods.filter(item => item.decision.action === 'ineffective').length;
    const summaryConclusion = latest
      ? latest.decision.action === 'pending_apply'
        ? '最新影子预算建议仍待应用；建议先在调度任务页预览后受控应用，再观察应用后收益。'
        : latest.decision.action === 'effective'
        ? '最新已应用影子预算建议显示正向改善，可继续按当前影子预算收集样本。'
        : latest.decision.action === 'ineffective'
        ? '最新已应用影子预算建议表现偏弱，建议降低影子预算并复盘信号来源。'
        : latest.decision.reason
      : '暂无影子预算候选补丁；等待周度影子复盘生成建议。';

    return {
      generated_at: new Date().toISOString(),
      user_id,
      lookback_days: lookbackDays,
      window_days: windowDays,
      real_order_submitted: 0,
      periods,
      summary: {
        suggestion_count: periods.length,
        applied_count: appliedCount,
        pending_count: periods.length - appliedCount,
        effective_count: effectiveCount,
        ineffective_count: ineffectiveCount,
        latest_action: latest?.decision.action || 'none',
        latest_label: latest?.decision.label || '暂无建议',
        latest_level: latest?.decision.level || 'watch',
        latest_suggested_limit: latest?.suggested_limit ?? null,
        latest_delta_avg_return_pct: latest?.delta.avg_latest_return_pct ?? null,
        latest_delta_win_rate_pct: latest?.delta.win_rate_pct ?? null,
        total_shadow_sample_count: outcomes.length,
        total_evaluated_count: outcomes.filter(item => numberOrNull(item.latest_return_pct) !== null).length,
        conclusion: summaryConclusion,
      },
    };
  }

  async getMarketDataHealth(symbols?: string[], provider: LiveMarketDataProvider = this.quoteProvider) {
    const providerInfo = provider.getProviderInfo();
    const sla = liveTradingSafetyService.getMarketDataSla();
    const targetSymbols = (symbols || []).length
      ? symbols!.map(normalizeSymbol)
      : await this.pickHealthSymbols();
    const quotes = targetSymbols.length ? await provider.getQuotes(targetSymbols) : [];
    const quoteBySymbol = new Map(quotes.map(quote => [normalizeSymbol(quote.symbol), quote]));
    const items = targetSymbols.map(symbol => {
      const quote = quoteBySymbol.get(normalizeSymbol(symbol));
      const latency = quoteLatency(quote);
      const missing = !quote || !quotePrice(quote);
      const stale =
        !missing &&
        latency !== undefined &&
        Number(latency) > Number(sla.max_quote_latency_seconds || 0);
      return {
        symbol,
        name: quote?.name,
        current_price: quote?.current_price,
        quote_time: quote?.quote_time,
        source: quote?.source || providerInfo.provider_key,
        latency_seconds: latency,
        is_realtime: Boolean(quote?.is_realtime),
        missing,
        stale,
        status: missing ? 'missing' : stale ? 'stale' : quote?.is_realtime ? 'fresh' : 'cached',
      };
    });
    const missingCount = items.filter(item => item.missing).length;
    const staleCount = items.filter(item => item.stale).length;
    const total = Math.max(items.length, 1);
    const missingRatio = round((missingCount / total) * 100, 4);
    const maxLatency = Math.max(0, ...items.map(item => Number(item.latency_seconds || 0)));
    const licensed = Boolean(providerInfo.licensed_for_external_use);
    const status =
      items.length === 0
        ? 'empty'
        : missingRatio > sla.max_missing_quote_ratio_pct
        ? 'risk'
        : staleCount > 0
        ? 'degraded'
        : 'ok';
    return {
      provider: providerInfo,
      sla,
      status,
      status_label:
        status === 'ok'
          ? '行情可用'
          : status === 'degraded'
          ? '部分延迟'
          : status === 'risk'
          ? '缺口偏高'
          : '暂无样本',
      checked_symbols: targetSymbols,
      sample_count: items.length,
      missing_count: missingCount,
      stale_count: staleCount,
      missing_ratio_pct: missingRatio,
      max_latency_seconds: maxLatency,
      licensed_for_external_use: licensed,
      items,
      conclusion:
        status === 'ok'
          ? `行情缓存满足当前 SLA：检查 ${items.length} 个样本，最大延迟 ${maxLatency} 秒。`
          : status === 'degraded'
          ? `行情存在延迟：${staleCount} 个样本超过 ${sla.max_quote_latency_seconds} 秒，实盘草稿需谨慎。`
          : status === 'risk'
          ? `行情缺口偏高：缺失率 ${missingRatio}%，不应进入真实下单。`
          : '暂无可检查的行情样本，请先完成实时行情同步。',
      warnings: [
        ...(licensed ? [] : ['当前行情 provider 未声明对外商业授权，只能用于内部验证。']),
        ...(status === 'ok' ? [] : ['行情未完全满足实盘 SLA，订单草稿会保守阻断或要求复核。']),
      ],
      generated_at: new Date().toISOString(),
    };
  }

  async getMarketDataProviderComparison(symbols?: string[]) {
    const targetSymbols = (symbols || []).length
      ? symbols!.map(normalizeSymbol)
      : await this.pickHealthSymbols();
    const database = await this.getMarketDataHealth(targetSymbols, this.databaseQuoteProvider);
    const licensedConfigured = this.licensedQuoteProvider.isConfigured()
      ? await this.getMarketDataHealth(targetSymbols, this.licensedQuoteProvider)
      : {
          provider: this.licensedQuoteProvider.getProviderInfo(),
          sla: liveTradingSafetyService.getMarketDataSla(),
          status: 'not_configured',
          status_label: '未配置',
          checked_symbols: targetSymbols,
          sample_count: 0,
          missing_count: targetSymbols.length,
          stale_count: 0,
          missing_ratio_pct: 100,
          max_latency_seconds: 0,
          licensed_for_external_use: false,
          items: [],
          conclusion: '未配置 LIVE_LICENSED_QUOTE_URL_TEMPLATE，暂不能进行授权行情源对比。',
          warnings: ['对外使用前必须配置授权明确的实时行情源。'],
          generated_at: new Date().toISOString(),
        };
    return {
      active_provider_key: this.quoteProvider.getProviderInfo().provider_key,
      providers: [database, licensedConfigured],
      conclusion: this.licensedQuoteProvider.isConfigured()
        ? '已完成本地缓存与授权行情 provider 对比，请优先使用满足 SLA 且具备授权声明的数据源。'
        : '当前仅使用本地行情缓存；授权行情 provider 尚未配置。',
    };
  }

  async listDrafts(user_id: number, options: { status?: string; limit?: number } = {}) {
    const where: any = { user_id };
    if (options.status && options.status !== 'all') where.status = options.status;
    const rows = await LiveOrderDraft.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: Math.min(Math.max(Number(options.limit || 50), 1), 200),
    });
    return rows.map(item => this.toPlain(item));
  }

  async createDraft(user_id: number, input: any) {
    const symbol = normalizeSymbol(input.symbol);
    const side = String(input.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const stock = await Stock.findOne({ where: { symbol } });
    const quote = await this.quoteProvider.getQuote(symbol);
    const name = input.name || quote?.name || (stock as any)?.name || symbol;
    const limitPrice = round(input.limit_price || input.limitPrice || quote?.current_price || (stock as any)?.price, 4);
    const quantity = Math.max(0, Math.floor(Number(input.quantity || 0) / 100) * 100);
    const overview = await this.getOverview(user_id);
    const accountId = Number(input.account_id || overview.account?.id || 0) || undefined;
    const position = overview.positions.find((item: any) => item.symbol === symbol);
    const riskCheck = liveRiskGuardService.evaluate({
      side,
      symbol,
      name,
      quantity,
      limit_price: limitPrice,
      total_asset: overview.summary.total_asset,
      available_cash: overview.summary.available_cash,
      current_position_value: toNumber(position?.market_value),
      total_exposure_pct: overview.summary.exposure_pct,
      is_st: /ST|退/.test(String(name || '')),
      quote_missing: !quote || !quotePrice(quote),
      quote_latency_seconds: quoteLatency(quote),
      quote_is_realtime: quote?.is_realtime,
      quote_source: quote?.source,
      price_deviation_pct:
        quotePrice(quote) > 0 && limitPrice > 0
          ? round(((limitPrice - quotePrice(quote)) / quotePrice(quote)) * 100, 4)
          : undefined,
    });
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
    const draft = await LiveOrderDraft.create({
      user_id,
      account_id: accountId,
      symbol,
      name,
      side,
      order_type: 'LIMIT',
      quantity,
      limit_price: limitPrice,
      estimated_amount: riskCheck.estimated_amount,
      status: riskCheck.allowed ? 'pending' : 'blocked',
      source_type: input.source_type || 'manual_live_draft',
      source_id: input.source_id,
      rationale: input.rationale || '用户手动创建实盘订单草稿，等待强确认。',
      risk_level: riskCheck.risk_level,
      risk_check: riskCheck,
      quote_snapshot: quote || {},
      confirm_text_required: LIVE_ORDER_CONFIRM_TEXT,
      expires_at: expiresAt,
      metadata: {
        created_from: 'live_trading_page',
        ...(input.metadata || {}),
        safety_status: liveTradingSafetyService.getStatus(),
      },
    } as any);

    await this.audit({
      user_id,
      account_id: accountId,
      draft_id: Number(draft.id),
      event_type: 'live_order_draft_created',
      severity: riskCheck.allowed ? 'info' : 'warning',
      message: riskCheck.allowed ? '实盘订单草稿已创建，等待用户确认。' : '实盘订单草稿被基础风控阻断。',
      after_state: this.toPlain(draft),
      metadata: { risk_check: riskCheck },
    });

    return this.toPlain(draft);
  }

  async rejectDraft(user_id: number, draft_id: number, reason?: string) {
    const draft = await LiveOrderDraft.findOne({ where: { id: draft_id, user_id } });
    if (!draft) throw new Error('订单草稿不存在或无权限');
    const before = this.toPlain(draft);
    await draft.update({ status: 'rejected', rejected_at: new Date(), metadata: { ...(draft as any).metadata, reject_reason: reason || '' } });
    await this.audit({
      user_id,
      account_id: (draft as any).account_id,
      draft_id,
      event_type: 'live_order_draft_rejected',
      severity: 'info',
      message: '用户已拒绝实盘订单草稿。',
      before_state: before,
      after_state: this.toPlain(draft),
      metadata: { reason },
    });
    return this.toPlain(draft);
  }

  async markDraftShadowExecuted(user_id: number, draft_id: number, input: any = {}) {
    const draft = await LiveOrderDraft.findOne({ where: { id: draft_id, user_id } });
    if (!draft) throw new Error('订单草稿不存在或无权限');
    if (!['pending', 'preview'].includes(String((draft as any).status))) {
      throw new Error(`当前订单草稿状态为 ${(draft as any).status}，不可影子执行。`);
    }
    const before = this.toPlain(draft);
    const riskAllowed = Boolean((draft as any).risk_check?.allowed);
    if (!riskAllowed) throw new Error('订单草稿未通过基础风控，禁止影子执行。');
    const recheck = await this.recheckDraft(user_id, draft);
    const shadowFillPrice =
      quotePrice(recheck.quote_snapshot) || toNumber((draft as any).limit_price);
    const shadowAmount = round(shadowFillPrice * Number((draft as any).quantity), 2);
    const shadowExecution = {
      mode: 'shadow_only',
      source: input.source || 'manual_shadow_execution',
      executed_at: new Date().toISOString(),
      fill_price: shadowFillPrice,
      quantity: Number((draft as any).quantity),
      amount: shadowAmount,
      real_order_submitted: false,
      conclusion: '已记录影子成交；未提交真实券商委托。',
    };

    await draft.update({
      status: 'shadow_executed',
      risk_check: recheck.risk_check,
      quote_snapshot: recheck.quote_snapshot || {},
      estimated_amount: shadowAmount,
      metadata: {
        ...((draft as any).metadata || {}),
        shadow_execution: shadowExecution,
        pre_shadow_recheck_at: new Date().toISOString(),
        pre_shadow_recheck_conclusion: recheck.risk_check.conclusion,
      },
    });

    await this.audit({
      user_id,
      account_id: (draft as any).account_id,
      draft_id,
      event_type: 'live_order_shadow_executed',
      severity: 'warning',
      message: '无人确认影子执行已记录；真实券商委托提交数为 0。',
      before_state: before,
      after_state: this.toPlain(draft),
      metadata: {
        shadow_execution: shadowExecution,
        risk_check: recheck.risk_check,
        unattended_real_order_allowed: false,
      },
    });

    return this.toPlain(draft);
  }

  async approveDraft(user_id: number, draft_id: number, input: any) {
    if (input?.skip_confirmation === true || input?.unattended === true) {
      await this.audit({
        user_id,
        draft_id,
        event_type: 'live_order_unattended_real_submit_blocked',
        severity: 'critical',
        message: '拒绝无人确认真实下单请求；可改用影子执行闭环。',
        metadata: { input },
      });
      throw new Error('真实券商委托不能跳过人工确认；如需无人闭环，请使用影子执行。');
    }
    const draft = await LiveOrderDraft.findOne({ where: { id: draft_id, user_id } });
    if (!draft) throw new Error('订单草稿不存在或无权限');
    const before = this.toPlain(draft);
    if (!['pending', 'preview'].includes(String((draft as any).status))) {
      throw new Error(`当前订单草稿状态为 ${(draft as any).status}，不可确认提交。`);
    }
    const riskAllowed = Boolean((draft as any).risk_check?.allowed);
    if (!riskAllowed) throw new Error('订单草稿未通过基础风控，禁止确认提交。');

    const recheck = await this.recheckDraft(user_id, draft);
    await draft.update({
      risk_check: recheck.risk_check,
      quote_snapshot: recheck.quote_snapshot || {},
      estimated_amount: recheck.risk_check.estimated_amount,
      metadata: {
        ...((draft as any).metadata || {}),
        pre_submit_recheck_at: new Date().toISOString(),
        pre_submit_recheck_conclusion: recheck.risk_check.conclusion,
      },
    });
    if (!recheck.risk_check.allowed) {
      await this.audit({
        user_id,
        account_id: (draft as any).account_id,
        draft_id,
        event_type: 'live_order_pre_submit_recheck_blocked',
        severity: 'warning',
        message: '实盘订单提交前二次行情/账户风控复核未通过。',
        before_state: before,
        after_state: this.toPlain(draft),
        metadata: { risk_check: recheck.risk_check },
      });
      throw new Error(`提交前二次复核未通过：${recheck.risk_check.conclusion}`);
    }

    liveTradingSafetyService.assertOrderExecutionAllowed(input.confirm_text);

    await draft.update({ status: 'approved', approved_by: user_id, approved_at: new Date() });
    await this.audit({
      user_id,
      account_id: (draft as any).account_id,
      draft_id,
      event_type: 'live_order_draft_approved',
      severity: 'warning',
      message: '用户强确认实盘订单草稿，准备提交券商。',
      before_state: before,
      after_state: this.toPlain(draft),
      metadata: { confirm_text_matched: input.confirm_text === LIVE_ORDER_CONFIRM_TEXT },
    });

    return this.submitApprovedDraft(user_id, draft);
  }

  private async submitApprovedDraft(user_id: number, draft: LiveOrderDraft) {
    const result = await this.brokerGateway.placeOrder({
      symbol: (draft as any).symbol,
      side: (draft as any).side,
      quantity: Number((draft as any).quantity),
      limit_price: Number((draft as any).limit_price),
      order_type: (draft as any).order_type || 'LIMIT',
      client_order_id: `live-draft-${draft.id}`,
    });
    const order = await LiveOrder.create({
      user_id,
      account_id: (draft as any).account_id,
      draft_id: Number(draft.id),
      broker_order_id: result.broker_order_id,
      symbol: (draft as any).symbol,
      name: (draft as any).name,
      side: (draft as any).side,
      quantity: Number((draft as any).quantity),
      limit_price: Number((draft as any).limit_price),
      status: result.status,
      submitted_at: new Date(),
      raw_payload: result.raw_payload || {},
    } as any);
    await draft.update({ status: 'submitted' });
    await this.audit({
      user_id,
      account_id: (draft as any).account_id,
      draft_id: Number(draft.id),
      order_id: Number(order.id),
      event_type: 'live_order_submitted',
      severity: 'warning',
      message: '实盘订单已提交券商。',
      after_state: this.toPlain(order),
    });
    return { draft: this.toPlain(draft), order: this.toPlain(order) };
  }

  async syncReadonlyAccount(user_id: number, input: any = {}) {
    const safety = liveTradingSafetyService.getStatus();
    if (!safety.can_sync_account) {
      throw new Error('实盘只读同步未启用：请先设置 LIVE_READONLY_ENABLED=true，并配置真实券商只读网关。');
    }
    const account = await this.ensureAccount(user_id, input);
    const snapshot = await this.brokerGateway.getAccountSnapshot();
    const row = await LiveAccountSnapshot.create({
      user_id,
      account_id: Number(account.id),
      total_asset: snapshot.total_asset,
      available_cash: snapshot.available_cash,
      market_value: snapshot.market_value,
      frozen_cash: snapshot.frozen_cash || 0,
      total_pnl: snapshot.total_pnl || 0,
      day_pnl: snapshot.day_pnl || 0,
      snapshot_time: snapshot.snapshot_time,
      source: this.brokerGateway.getCapabilities().broker_key,
      raw_payload: snapshot.raw_payload || {},
    } as any);
    const positions = await this.brokerGateway.getPositions();
    for (const position of positions) {
      const marketValue = toNumber(position.market_value);
      await LivePosition.upsert({
        user_id,
        account_id: Number(account.id),
        symbol: normalizeSymbol(position.symbol),
        name: position.name,
        quantity: position.quantity,
        available_quantity: position.available_quantity,
        avg_cost: position.avg_cost,
        current_price: position.current_price,
        market_value: marketValue,
        unrealized_pnl: position.unrealized_pnl,
        unrealized_pnl_pct: position.unrealized_pnl_pct,
        position_pct: snapshot.total_asset > 0 ? round((marketValue / snapshot.total_asset) * 100, 4) : 0,
        quote_time: position.quote_time,
        source: this.brokerGateway.getCapabilities().broker_key,
        raw_payload: position.raw_payload || {},
      } as any);
    }
    await account.update({ last_sync_at: new Date(), readonly_enabled: true, connection_status: 'readonly_synced' });
    await this.audit({
      user_id,
      account_id: Number(account.id),
      event_type: 'live_account_readonly_synced',
      severity: 'info',
      message: '实盘账户只读快照已同步。',
      after_state: this.toPlain(row),
      metadata: { position_count: positions.length },
    });
    return { account: this.toPlain(account), snapshot: this.toPlain(row), position_count: positions.length };
  }

  async getAuditLogs(user_id: number, limit = 50) {
    const rows = await LiveExecutionAuditLog.findAll({
      where: { user_id },
      order: [['created_at', 'DESC']],
      limit: Math.min(Math.max(Number(limit || 50), 1), 200),
    });
    return rows.map(item => this.toPlain(item));
  }

  async getQuotes(symbols: string[]) {
    return this.quoteProvider.getQuotes(symbols);
  }

  private async pickHealthSymbols() {
    const stocks = await Stock.findAll({
      where: { is_listed: true },
      order: [['updated_at', 'DESC']],
      limit: 12,
    });
    const symbols = stocks.map((stock: any) => normalizeSymbol(stock.symbol)).filter(Boolean);
    return symbols.length ? symbols : ['000001.SH', '399001.SZ', '600519.SH', '000858.SZ'];
  }

  private async recheckDraft(user_id: number, draft: LiveOrderDraft) {
    const symbol = normalizeSymbol((draft as any).symbol);
    const quote = await this.quoteProvider.getQuote(symbol);
    const overview = await this.getOverview(user_id);
    const position = overview.positions.find((item: any) => normalizeSymbol(item.symbol) === symbol);
    const latestPrice = quotePrice(quote);
    const limitPrice = toNumber((draft as any).limit_price);
    const riskCheck = liveRiskGuardService.evaluate({
      side: (draft as any).side,
      symbol,
      name: (draft as any).name,
      quantity: Number((draft as any).quantity),
      limit_price: limitPrice,
      total_asset: overview.summary.total_asset,
      available_cash: overview.summary.available_cash,
      current_position_value: toNumber(position?.market_value),
      total_exposure_pct: overview.summary.exposure_pct,
      is_st: /ST|退/.test(String((draft as any).name || '')),
      quote_missing: !quote || !latestPrice,
      quote_latency_seconds: quoteLatency(quote),
      quote_is_realtime: quote?.is_realtime,
      quote_source: quote?.source,
      price_deviation_pct:
        latestPrice > 0 && limitPrice > 0
          ? round(((limitPrice - latestPrice) / latestPrice) * 100, 4)
          : undefined,
    });
    return { risk_check: riskCheck, quote_snapshot: quote };
  }

  private async ensureAccount(user_id: number, input: any = {}) {
    const [account] = await LiveBrokerAccount.findOrCreate({
      where: { user_id, broker_key: this.brokerGateway.getCapabilities().broker_key },
      defaults: {
        user_id,
        broker_key: this.brokerGateway.getCapabilities().broker_key,
        broker_name: this.brokerGateway.getCapabilities().broker_name,
        account_alias: input.account_alias || '实盘只读账户',
        account_no_masked: maskAccountNo(input.account_no),
        permission_scope: 'read_only',
        connection_status: 'created',
        is_active: true,
        readonly_enabled: false,
        trading_enabled: false,
        risk_config: liveTradingSafetyService.getDefaultRiskLimits(),
        metadata: { created_by: 'live_trading_service' },
      } as any,
    });
    return account;
  }

  private async getPaperAccountReconciliationRows(user_id: number) {
    const portfolios = await PaperTradingPortfolio.findAll({
      where: {
        user_id,
        name: { [Op.in]: PAPER_PORTFOLIO_FAMILIES.map(item => item.name) },
      },
      order: [['id', 'ASC']],
      limit: 50,
    });
    const latestByName = new Map<string, PaperTradingPortfolio>();
    for (const portfolio of portfolios) {
      latestByName.set((portfolio as any).name, portfolio);
    }

    const rows = await Promise.all(
      PAPER_PORTFOLIO_FAMILIES.map(async family => {
        const portfolio = latestByName.get(family.name);
        if (!portfolio) {
          return {
            key: family.key,
            label: family.label,
            name: family.name,
            description: family.description,
            exists: false,
            portfolio_id: null,
            total_value: 0,
            current_cash: 0,
            position_value: 0,
            exposure_pct: 0,
            total_return_pct: 0,
            open_position_count: 0,
            latest_trade_at: null,
            positions: [] as any[],
          };
        }
        const [positions, latestTrade] = await Promise.all([
          PaperTradingPosition.findAll({
            where: { portfolio_id: portfolio.id, quantity: { [Op.gt]: 0 } },
            order: [['market_value', 'DESC']],
            limit: 100,
          }),
          PaperTradingTrade.findOne({
            where: { portfolio_id: portfolio.id },
            order: [['created_at', 'DESC']],
          }),
        ]);
        const positionRows = positions.map((item: any) => this.toPlain(item));
        const positionValue = positionRows.reduce(
          (sum, item) => sum + toNumber(item.market_value),
          0
        );
        const totalValue = toNumber((portfolio as any).total_value);
        const initialCapital = toNumber((portfolio as any).initial_capital);
        return {
          key: family.key,
          label: family.label,
          name: family.name,
          description: family.description,
          exists: true,
          portfolio_id: Number(portfolio.id),
          total_value: round(totalValue),
          current_cash: round((portfolio as any).current_cash),
          position_value: round(positionValue),
          exposure_pct: totalValue > 0 ? round((positionValue / totalValue) * 100, 4) : 0,
          total_return_pct:
            initialCapital > 0 ? round(((totalValue - initialCapital) / initialCapital) * 100, 4) : 0,
          open_position_count: positionRows.length,
          latest_trade_at: (latestTrade as any)?.created_at || null,
          positions: positionRows.map(position => ({
            symbol: normalizeSymbol(position.symbol),
            name: position.name || position.symbol,
            quantity: toNumber(position.quantity),
            avg_cost: toNumber(position.avg_cost),
            current_price: toNumber(position.current_price),
            market_value: round(position.market_value),
            unrealized_pnl: round(position.unrealized_pnl),
          })),
        };
      })
    );

    return rows;
  }

  private buildReconciliationConclusion(input: {
    status: string;
    alignment_score: number;
    live_only_count: number;
    paper_only_count: number;
    snapshot_age_minutes: number | null;
  }) {
    if (input.status === 'not_bound') {
      return '尚未接入券商只读账户；现在只能把模拟盘建议沉淀为订单草稿，不能做真实账户对账。';
    }
    if (input.status === 'no_snapshot') {
      return '券商账户已创建但还没有只读快照；请先完成只读同步再评估实盘与模拟盘差异。';
    }
    if (input.status === 'stale') {
      return `券商快照已超过 ${input.snapshot_age_minutes ?? '-'} 分钟未更新；不要用该快照做实盘决策。`;
    }
    if (input.status === 'aligned') {
      return `实盘与模拟策略账户整体接近，对齐分 ${input.alignment_score}；仍需逐笔人工确认。`;
    }
    return `实盘与模拟建议存在偏离：仅实盘 ${input.live_only_count} 只、仅模拟 ${input.paper_only_count} 只，对齐分 ${input.alignment_score}。`;
  }

  private buildReconciliationSuggestions(input: {
    status: string;
    snapshot_age_minutes: number | null;
    stale_threshold_minutes: number;
    live_only_count: number;
    paper_only_count: number;
    live_market_value: number;
    paper_market_value: number;
    alignment_score: number;
  }) {
    const suggestions: Array<{ level: string; title: string; detail: string }> = [];
    if (input.status === 'not_bound') {
      suggestions.push({
        level: 'warning',
        title: '先接只读账户',
        detail: '配置真实券商只读网关后再启用对账；默认 Mock/EnvReadonly 不会真实下单。',
      });
    }
    if (input.status === 'no_snapshot' || input.status === 'stale') {
      suggestions.push({
        level: 'warning',
        title: '刷新券商快照',
        detail: `快照有效期建议控制在 ${input.stale_threshold_minutes} 分钟内，过期快照不应用于实盘确认。`,
      });
    }
    if (input.paper_only_count > 0) {
      suggestions.push({
        level: 'info',
        title: '模拟建议未落地',
        detail: `有 ${input.paper_only_count} 只股票只出现在模拟策略账户，可作为候选订单草稿，但必须重新过行情 SLA 与风控。`,
      });
    }
    if (input.live_only_count > 0) {
      suggestions.push({
        level: 'warning',
        title: '实盘孤儿持仓',
        detail: `有 ${input.live_only_count} 只股票没有对应模拟策略建议，建议复核买入来源、止损线和退出计划。`,
      });
    }
    if (input.live_market_value > 0 && input.paper_market_value === 0) {
      suggestions.push({
        level: 'warning',
        title: '模拟盘未覆盖当前实盘暴露',
        detail: '真实持仓未被策略账户覆盖，系统无法用历史策略收益解释当前仓位。请补齐归因或降低仓位。',
      });
    }
    if (input.alignment_score < 55 && input.paper_market_value > 0) {
      suggestions.push({
        level: 'warning',
        title: '偏离过大',
        detail: '真实账户与策略建议偏离较大，不建议直接放大策略仓位，应先做小仓验证和人工复核。',
      });
    }
    if (!suggestions.length) {
      suggestions.push({
        level: 'success',
        title: '保持人工确认',
        detail: '当前对账没有明显红线；后续每个订单仍必须走强确认、二次行情复核和审计。',
      });
    }
    return suggestions;
  }

  private buildCandidateRationale(candidate: any, quote: any) {
    const accounts = (candidate.paper_accounts || [])
      .slice(0, 2)
      .map((item: any) => item.label)
      .join('、');
    const quoteText = quotePrice(quote) > 0 ? `当前参考价 ¥${round(quotePrice(quote), 2)}` : '暂无可用参考价';
    if (candidate.status === 'paper_only') {
      return `策略模拟账户持有 ${candidate.name || candidate.symbol}，但实盘暂无对应仓位；来源账户：${
        accounts || '策略模拟盘'
      }，${quoteText}。`;
    }
    return `实盘仓位低于策略模拟目标，权重差 ${round(candidate.weight_gap_pct, 2)}%；来源账户：${
      accounts || '策略模拟盘'
    }，${quoteText}。`;
  }

  private async buildShadowOutcomeItem(draft: any, horizons: number[]) {
    const metadata = draft.metadata || {};
    const shadowExecution = metadata.shadow_execution || {};
    const symbol = normalizeSymbol(draft.symbol);
    const stock = await Stock.findOne({
      where: { symbol: { [Op.in]: [symbol, symbol.replace('.', '')] } },
    });
    const entryPrice =
      priceOrNull(shadowExecution.fill_price) ||
      priceOrNull(draft.limit_price) ||
      priceOrNull(draft.quote_snapshot?.current_price);
    const entryTime = shadowExecution.executed_at || draft.updated_at || draft.created_at;
    const entryDate = startOfLocalDay(entryTime);
    const latestQuote = await RealtimeQuote.findOne({
      where: { symbol },
      order: [['quote_time', 'DESC']],
      raw: true,
    });
    const latestDailyBar = stock?.id
      ? await DailyBar.findOne({
          where: { stock_id: stock.id },
          order: [['time', 'DESC']],
          raw: true,
        })
      : null;
    const quotePriceValue = priceOrNull((latestQuote as any)?.current_price);
    const barCloseValue = priceOrNull((latestDailyBar as any)?.close);
    const latestPrice = quotePriceValue || barCloseValue || null;
    const latestPriceTime = quotePriceValue
      ? (latestQuote as any)?.quote_time
      : (latestDailyBar as any)?.time;
    const quantity = toNumber(shadowExecution.quantity || draft.quantity);
    const shadowAmount = round(toNumber(shadowExecution.amount) || (entryPrice || 0) * quantity, 2);
    const latestReturnPct =
      entryPrice && latestPrice ? round(((latestPrice - entryPrice) / entryPrice) * 100, 4) : null;
    const latestPnl =
      entryPrice && latestPrice && quantity ? round((latestPrice - entryPrice) * quantity, 2) : null;
    const barsAfterEntry = stock?.id
      ? await DailyBar.findAll({
          where: {
            stock_id: stock.id,
            time: { [Op.gte]: entryDate },
          },
          order: [['time', 'ASC']],
          limit: Math.max(...horizons) + 8,
          raw: true,
        })
      : [];
    const normalizedBars = (barsAfterEntry as any[]).filter(
      bar => priceOrNull(bar.close) && localDateKey(bar.time) >= localDateKey(entryDate)
    );
    const horizonReturns: Record<string, any> = {};
    for (const horizon of horizons) {
      const targetBar = normalizedBars[horizon] || null;
      const targetPrice = priceOrNull(targetBar?.close);
      const returnPct =
        entryPrice && targetPrice ? round(((targetPrice - entryPrice) / entryPrice) * 100, 4) : null;
      horizonReturns[`${horizon}d`] = {
        horizon_days: horizon,
        target_date: targetBar?.time ? localDateKey(targetBar.time) : null,
        price: targetPrice,
        return_pct: returnPct,
        pnl: entryPrice && targetPrice && quantity ? round((targetPrice - entryPrice) * quantity, 2) : null,
        evaluable: returnPct !== null,
      };
    }
    const firstHorizonKey = `${horizons[0] || 1}d`;
    const firstHorizonEvaluable = Boolean(horizonReturns[firstHorizonKey]?.evaluable);
    const latestEvaluable = latestReturnPct !== null;
    const evaluable = latestEvaluable || firstHorizonEvaluable;
    const outcomeStatus = !entryPrice
      ? 'missing_entry_price'
      : !latestPrice && !firstHorizonEvaluable
      ? 'waiting_market_data'
      : evaluable
      ? 'evaluated'
      : 'open';

    return {
      id: draft.id,
      symbol,
      name: draft.name || (stock as any)?.name || symbol,
      side: draft.side,
      quantity,
      entry_price: entryPrice,
      shadow_amount: shadowAmount,
      entry_time: entryTime,
      entry_date: localDateKey(entryTime),
      latest_price: latestPrice,
      latest_price_time: latestPriceTime || null,
      latest_return_pct: latestReturnPct,
      latest_pnl: latestPnl,
      horizon_returns: horizonReturns,
      evaluable,
      outcome_status: outcomeStatus,
      status_label:
        outcomeStatus === 'evaluated'
          ? '已评估'
          : outcomeStatus === 'waiting_market_data'
          ? '等行情'
          : outcomeStatus === 'missing_entry_price'
          ? '缺成交价'
          : '观察中',
      win: latestReturnPct !== null ? latestReturnPct > 0 : null,
      source_id: draft.source_id,
      rationale: draft.rationale,
      real_order_submitted: false,
    };
  }

  private buildShadowOutcomeConclusion(input: {
    total_count: number;
    evaluated_count: number;
    avg_latest_return_pct: number | null;
    win_rate_pct: number | null;
    baseline?: any;
  }) {
    if (input.total_count === 0) {
      return '暂无无人影子成交样本；先运行影子执行，系统会记录假设成交但不会提交真实订单。';
    }
    const baseline = input.baseline || {};
    const paperAvg = numberOrNull(baseline.paper_trading?.avg_latest_return_pct);
    const excessText =
      paperAvg !== null && input.avg_latest_return_pct !== null
        ? `，相对模拟盘均收 ${round(input.avg_latest_return_pct - paperAvg, 2)}pct`
        : '';
    if (input.evaluated_count < 5) {
      return `已评估 ${input.evaluated_count}/${input.total_count} 条影子样本，样本仍少，先继续积累，不应放大到真实资金自动执行。`;
    }
    const avg = Number(input.avg_latest_return_pct || 0);
    const winRate = Number(input.win_rate_pct || 0);
    if (avg > 0 && winRate >= 50) {
      return `影子执行初步有效：平均收益 ${round(avg, 2)}%，胜率 ${round(winRate, 1)}%${excessText}；下一步继续扩大影子样本并比较基准。`;
    }
    if (avg < 0) {
      return `影子执行暂未证明有效：平均收益 ${round(avg, 2)}%，胜率 ${round(winRate, 1)}%${excessText}；保持真实下单阻断，优先复盘策略来源。`;
    }
    return `影子执行收益接近持平：平均收益 ${round(avg, 2)}%，胜率 ${round(winRate, 1)}%${excessText}；继续观察 1/3/5 日收益。`;
  }

  private buildShadowBudgetDecision(input: {
    total_count: number;
    evaluated_count: number;
    avg_latest_return_pct: number | null;
    win_rate_pct: number | null;
    baseline?: any;
  }) {
    const avg = numberOrNull(input.avg_latest_return_pct);
    const winRate = numberOrNull(input.win_rate_pct);
    const paperAvg = numberOrNull(input.baseline?.paper_trading?.avg_latest_return_pct);
    const excessPct = avg !== null && paperAvg !== null ? round(avg - paperAvg, 4) : null;
    if (input.total_count === 0 || input.evaluated_count < 5) {
      return {
        action: 'continue_collecting',
        label: '继续影子验证',
        level: 'watch',
        recommended_limit: 2,
        reason: `可评估样本 ${input.evaluated_count}/${Math.max(input.total_count, 1)}，还不足以判断有效性。`,
      };
    }
    if ((avg !== null && avg < -1.5) || (winRate !== null && winRate < 35)) {
      return {
        action: 'cool_down',
        label: '降低影子预算',
        level: 'risk',
        recommended_limit: 1,
        reason: `影子收益偏弱：平均 ${avg !== null ? round(avg, 2) : '--'}%，胜率 ${
          winRate !== null ? round(winRate, 1) : '--'
        }%，先减少新增样本并复盘来源。`,
      };
    }
    if (
      avg !== null &&
      winRate !== null &&
      avg > 0.8 &&
      winRate >= 55 &&
      (excessPct === null || excessPct >= 0)
    ) {
      return {
        action: 'expand_shadow',
        label: '可小幅扩大',
        level: 'ok',
        recommended_limit: 3,
        reason: `影子样本初步跑赢：平均 ${round(avg, 2)}%，胜率 ${round(
          winRate,
          1
        )}%${excessPct !== null ? `，相对模拟盘 ${round(excessPct, 2)}pct` : ''}。`,
      };
    }
    return {
      action: 'continue_shadow',
      label: '继续小流量',
      level: 'watch',
      recommended_limit: 2,
      reason: `结果未到扩大阈值：平均 ${avg !== null ? round(avg, 2) : '--'}%，胜率 ${
        winRate !== null ? round(winRate, 1) : '--'
      }%。`,
    };
  }

  private async getShadowOutcomeBaseline(
    user_id: number,
    options: { since?: string | Date; limit?: number } = {}
  ) {
    const since = options.since ? new Date(options.since) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const limit = Math.min(Math.max(Number(options.limit || 500), 1), 2000);
    const portfolios = await PaperTradingPortfolio.findAll({
      where: {
        user_id,
        name: { [Op.in]: PAPER_PORTFOLIO_FAMILIES.map(item => item.name) },
      },
      order: [['id', 'ASC']],
      limit: 50,
      raw: true,
    });
    const portfolioIds = portfolios.map((item: any) => Number(item.id)).filter(Boolean);
    const buyTrades = portfolioIds.length
      ? await PaperTradingTrade.findAll({
          where: {
            portfolio_id: { [Op.in]: portfolioIds },
            direction: 'BUY',
            created_at: { [Op.gte]: Number.isFinite(since.getTime()) ? since : new Date(0) },
          },
          order: [['created_at', 'DESC']],
          limit,
          raw: true,
        })
      : [];
    const paperItems = await Promise.all(
      (buyTrades as any[]).map(async trade => {
        const latestPrice = await this.getLatestComparablePrice(normalizeSymbol(trade.symbol));
        const entryPrice = priceOrNull(trade.execute_price);
        const quantity = toNumber(trade.quantity);
        const returnPct =
          entryPrice && latestPrice?.price
            ? round(((latestPrice.price - entryPrice) / entryPrice) * 100, 4)
            : null;
        return {
          symbol: normalizeSymbol(trade.symbol),
          name: trade.name,
          portfolio_id: Number(trade.portfolio_id),
          entry_price: entryPrice,
          latest_price: latestPrice?.price || null,
          return_pct: returnPct,
          pnl: entryPrice && latestPrice?.price && quantity ? round((latestPrice.price - entryPrice) * quantity, 2) : null,
          entry_time: trade.created_at,
        };
      })
    );
    const evaluatedPaper = paperItems.filter(item => item.return_pct !== null);
    const paperWinCount = evaluatedPaper.filter(item => Number(item.return_pct || 0) > 0).length;

    const signals = await AIInvestmentSignal.findAll({
      where: {
        updated_at: { [Op.gte]: Number.isFinite(since.getTime()) ? since : new Date(0) },
        verification_status: { [Op.in]: ['partial', 'completed'] },
      },
      order: [['updated_at', 'DESC']],
      limit,
      raw: true,
    }).catch(() => []);
    const signalReturns = (signals as any[])
      .map(signal => {
        const forward = asPlainObject(signal.forward_returns);
        const preferred =
          numberOrNull(forward['5d']?.return_pct) ??
          numberOrNull(forward['3d']?.return_pct) ??
          numberOrNull(forward['1d']?.return_pct);
        return preferred;
      })
      .filter((value): value is number => value !== null);
    const signalWinCount = signalReturns.filter(value => value > 0).length;

    return {
      since: localDateKey(since),
      paper_trading: {
        sample_count: paperItems.length,
        evaluated_count: evaluatedPaper.length,
        avg_latest_return_pct: evaluatedPaper.length
          ? round(
              evaluatedPaper.reduce((sum, item) => sum + Number(item.return_pct || 0), 0) /
                evaluatedPaper.length,
              4
            )
          : null,
        win_rate_pct: evaluatedPaper.length ? round((paperWinCount / evaluatedPaper.length) * 100, 2) : null,
        total_pnl: round(evaluatedPaper.reduce((sum, item) => sum + toNumber(item.pnl), 0), 2),
      },
      signal_forward_returns: {
        sample_count: signalReturns.length,
        avg_return_pct: signalReturns.length
          ? round(signalReturns.reduce((sum, value) => sum + value, 0) / signalReturns.length, 4)
          : null,
        win_rate_pct: signalReturns.length ? round((signalWinCount / signalReturns.length) * 100, 2) : null,
      },
    };
  }

  private async getLatestComparablePrice(symbol: string): Promise<{ price: number; time?: any } | null> {
    const normalized = normalizeSymbol(symbol);
    const quote = await RealtimeQuote.findOne({
      where: { symbol: normalized },
      order: [['quote_time', 'DESC']],
      raw: true,
    }).catch(() => null);
    const quotePx = priceOrNull((quote as any)?.current_price);
    if (quotePx) return { price: quotePx, time: (quote as any)?.quote_time };
    const stock = await Stock.findOne({
      where: { symbol: { [Op.in]: [normalized, normalized.replace('.', '')] } },
      raw: true,
    }).catch(() => null);
    const bar = (stock as any)?.id
      ? await DailyBar.findOne({
          where: { stock_id: (stock as any).id },
          order: [['time', 'DESC']],
          raw: true,
        }).catch(() => null)
      : null;
    const barPx = priceOrNull((bar as any)?.close);
    return barPx ? { price: barPx, time: (bar as any)?.time } : null;
  }

  private async audit(input: {
    user_id?: number;
    account_id?: number;
    draft_id?: number;
    order_id?: number;
    event_type: string;
    severity?: string;
    message: string;
    before_state?: Record<string, any>;
    after_state?: Record<string, any>;
    metadata?: Record<string, any>;
  }) {
    return LiveExecutionAuditLog.create({
      user_id: input.user_id,
      account_id: input.account_id,
      draft_id: input.draft_id,
      order_id: input.order_id,
      event_type: input.event_type,
      severity: input.severity || 'info',
      message: input.message,
      before_state: input.before_state || {},
      after_state: input.after_state || {},
      metadata: input.metadata || {},
    } as any);
  }

  private toPlain(record: any) {
    if (!record) return record;
    return typeof record.toJSON === 'function' ? record.toJSON() : record;
  }
}

export const liveTradingService = new LiveTradingService();
