import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database';
import { AIInvestmentSignal } from '../../models/AIInvestmentSignal';
import { AiRecommendationItem } from '../../models/AiRecommendationItem';
import { AiRecommendationSnapshot } from '../../models/AiRecommendationSnapshot';
import { FeishuNotificationOutbox } from '../../models/FeishuNotificationOutbox';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingTrade } from '../../models/PaperTradingTrade';
import { RealtimeQuote } from '../../models/RealtimeQuote';
import { RecommendationTradeOutcome } from '../../models/RecommendationTradeOutcome';
import { RiskAlert } from '../../models/RiskAlert';
import { expectedCompletedTradeDate } from '../../services/PageFreshnessService';
import {
  countTradingDaysBetween,
  getShanghaiDate,
  isAShareTradeDay,
  latestTradeDateOnOrBefore,
} from '../../utils/tradingCalendar';
import { normalizeSymbol } from '../../utils/stockSymbol';

export type QuoteFreshness = 'live' | 'close' | 'delayed' | 'stale' | 'missing';
export type ResearchFreshness = 'fresh' | 'delayed' | 'missing';

export interface PortfolioLedgerTimelineItem {
  id: string;
  type: 'trade' | 'signal' | 'alert' | 'notification' | 'correction';
  title: string;
  detail: string | null;
  occurred_at: string;
  status: string | null;
  corrected: boolean;
  invalidated: boolean;
}

