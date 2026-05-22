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
import { MockBrokerGateway } from '../brokers/MockBrokerGateway';
import { EnvReadonlyBrokerGateway } from '../brokers/EnvReadonlyBrokerGateway';
import { BrokerGateway } from '../brokers/BrokerGateway';
import { DatabaseQuoteProvider } from '../market-data/DatabaseQuoteProvider';
import { ConfiguredQuoteProvider } from '../market-data/ConfiguredQuoteProvider';
import { LiveMarketDataProvider } from '../market-data/LiveMarketDataProvider';
import { liveRiskGuardService } from './LiveRiskGuardService';
import { LIVE_ORDER_CONFIRM_TEXT, liveTradingSafetyService } from './LiveTradingSafetyService';
import { PAPER_PORTFOLIO_FAMILIES } from '../../services/PaperTradingPortfolioFamilies';

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
    const reconciliation = await this.getReconciliation(user_id);
    const openDrafts = drafts.filter(item => ['preview', 'pending', 'blocked'].includes(String((item as any).status)));
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
      reconciliation,
      summary: {
        account_bound: Boolean(account),
        total_asset: totalAsset,
        available_cash: toNumber((latestSnapshot as any)?.available_cash),
        market_value: toNumber((latestSnapshot as any)?.market_value) || exposure,
        exposure_pct: exposurePct,
        position_count: positions.length,
        pending_draft_count: openDrafts.length,
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
            ? `发现 ${eligibleCount} 个可生成实盘草稿的策略候选；生成后仍不会下单，必须人工确认。`
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

  async approveDraft(user_id: number, draft_id: number, input: any) {
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
