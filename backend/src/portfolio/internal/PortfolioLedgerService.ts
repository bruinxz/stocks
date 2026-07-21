import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database';
import { AIInvestmentSignal } from '../../models/AIInvestmentSignal';
import { AiRecommendationItem } from '../../models/AiRecommendationItem';
import { AiRecommendationSnapshot } from '../../models/AiRecommendationSnapshot';
import { FeishuNotificationOutbox } from '../../models/FeishuNotificationOutbox';
import { MultibaggerCandidateSnapshot } from '../../models/MultibaggerCandidateSnapshot';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingTrade } from '../../models/PaperTradingTrade';
import { RealtimeQuote } from '../../models/RealtimeQuote';
import { RecommendationTradeOutcome } from '../../models/RecommendationTradeOutcome';
import { RiskAlert } from '../../models/RiskAlert';
import { getEast8DateString } from '../../utils/timezone';
import { normalizeSymbol } from '../../utils/stockSymbol';

export type QuoteFreshness = 'fresh' | 'delayed' | 'stale' | 'missing';

export interface PortfolioLedgerTimelineItem {
  id: string;
  type: 'trade' | 'signal' | 'alert' | 'notification' | 'correction';
  title: string;
  detail: string | null;
  occurred_at: string;
  status: string | null;
  corrected: boolean;
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

function plain<T extends { get?: (options?: any) => any }>(row: T | null | undefined): any {
  if (!row) return null;
  return typeof row.get === 'function' ? row.get({ plain: true }) : row;
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

export function classifyQuoteFreshness(
  quote_time: Date | string | null,
  trade_date: string | null,
  now = new Date()
): { freshness: QuoteFreshness; age_minutes: number | null } {
  if (!quote_time || !trade_date) return { freshness: 'missing', age_minutes: null };
  const parsed = quote_time instanceof Date ? quote_time : new Date(quote_time);
  if (Number.isNaN(parsed.getTime())) return { freshness: 'missing', age_minutes: null };
  const age = Math.max(0, Math.round((now.getTime() - parsed.getTime()) / 60000));
  if (trade_date !== getEast8DateString(now)) return { freshness: 'stale', age_minutes: age };
  if (age <= 15) return { freshness: 'fresh', age_minutes: age };
  if (age <= 120) return { freshness: 'delayed', age_minutes: age };
  return { freshness: 'stale', age_minutes: age };
}

function correctionTouchesPosition(
  row: Record<string, any>,
  portfolio_id: number,
  symbol: string
): boolean {
  const haystack = JSON.stringify({
    entity_id: row.entity_id,
    before_state: row.before_state,
    after_state: row.after_state,
  });
  return (
    haystack.includes(`\"portfolio_id\":${portfolio_id}`) &&
    haystack.includes(normalizeSymbol(symbol))
  );
}

export function sortLedgerTimeline(
  items: PortfolioLedgerTimelineItem[]
): PortfolioLedgerTimelineItem[] {
  return [...items].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
  );
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

    const positions = await PaperTradingPosition.findAll({
      where: { portfolio_id, quantity: { [Op.gt]: 0 } },
      order: [['id', 'ASC']],
    });
    const symbols = [...new Set(positions.map(row => normalizeSymbol(row.symbol)).filter(Boolean))];

    const [trades, outcomes, riskAlerts, notifications, morningSnapshot, multibaggerHead] =
      await Promise.all([
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
        symbols.length
          ? RiskAlert.findAll({
              where: {
                user_id,
                symbol: { [Op.in]: symbols },
                metadata: { [Op.contains]: { portfolio_id } },
              },
              order: [['created_at', 'DESC']],
              limit: 200,
            })
          : [],
        FeishuNotificationOutbox.findAll({
          where: { metadata: { [Op.contains]: { portfolio_id } } },
          order: [['created_at', 'DESC']],
          limit: 200,
        }).catch(() => []),
        AiRecommendationSnapshot.findOne({
          where: { profile: 'us_preferred', marketScope: 'cn_a' },
          order: [
            ['tradingDay', 'DESC'],
            ['asOfUtc', 'DESC'],
          ],
        }).catch(() => null),
        MultibaggerCandidateSnapshot.findOne({
          where: { marketScope: 'cn_a' },
          order: [['asOfUtc', 'DESC']],
        }).catch(() => null),
      ]);

    const [quotes, morningItems, multibaggerItems, corrections] = await Promise.all([
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
      multibaggerHead
        ? MultibaggerCandidateSnapshot.findAll({
            where: { marketScope: 'cn_a', asOfUtc: multibaggerHead.asOfUtc },
            order: [['ticker', 'ASC']],
          })
        : [],
      this.loadCorrections(),
    ]);

    const outcomeBySymbol = new Map<string, RecommendationTradeOutcome>();
    for (const outcome of outcomes) {
      const symbol = normalizeSymbol(outcome.symbol);
      const previous = outcomeBySymbol.get(symbol);
      if (!previous || (previous.trade_status !== 'open' && outcome.trade_status === 'open')) {
        outcomeBySymbol.set(symbol, outcome);
      }
    }
    const signalIds = [...new Set([...outcomeBySymbol.values()].map(row => row.signal_id))];
    for (const trade of trades) {
      const signalId = Number(objectValue(trade.trade_reason).signal_id);
      if (Number.isFinite(signalId) && signalId > 0) signalIds.push(signalId);
    }
    const signalRows = signalIds.length
      ? await AIInvestmentSignal.findAll({ where: { id: { [Op.in]: [...new Set(signalIds)] } } })
      : [];
    const signalById = new Map(signalRows.map(row => [row.id, row]));

    const quoteBySymbol = new Map(
      quotes.filter(Boolean).map(row => [normalizeSymbol((row as RealtimeQuote).symbol), row!])
    );
    const tradesBySymbol = new Map<string, PaperTradingTrade[]>();
    for (const trade of trades) {
      const symbol = normalizeSymbol(trade.symbol);
      tradesBySymbol.set(symbol, [...(tradesBySymbol.get(symbol) || []), trade]);
    }
    const alertsBySymbol = new Map<string, RiskAlert[]>();
    for (const alert of riskAlerts) {
      const symbol = normalizeSymbol(alert.symbol);
      alertsBySymbol.set(symbol, [...(alertsBySymbol.get(symbol) || []), alert]);
    }
    const notificationsBySymbol = new Map<string, FeishuNotificationOutbox[]>();
    for (const notification of notifications) {
      const symbol = normalizeSymbol(String(objectValue(notification.metadata).symbol || ''));
      if (!symbol) continue;
      notificationsBySymbol.set(symbol, [
        ...(notificationsBySymbol.get(symbol) || []),
        notification,
      ]);
    }
    const morningBySymbol = new Map(
      morningItems.map(item => [normalizeSymbol(item.ticker), item] as const)
    );
    const multibaggerBySymbol = new Map(
      multibaggerItems.map(item => [normalizeSymbol(item.ticker), item] as const)
    );

    let position_value = 0;
    let unread_alerts_count = 0;
    const ledgerPositions = positions.map(position => {
      const symbol = normalizeSymbol(position.symbol);
      const quote = quoteBySymbol.get(symbol);
      const storedPrice = Number(position.current_price || 0);
      const quotePrice = numberOrNull(quote?.current_price);
      const price = quotePrice && quotePrice > 0 ? quotePrice : storedPrice;
      const quantity = Number(position.quantity || 0);
      const avgCost = Number(position.avg_cost || 0);
      const marketValue = price * quantity;
      const unrealizedPnl = (price - avgCost) * quantity;
      position_value += marketValue;
      const quoteFreshness = classifyQuoteFreshness(
        quote?.quote_time || null,
        quote?.trade_date || null,
        now
      );

      const symbolTrades = tradesBySymbol.get(symbol) || [];
      const outcome = outcomeBySymbol.get(symbol) || null;
      const reasonSignalId = symbolTrades
        .map(row => Number(objectValue(row.trade_reason).signal_id))
        .find(value => Number.isFinite(value) && value > 0);
      const signal = signalById.get(outcome?.signal_id || reasonSignalId || 0) || null;
      const alerts = alertsBySymbol.get(symbol) || [];
      const symbolNotifications = notificationsBySymbol.get(symbol) || [];
      const symbolCorrections = corrections.filter(row =>
        correctionTouchesPosition(row, portfolio_id, symbol)
      );
      unread_alerts_count += alerts.filter(row => !row.is_read).length;

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
        });
      }
      if (signal) {
        timeline.push({
          id: `signal:${signal.id}`,
          type: 'signal',
          title: `推荐信号 · ${signal.source_type}`,
          detail: signal.rationale || signal.decision || null,
          occurred_at: iso(signal.created_at) || `${signal.signal_date}T00:00:00.000Z`,
          status: signal.normalized_decision,
          corrected: false,
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
        });
      }
      for (const notification of symbolNotifications) {
        timeline.push({
          id: `notification:${notification.id}`,
          type: 'notification',
          title: notification.title,
          detail: notification.kind,
          occurred_at: iso(notification.created_at) || now.toISOString(),
          status: notification.status,
          corrected: Boolean(objectValue(notification.metadata).corrected),
        });
      }
      for (const correction of symbolCorrections) {
        timeline.push({
          id: `correction:${correction.id}`,
          type: 'correction',
          title: '账务更正',
          detail: String(correction.reason || ''),
          occurred_at: iso(correction.created_at) || now.toISOString(),
          status: 'applied',
          corrected: true,
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
          source: quote ? quote.source : 'paper_position_cache',
          quote_time: iso(quote?.quote_time) || iso(position.updated_at),
          trade_date: quote?.trade_date || null,
          ...quoteFreshness,
        },
        valuation: {
          market_value: Math.round(marketValue * 100) / 100,
          unrealized_pnl: Math.round(unrealizedPnl * 100) / 100,
          unrealized_pnl_pct: avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : null,
        },
        source_status: signal ? 'linked' : 'missing',
        source_message: signal ? null : '未找到推荐来源',
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
              rank: morningItem.sortRank,
              rating: morningItem.ratingBand,
              conviction: numberOrNull(morningItem.convictionFinal),
              headline: objectValue(morningRecommendation.explanation).headline || null,
            }
          : {
              matched: false,
              snapshot_id: morningSnapshot?.snapshotId || null,
              trading_day: morningSnapshot?.tradingDay || null,
            },
        multibagger: multibaggerItem
          ? {
              matched: true,
              snapshot_id: multibaggerItem.multibaggerCandidateSnapshotId,
              as_of: iso(multibaggerItem.asOfUtc),
              stage: multibaggerItem.stage,
              conclusion: multibaggerItem.conclusion,
              rating: multibaggerItem.rating,
            }
          : {
              matched: false,
              as_of: iso(multibaggerHead?.asOfUtc),
            },
        alerts: alerts.map(row => ({
          id: row.id,
          level: row.level,
          rule_id: row.rule_id,
          message: row.message,
          is_read: row.is_read,
          created_at: iso(row.created_at),
        })),
        notifications: symbolNotifications.map(row => ({
          id: Number(row.id),
          title: row.title,
          kind: row.kind,
          status: row.status,
          corrected: Boolean(objectValue(row.metadata).corrected),
          created_at: iso(row.created_at),
          sent_at: iso(row.sent_at),
        })),
        corrections: symbolCorrections.map(row => ({
          id: Number(row.id),
          correction_key: row.correction_key,
          correction_type: row.correction_type,
          reason: row.reason,
          created_at: iso(row.created_at),
        })),
        timeline: sortLedgerTimeline(timeline),
      };
    });

    const current_cash = Number(portfolio.current_cash || 0);
    const total_value = current_cash + position_value;
    const initial_capital = Number(portfolio.initial_capital || 0);
    const quoteTimes = ledgerPositions
      .map(row => row.quote.quote_time)
      .filter((value): value is string => Boolean(value));

    quoteTimes.sort();
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
        quote_source: 'realtime_quotes',
        has_stale_quotes: ledgerPositions.some(row =>
          ['stale', 'missing'].includes(row.quote.freshness)
        ),
      },
      latest_morning_brief: morningSnapshot
        ? {
            snapshot_id: morningSnapshot.snapshotId,
            trading_day: morningSnapshot.tradingDay,
            as_of: iso(morningSnapshot.asOfUtc),
          }
        : null,
      latest_multibagger: multibaggerHead
        ? { as_of: iso(multibaggerHead.asOfUtc), market_scope: multibaggerHead.marketScope }
        : null,
      unread_alerts_count,
      positions: ledgerPositions,
    };
  }

  private async loadCorrections(): Promise<Record<string, any>[]> {
    try {
      return await sequelize.query<Record<string, any>>(
        `SELECT id, correction_key, correction_type, entity_type, entity_id,
                reason, before_state, after_state, created_at
           FROM paper_trading_data_corrections
          ORDER BY created_at DESC
          LIMIT 100`,
        { type: QueryTypes.SELECT }
      );
    } catch {
      return [];
    }
  }
}

export const portfolioLedgerService = new PortfolioLedgerService();