interface MultibaggerLedgerRow {
  snapshot_id: string;
  ticker: string;
  as_of_utc: Date | string;
  available_at_utc: Date | string;
  stage: string;
  conclusion: string;
  rating: string | null;
  strategy_version: string;
  research_day: string | null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function shanghaiMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find(part => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find(part => part.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function previousTradeDate(today: string): string {
  const previous = new Date(new Date(`${today}T00:00:00+08:00`).getTime() - 86_400_000);
  return latestTradeDateOnOrBefore(previous);
}

export function expectedQuoteTradeDate(now = new Date()): {
  trade_date: string;
  market_phase: 'pre_open' | 'trading' | 'lunch' | 'after_close' | 'non_trading';
} {
  const today = getShanghaiDate(now);
  if (!isAShareTradeDay(today)) {
    return { trade_date: latestTradeDateOnOrBefore(today), market_phase: 'non_trading' };
  }
  const minute = shanghaiMinutes(now);
  if (minute < 570) return { trade_date: previousTradeDate(today), market_phase: 'pre_open' };
  if (minute < 690) return { trade_date: today, market_phase: 'trading' };
  if (minute < 780) return { trade_date: today, market_phase: 'lunch' };
  if (minute < 900) return { trade_date: today, market_phase: 'trading' };
  return { trade_date: today, market_phase: 'after_close' };
}

export function classifyQuoteFreshness(
  quote_time: Date | string | null,
  trade_date: string | null,
  now = new Date()
): {
  freshness: QuoteFreshness;
  age_minutes: number | null;
  expected_trade_date: string;
  market_phase: string;
} {
  const expected = expectedQuoteTradeDate(now);
  if (!quote_time || !trade_date) {
    return {
      freshness: 'missing',
      age_minutes: null,
      expected_trade_date: expected.trade_date,
      market_phase: expected.market_phase,
    };
  }
  const parsed = quote_time instanceof Date ? quote_time : new Date(quote_time);
  if (Number.isNaN(parsed.getTime())) {
    return {
      freshness: 'missing',
      age_minutes: null,
      expected_trade_date: expected.trade_date,
      market_phase: expected.market_phase,
    };
  }
  const age = Math.max(0, Math.round((now.getTime() - parsed.getTime()) / 60_000));
  if (trade_date !== expected.trade_date) {
    return {
      expected_trade_date: expected.trade_date,
      market_phase: expected.market_phase,
      freshness: 'stale',
      age_minutes: age,
    };
  }
  if (expected.market_phase !== 'trading') {
    const quoteObservedDay = getShanghaiDate(parsed);
    const quoteMinute = shanghaiMinutes(parsed);
    const closeThreshold = expected.market_phase === 'lunch' ? 675 : 885;
    const reachedSessionClose =
      quoteObservedDay > trade_date ||
      (quoteObservedDay === trade_date && quoteMinute >= closeThreshold);
    if (!reachedSessionClose) {
      return {
        expected_trade_date: expected.trade_date,
        market_phase: expected.market_phase,
        freshness: age <= 120 ? 'delayed' : 'stale',
        age_minutes: age,
      };
    }
    return {
      expected_trade_date: expected.trade_date,
      market_phase: expected.market_phase,
      freshness: 'close',
      age_minutes: age,
    };
  }
  if (age <= 15) {
    return {
      expected_trade_date: expected.trade_date,
      market_phase: expected.market_phase,
      freshness: 'live',
      age_minutes: age,
    };
  }
  if (age <= 120) {
    return {
      expected_trade_date: expected.trade_date,
      market_phase: expected.market_phase,
      freshness: 'delayed',
      age_minutes: age,
    };
  }
  return {
    expected_trade_date: expected.trade_date,
    market_phase: expected.market_phase,
    freshness: 'stale',
    age_minutes: age,
  };
}

export function classifyResearchFreshness(
  research_day: string | null,
  expected_day: string
): { freshness: ResearchFreshness; lag_days: number | null; reason: string | null } {
  if (!research_day) return { freshness: 'missing', lag_days: null, reason: 'snapshot_missing' };
  if (research_day > expected_day) {
    return { freshness: 'delayed', lag_days: null, reason: 'snapshot_from_future' };
  }
  const lag = countTradingDaysBetween(research_day, expected_day);
  return lag === 0
    ? { freshness: 'fresh', lag_days: 0, reason: null }
    : { freshness: 'delayed', lag_days: lag, reason: 'snapshot_stale' };
}

function recordTouchesPortfolio(value: unknown, portfolio_id: number): boolean {
  if (Array.isArray(value)) return value.some(item => recordTouchesPortfolio(item, portfolio_id));
  const row = objectValue(value);
  if (!Object.keys(row).length) return false;
  if (Number(row.portfolio_id) === portfolio_id) return true;
  if (Number(objectValue(row.portfolio).id) === portfolio_id) return true;
  return Object.values(row).some(item => recordTouchesPortfolio(item, portfolio_id));
}

function recordTouchesSymbol(value: unknown, symbol: string): boolean {
  if (Array.isArray(value)) return value.some(item => recordTouchesSymbol(item, symbol));
  const row = objectValue(value);
  if (!Object.keys(row).length) return false;
  if (typeof row.symbol === 'string' && normalizeSymbol(row.symbol) === symbol) return true;
  return Object.values(row).some(item => recordTouchesSymbol(item, symbol));
}

export function correctionTouchesPosition(
  row: Record<string, any>,
  portfolio_id: number,
  symbol: string
): boolean {
  const state = {
    entity_id: row.entity_id,
    before_state: row.before_state,
    after_state: row.after_state,
  };
  return recordTouchesPortfolio(state, portfolio_id) && recordTouchesSymbol(state, symbol);
}

export function sortLedgerTimeline(
  items: PortfolioLedgerTimelineItem[]
): PortfolioLedgerTimelineItem[] {
  return [...items].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
  );
}

function normalizedPortfolioId(metadata: unknown): number | null {
  const row = objectValue(metadata);
  const direct = numberOrNull(row.portfolio_id);
  return direct && direct > 0 ? direct : null;
}

function tradeOrigin(trade: PaperTradingTrade | undefined) {
  if (!trade) return null;
  const reason = objectValue(trade.trade_reason);
  const source = String(reason.source || '').trim();
  if (!source || source === 'unknown') return null;
  return {
    trade_id: trade.id,
    source,
    strategy_key: reason.strategy_key || null,
    summary: trade.trade_reason_summary || null,
  };
}

function mapAlert(row: RiskAlert) {
  return {
    id: row.id,
    symbol: row.symbol,
    level: row.level,
    rule_id: row.rule_id,
    message: row.message,
    is_read: row.is_read,
    metadata: row.metadata || {},
    created_at: iso(row.created_at),
  };
}

function mapNotification(row: FeishuNotificationOutbox) {
  const metadata = objectValue(row.metadata);
  return {
    id: Number(row.id),
    title: row.title,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    corrected: Boolean(metadata.corrected),
    invalidated: Boolean(metadata.invalidated),
    correction_id: numberOrNull(metadata.correction_id),
    metadata,
    created_at: iso(row.created_at),
    sent_at: iso(row.sent_at),
  };
}

function mapCorrection(row: Record<string, any>) {
  return {
    id: Number(row.id),
    correction_key: row.correction_key,
    correction_type: row.correction_type,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    reason: row.reason,
    created_at: iso(row.created_at),
  };
}

export class PortfolioLedgerService {
  async getForUser(user_id: number, portfolio_id: number, now = new Date()) {
    const portfolio = await PaperTradingPortfolio.findOne({ where: { id: portfolio_id, user_id } });
    if (!portfolio) {
      const error: any = new Error('未找到模拟盘或无权访问');
      error.statusCode = 404;
      error.code = 'PORTFOLIO_NOT_FOUND_OR_FORBIDDEN';
      throw error;
    }

    const expectedResearchDay = expectedCompletedTradeDate(now);
    const [
      positions,
      riskAlertRows,
      notificationRows,
      morningSnapshot,
      corrections,
      multibaggerRows,
    ] = await Promise.all([
      PaperTradingPosition.findAll({
        where: { portfolio_id, quantity: { [Op.gt]: 0 } },
        order: [['id', 'ASC']],
      }),
      RiskAlert.findAll({
        where: {
          user_id,
          metadata: { [Op.contains]: { portfolio_id } },
        },
        order: [['created_at', 'DESC']],
        limit: 500,
      }),
      FeishuNotificationOutbox.findAll({
        where: {
          [Op.or]: [
            { metadata: { [Op.contains]: { portfolio_id } } },
            {
              recipient_user_id: user_id,
              metadata: { [Op.contains]: { ledger_scope: 'account_correction' } },
            },
          ],
        },
        order: [['created_at', 'DESC']],
        limit: 300,
      }).catch(() => []),
      AiRecommendationSnapshot.findOne({
        where: {
          profile: 'us_preferred',
          marketScope: 'cn_a',
          asOfUtc: { [Op.lte]: now },
        },
        order: [
          ['asOfUtc', 'DESC'],
          ['createdAt', 'DESC'],
          ['snapshotId', 'DESC'],
        ],
      }).catch(() => null),
      this.loadCorrections(),
      this.loadLatestMultibaggerRows(now),
    ]);

    const symbols = [...new Set(positions.map(row => normalizeSymbol(row.symbol)).filter(Boolean))];
    const [trades, outcomes, quotes, morningItems] = await Promise.all([
      symbols.length
        ? PaperTradingTrade.findAll({
            where: { portfolio_id, symbol: { [Op.in]: symbols } },
            order: [['created_at', 'ASC']],
          })
        : [],
      symbols.length
        ? RecommendationTradeOutcome.findAll({
            where: { portfolio_id, symbol: { [Op.in]: symbols } },
            order: [
              ['updated_at', 'DESC'],
              ['id', 'DESC'],
            ],
          })
        : [],
      Promise.all(
        symbols.map(symbol =>
          RealtimeQuote.findOne({ where: { symbol }, order: [['quote_time', 'DESC']] })
        )
      ),
      morningSnapshot
        ? AiRecommendationItem.findAll({
            where: { snapshotId: morningSnapshot.snapshotId },
            order: [['sortRank', 'ASC']],
          })
        : [],
    ]);

    const portfolioAlerts = riskAlertRows.filter(
      row => normalizedPortfolioId(row.metadata) === portfolio_id
    );
    const portfolioNotifications = notificationRows.filter(row => {
      if (normalizedPortfolioId(row.metadata) !== portfolio_id) return false;
      const scenario = String(objectValue(row.metadata).scenario || '');
      return !row.kind.includes('morning') && !scenario.includes('morning_checkup');
    });
    const accountCorrectionNotifications = notificationRows
      .filter(
        row =>
          row.recipient_user_id === user_id &&
          normalizedPortfolioId(row.metadata) === null &&
          objectValue(row.metadata).ledger_scope === 'account_correction'
      )
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    const portfolioCorrections = corrections.filter(row =>
      recordTouchesPortfolio(
        { entity_id: row.entity_id, before_state: row.before_state, after_state: row.after_state },
        portfolio_id
      )
    );

    const outcomeBySymbol = new Map<string, RecommendationTradeOutcome>();
    for (const outcome of outcomes) {
      const symbol = normalizeSymbol(outcome.symbol);
      const previous = outcomeBySymbol.get(symbol);
      if (!previous || (previous.trade_status !== 'open' && outcome.trade_status === 'open')) {
        outcomeBySymbol.set(symbol, outcome);
      }
    }
    const tradesBySymbol = new Map<string, PaperTradingTrade[]>();
    for (const trade of trades) {
      const symbol = normalizeSymbol(trade.symbol);
      tradesBySymbol.set(symbol, [...(tradesBySymbol.get(symbol) || []), trade]);
    }

    const signalIds = new Set<number>();
    for (const [symbol, symbolTrades] of tradesBySymbol) {
      const outcome = outcomeBySymbol.get(symbol);
      const exactEntry = outcome?.entry_trade_id
        ? symbolTrades.find(row => row.id === outcome.entry_trade_id)
        : undefined;
      if (exactEntry && outcome) signalIds.add(outcome.signal_id);
      const latestBuy = [...symbolTrades].reverse().find(row => row.direction === 'BUY');
      const tradeSignalId = numberOrNull(objectValue(latestBuy?.trade_reason).signal_id);
      if (tradeSignalId && tradeSignalId > 0) signalIds.add(tradeSignalId);
    }
    const signalRows = signalIds.size
      ? await AIInvestmentSignal.findAll({ where: { id: { [Op.in]: [...signalIds] } } })
      : [];
    const signalById = new Map(signalRows.map(row => [row.id, row]));

    const quoteBySymbol = new Map<string, RealtimeQuote>();
    for (const quote of quotes) {
      if (quote) quoteBySymbol.set(normalizeSymbol(quote.symbol), quote);
    }
    const morningBySymbol = new Map(
      morningItems.map(item => [normalizeSymbol(item.ticker), item] as const)
    );
    const multibaggerBySymbol = new Map(
      multibaggerRows.map(item => [normalizeSymbol(item.ticker), item] as const)
    );
    const morningFreshness = classifyResearchFreshness(
      morningSnapshot?.tradingDay || null,
      expectedResearchDay
    );
    const multibaggerHead = [...multibaggerRows].sort(
      (a, b) => new Date(b.as_of_utc).getTime() - new Date(a.as_of_utc).getTime()
    )[0];
    const multibaggerDay = multibaggerHead?.research_day || null;
    const multibaggerFreshness = classifyResearchFreshness(multibaggerDay, expectedResearchDay);

    let position_value = 0;
    const ledgerPositions = positions.map(position => {
      const symbol = normalizeSymbol(position.symbol);
      const quote = quoteBySymbol.get(symbol);
      const quotePrice = numberOrNull(quote?.current_price);
      const validQuote = quote && quotePrice && quotePrice > 0 ? quote : null;
      const useQuote = Boolean(validQuote);
      const price = useQuote ? Number(quotePrice) : Number(position.current_price || 0);
      const quantity = Number(position.quantity || 0);
      const avgCost = Number(position.avg_cost || 0);
      const marketValue = price * quantity;
      const unrealizedPnl = (price - avgCost) * quantity;
      position_value += marketValue;
      const quoteFreshness = validQuote
        ? classifyQuoteFreshness(validQuote.quote_time, validQuote.trade_date, now)
        : {
            ...classifyQuoteFreshness(null, null, now),
            freshness: 'missing' as QuoteFreshness,
          };

      const symbolTrades = tradesBySymbol.get(symbol) || [];
      const outcome = outcomeBySymbol.get(symbol) || null;
      const exactEntryTrade = outcome?.entry_trade_id
        ? symbolTrades.find(row => row.id === outcome.entry_trade_id)
        : undefined;
      const latestBuyTrade = [...symbolTrades].reverse().find(row => row.direction === 'BUY');
      const sourceTrade = exactEntryTrade || latestBuyTrade;
      const reasonSignalId = numberOrNull(objectValue(sourceTrade?.trade_reason).signal_id);
      const exactSignalId = exactEntryTrade && outcome ? outcome.signal_id : reasonSignalId;
      const signal = exactSignalId ? signalById.get(exactSignalId) || null : null;
      const origin = tradeOrigin(sourceTrade);
      const source_status = signal
        ? 'signal_linked'
        : origin
        ? 'trade_origin_linked'
        : 'unresolved';

      const alerts = portfolioAlerts.filter(row => normalizeSymbol(row.symbol) === symbol);
      const symbolNotifications = portfolioNotifications.filter(
        row => normalizeSymbol(String(objectValue(row.metadata).symbol || '')) === symbol
      );
      const symbolCorrections = portfolioCorrections.filter(row =>
        correctionTouchesPosition(row, portfolio_id, symbol)
      );
      const morningItem = morningBySymbol.get(symbol) || null;
      const morningRecommendation = objectValue(morningItem?.recommendationJson);
      const multibaggerItem = multibaggerBySymbol.get(symbol) || null;

      const timeline: PortfolioLedgerTimelineItem[] = [];
      for (const trade of symbolTrades) {
        timeline.push({
          id: `trade:${trade.id}`,
          type: 'trade',
          title: `${trade.direction === 'BUY' ? '买入' : '卖出'} ${trade.quantity} 股`,
          detail: trade.trade_reason_summary || null,
          occurred_at: iso(trade.created_at) || now.toISOString(),
          status: 'executed',
          corrected: false,
          invalidated: false,
        });
      }
      if (signal) {
        timeline.push({
          id: `signal:${signal.id}`,
          type: 'signal',
          title:
            signal.source_type === 'research_loop'
              ? `联合决策 · ${String(signal.action || signal.normalized_decision).toUpperCase()}`
              : `推荐信号 · ${signal.source_type}`,
          detail: signal.rationale || signal.decision || null,
          occurred_at: iso(signal.created_at) || `${signal.signal_date}T00:00:00.000Z`,
          status: signal.normalized_decision,
          corrected: false,
          invalidated: false,
        });
      }
      for (const alert of alerts) {
        timeline.push({
          id: `alert:${alert.id}`,
          type: 'alert',
          title: `${alert.level} 风控告警`,
          detail: alert.message,
          occurred_at: iso(alert.created_at) || now.toISOString(),
          status: alert.is_read ? 'read' : 'unread',
          corrected: Boolean(objectValue(alert.metadata).corrected),
          invalidated: Boolean(objectValue(alert.metadata).invalidated),
        });
      }
      for (const notification of symbolNotifications) {
        const metadata = objectValue(notification.metadata);
        const invalidated = Boolean(metadata.invalidated);
        timeline.push({
          id: `notification:${notification.id}`,
          type: 'notification',
          title: invalidated ? `已作废 · ${notification.title}` : notification.title,
          detail: notification.kind,
          occurred_at: iso(notification.created_at) || now.toISOString(),
          status: invalidated ? 'invalidated' : notification.status,
          corrected: Boolean(metadata.corrected),
          invalidated,
        });
      }
      for (const correction of symbolCorrections) {
        timeline.push({
          id: `correction:${correction.id}`,
          type: 'correction',
          title: '数据更正',
          detail: String(correction.reason || ''),
          occurred_at: iso(correction.created_at) || now.toISOString(),
          status: 'applied',
          corrected: true,
          invalidated: false,
        });
      }

      return {
        position: {
          id: position.id,
          symbol,
          name: position.name || symbol,
          quantity,
          avg_cost: avgCost,
          stop_loss_price: numberOrNull(position.stop_loss_price),
          take_profit_price: numberOrNull(position.take_profit_price),
          highest_price: numberOrNull(position.highest_price),
          trailing_stop_price: numberOrNull(position.trailing_stop_price),
          created_at: iso(position.created_at),
        },
        quote: {
          price,
          source: validQuote ? validQuote.source : 'paper_position_cache',
          quote_time: validQuote ? iso(validQuote.quote_time) : iso(position.updated_at),
          trade_date: validQuote ? validQuote.trade_date : null,
          ...quoteFreshness,
        },
        valuation: {
          market_value: Math.round(marketValue * 100) / 100,
          unrealized_pnl: Math.round(unrealizedPnl * 100) / 100,
          unrealized_pnl_pct: avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : null,
        },
        source_status,
        source_message:
          source_status === 'signal_linked'
            ? null
            : source_status === 'trade_origin_linked'
            ? `成交来源：${origin?.source}`
            : '成交来源未记录，无法可靠归因',
        trade_origin: origin,
        entry_trades: symbolTrades
          .filter(row => row.direction === 'BUY')
          .map(row => ({
            id: row.id,
            execute_price: Number(row.execute_price),
            quantity: Number(row.quantity),
            amount: Number(row.amount),
            commission: Number(row.commission),
            trade_reason_summary: row.trade_reason_summary,
            created_at: iso(row.created_at),
          })),
        investment_signal: signal
          ? {
              id: signal.id,
              source_type: signal.source_type,
              source_id: signal.source_id,
              signal_date: signal.signal_date,
              decision: signal.decision,
              normalized_decision: signal.normalized_decision,
              confidence_score: numberOrNull(signal.confidence_score),
              rationale: signal.rationale || null,
              metadata: signal.metadata || {},
            }
          : null,
        outcome: outcome
          ? {
              id: outcome.id,
              trade_status: outcome.trade_status,
              entry_trade_id: outcome.entry_trade_id || null,
              exit_trade_id: outcome.exit_trade_id || null,
              entry_date: outcome.entry_date || null,
              entry_price: numberOrNull(outcome.entry_price),
              latest_price: numberOrNull(outcome.latest_price),
              total_pnl: numberOrNull(outcome.total_pnl),
              total_pnl_pct: numberOrNull(outcome.total_pnl_pct),
              updated_at: iso(outcome.updated_at),
            }
          : null,
        morning_brief: morningItem
          ? {
              matched: true,
              snapshot_id: morningSnapshot?.snapshotId || null,
              item_id: morningItem.itemId,
              trading_day: morningSnapshot?.tradingDay || null,
              expected_trading_day: expectedResearchDay,
              as_of: iso(morningSnapshot?.asOfUtc),
              ...morningFreshness,
              rank: morningItem.sortRank,
              rating: morningItem.ratingBand,
              conviction: numberOrNull(morningItem.convictionFinal),
              headline: objectValue(morningRecommendation.explanation).headline || null,
            }
          : {
              matched: false,
              snapshot_id: morningSnapshot?.snapshotId || null,
              trading_day: morningSnapshot?.tradingDay || null,
              expected_trading_day: expectedResearchDay,
              as_of: iso(morningSnapshot?.asOfUtc),
              ...morningFreshness,
            },
        multibagger: multibaggerItem
          ? {
              matched: true,
              snapshot_id: multibaggerItem.snapshot_id,
              as_of: iso(multibaggerItem.as_of_utc),
              available_at: iso(multibaggerItem.available_at_utc),
              ...classifyResearchFreshness(multibaggerItem.research_day, expectedResearchDay),
              stage: multibaggerItem.stage,
              conclusion: multibaggerItem.conclusion,
              rating: multibaggerItem.rating,
              strategy_version: multibaggerItem.strategy_version,
            }
          : {
              matched: false,
              as_of: iso(multibaggerHead?.as_of_utc),
              available_at: iso(multibaggerHead?.available_at_utc),
              ...multibaggerFreshness,
              strategy_version: multibaggerHead?.strategy_version || null,
            },
        alerts: alerts.map(mapAlert),
        notifications: symbolNotifications.map(mapNotification),
        corrections: symbolCorrections.map(mapCorrection),
        timeline: sortLedgerTimeline(timeline),
      };
    });

    const current_cash = Number(portfolio.current_cash || 0);
    const total_value = current_cash + position_value;
    const initial_capital = Number(portfolio.initial_capital || 0);
    const quoteTimes = ledgerPositions
      .map(row => row.quote.quote_time)
      .filter((value): value is string => Boolean(value))
      .sort();
    const quoteSources = new Set(ledgerPositions.map(row => row.quote.source));
    const quoteCounts = ledgerPositions.reduce<Record<QuoteFreshness, number>>(
      (acc, row) => {
        acc[row.quote.freshness] += 1;
        return acc;
      },
      { live: 0, close: 0, delayed: 0, stale: 0, missing: 0 }
    );
    const correctionNotifications = [...portfolioNotifications, ...accountCorrectionNotifications]
      .filter(
        row => row.kind.includes('correction') || Boolean(objectValue(row.metadata).correction_id)
      )
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return {
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        description: portfolio.description,
        is_active: portfolio.is_active,
        auto_trade_enabled: portfolio.auto_trade_enabled,
        strategy_keys: portfolio.strategy_keys || [],
      },
      valuation: {
        initial_capital,
        current_cash,
        position_value: Math.round(position_value * 100) / 100,
        total_value: Math.round(total_value * 100) / 100,
        total_pnl: Math.round((total_value - initial_capital) * 100) / 100,
        total_pnl_pct:
          initial_capital > 0 ? ((total_value - initial_capital) / initial_capital) * 100 : null,
        valued_at: quoteTimes.length ? quoteTimes[quoteTimes.length - 1] : null,
        oldest_quote_at: quoteTimes.length ? quoteTimes[0] : null,
        newest_quote_at: quoteTimes.length ? quoteTimes[quoteTimes.length - 1] : null,
        quote_source:
          quoteSources.size === 0
            ? 'none'
            : quoteSources.size === 1
            ? [...quoteSources][0]
            : 'mixed',
        quote_counts: quoteCounts,
        has_stale_quotes: quoteCounts.stale > 0 || quoteCounts.missing > 0,
      },
      latest_morning_brief: morningSnapshot
        ? {
            snapshot_id: morningSnapshot.snapshotId,
            trading_day: morningSnapshot.tradingDay,
            expected_trading_day: expectedResearchDay,
            as_of: iso(morningSnapshot.asOfUtc),
            ...morningFreshness,
          }
        : {
            snapshot_id: null,
            trading_day: null,
            expected_trading_day: expectedResearchDay,
            as_of: null,
            ...morningFreshness,
          },
      latest_multibagger: multibaggerHead
        ? {
            as_of: iso(multibaggerHead.as_of_utc),
            available_at: iso(multibaggerHead.available_at_utc),
            research_day: multibaggerHead.research_day,
            market_scope: 'cn_a',
            strategy_version: multibaggerHead.strategy_version,
            ...multibaggerFreshness,
          }
        : null,
      unread_alerts_count: portfolioAlerts.filter(row => !row.is_read).length,
      portfolio_alerts: portfolioAlerts.map(mapAlert),
      portfolio_notifications: portfolioNotifications.map(mapNotification),
      account_correction_notifications: accountCorrectionNotifications.map(mapNotification),
      portfolio_corrections: portfolioCorrections.map(mapCorrection),
      latest_correction_notification: correctionNotifications.length
        ? mapNotification(correctionNotifications[0])
        : null,
      positions: ledgerPositions,
    };
  }

  private async loadLatestMultibaggerRows(now: Date): Promise<MultibaggerLedgerRow[]> {
    try {
      return await sequelize.query<MultibaggerLedgerRow>(
        `WITH latest_batch AS (
           SELECT MAX(as_of_utc) AS as_of_utc
             FROM multibagger_candidate_snapshot
            WHERE market_scope = 'cn_a' AND available_at_utc <= :now
         )
         SELECT candidate.multibagger_candidate_snapshot_id AS snapshot_id,
                candidate.ticker,
                candidate.as_of_utc,
                candidate.available_at_utc,
                candidate.stage,
                candidate.conclusion,
                candidate.rating,
                candidate.strategy_version,
                regexp_replace(source.source_version, '^live-', '') AS research_day
           FROM multibagger_candidate_snapshot candidate
           JOIN latest_batch batch ON batch.as_of_utc = candidate.as_of_utc
           LEFT JOIN LATERAL (
             SELECT fact.source_version
               FROM multibagger_universe fact
              WHERE fact.market_scope = candidate.market_scope
                AND fact.exchange = candidate.exchange
                AND fact.ticker = candidate.ticker
                AND candidate.source_fact_hashes ? fact.fact_hash
              ORDER BY fact.available_at_utc DESC, fact.created_at DESC
              LIMIT 1
           ) source ON TRUE
          WHERE candidate.market_scope = 'cn_a'
          ORDER BY candidate.ticker`,
        { replacements: { now }, type: QueryTypes.SELECT }
      );
    } catch {
      return [];
    }
  }

  private async loadCorrections(): Promise<Record<string, any>[]> {
    try {
      return await sequelize.query<Record<string, any>>(
        `SELECT id, correction_key, correction_type, entity_type, entity_id,
                reason, before_state, after_state, created_at
           FROM paper_trading_data_corrections
          ORDER BY created_at DESC
          LIMIT 200`,
        { type: QueryTypes.SELECT }
      );
    } catch {
      return [];
    }
  }
}

export const portfolioLedgerService = new PortfolioLedgerService();
