import { strategyRegistry } from './StrategyRegistry';
import { average, maxDrawdownFromValues, pct, round, stddev } from './QuantMath';
import {
  QuantBacktestOptions,
  QuantBacktestStrategyResult,
  QuantBacktestTradeResult,
  QuantEquityPoint,
  QuantStockContext,
} from '../types/QuantTypes';

function dateOnly(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

interface OpenPosition {
  symbol: string;
  name?: string;
  quantity: number;
  buy_price: number;
  buy_date: string;
  entry_reason?: string;
}

export class QuantBacktestEngine {
  run(contexts: QuantStockContext[], options: QuantBacktestOptions): QuantBacktestStrategyResult[] {
    const strategies = strategyRegistry.resolve(options.strategy_keys);
    return strategies.map(strategy => {
      const initialCapital = Number(options.initial_capital || 200000);
      const commissionRate = Number(options.commission_rate ?? 0.0003);
      const slippageRate = Number(options.slippage_rate ?? 0.0005);
      const stampTaxRate = Number(options.stamp_tax_rate ?? 0.001);
      const maxPositions = Number(options.max_positions || 8);
      const positionPct = Number(options.position_pct || 10) / 100;
      const minScore = Number(options.min_score || 68);
      let cash = initialCapital;
      const positions = new Map<string, OpenPosition>();
      const trades: QuantBacktestTradeResult[] = [];
      const equityCurve: QuantEquityPoint[] = [];
      const dates = this.collectDates(contexts, options.start_date, options.end_date);

      for (const currentDate of dates) {
        const candidates: Array<{ context: QuantStockContext; signal: any; price: number }> = [];
        for (const context of contexts) {
          const barsUntilDate = context.bars.filter(bar => dateOnly(bar.time) <= currentDate);
          const todayBar = barsUntilDate[barsUntilDate.length - 1];
          if (!todayBar || dateOnly(todayBar.time) !== currentDate) continue;
          if (barsUntilDate.length < Number(strategy.definition.default_params?.min_bars || 30))
            continue;
          const signal = strategy.evaluate(
            { ...context, bars: barsUntilDate },
            {
              as_of: currentDate,
              params: options.params_by_strategy?.[strategy.definition.strategy_key],
            }
          );
          const price = todayBar.close;
          const open = positions.get(context.symbol);
          const shouldExit =
            open &&
            (signal.signal === 'sell' ||
              price <= Number(signal.stop_loss_price || open.buy_price * 0.93) ||
              price >= Number(signal.take_profit_price || open.buy_price * 1.16) ||
              this.diffDays(open.buy_date, currentDate) >=
                Number(signal.target_holding_days || 20));
          if (shouldExit && open) {
            const sellPrice = price * (1 - slippageRate);
            const amount = sellPrice * open.quantity;
            const cost = amount * (commissionRate + stampTaxRate);
            const pnl = amount - cost - open.buy_price * open.quantity;
            cash += amount - cost;
            trades.push({
              strategy_key: strategy.definition.strategy_key,
              symbol: context.symbol,
              name: context.name,
              buy_date: open.buy_date,
              sell_date: currentDate,
              buy_price: round(open.buy_price, 4),
              sell_price: round(sellPrice, 4),
              quantity: open.quantity,
              amount: round(amount, 4),
              pnl: round(pnl, 4),
              return_pct: round((pnl / Math.max(open.buy_price * open.quantity, 1)) * 100, 4),
              holding_days: this.diffDays(open.buy_date, currentDate),
              entry_reason: open.entry_reason,
              exit_reason:
                signal.signal === 'sell'
                  ? '策略卖出信号'
                  : price <= Number(signal.stop_loss_price || 0)
                  ? '触发止损'
                  : price >= Number(signal.take_profit_price || Infinity)
                  ? '触发止盈'
                  : '达到最长持有期',
            });
            positions.delete(context.symbol);
          }
          if (
            !positions.has(context.symbol) &&
            signal.signal === 'buy' &&
            signal.score >= minScore
          ) {
            candidates.push({ context, signal, price });
          }
        }

        candidates.sort((a, b) => b.signal.score - a.signal.score);
        for (const candidate of candidates) {
          if (positions.size >= maxPositions) break;
          if (positions.has(candidate.context.symbol)) continue;
          const buyPrice = candidate.price * (1 + slippageRate);
          const targetAmount = Math.min(cash, initialCapital * positionPct);
          const quantity = Math.floor(targetAmount / Math.max(buyPrice, 0.01) / 100) * 100;
          if (quantity <= 0) continue;
          const amount = quantity * buyPrice;
          const cost = amount * commissionRate;
          if (amount + cost > cash) continue;
          cash -= amount + cost;
          positions.set(candidate.context.symbol, {
            symbol: candidate.context.symbol,
            name: candidate.context.name,
            quantity,
            buy_price: buyPrice,
            buy_date: currentDate,
            entry_reason: (candidate.signal.reasons || []).slice(0, 2).join('；'),
          });
        }

        const positionValue = [...positions.values()].reduce((sum, position) => {
          const context = contexts.find(item => item.symbol === position.symbol);
          const latest = context?.bars
            .filter(bar => dateOnly(bar.time) <= currentDate)
            .slice(-1)[0];
          return sum + position.quantity * Number(latest?.close || position.buy_price);
        }, 0);
        const totalValue = cash + positionValue;
        const values = equityCurve.map(item => item.total_value).concat(totalValue);
        equityCurve.push({
          date: currentDate,
          total_value: round(totalValue, 4),
          cash: round(cash, 4),
          position_value: round(positionValue, 4),
          cumulative_return_pct: round(((totalValue - initialCapital) / initialCapital) * 100, 4),
          drawdown_pct: round(maxDrawdownFromValues(values), 4),
        });
      }

      const finalValue = equityCurve[equityCurve.length - 1]?.total_value || initialCapital;
      const totalReturn = ((finalValue - initialCapital) / initialCapital) * 100;
      const dailyReturns = equityCurve
        .slice(1)
        .map((point, index) => pct(point.total_value, equityCurve[index].total_value));
      const wins = trades.filter(trade => Number(trade.pnl || 0) > 0);
      const losses = trades.filter(trade => Number(trade.pnl || 0) < 0);
      const grossProfit = wins.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
      const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0));
      const calendarDays = Math.max(this.diffDays(options.start_date, options.end_date), 1);
      return {
        strategy_key: strategy.definition.strategy_key,
        strategy_name: strategy.definition.name,
        total_return_pct: round(totalReturn, 4),
        annual_return_pct: round(((1 + totalReturn / 100) ** (365 / calendarDays) - 1) * 100, 4),
        max_drawdown_pct: round(
          maxDrawdownFromValues(equityCurve.map(item => item.total_value)),
          4
        ),
        sharpe_ratio: round(
          stddev(dailyReturns)
            ? (average(dailyReturns) / stddev(dailyReturns)) * Math.sqrt(252)
            : 0,
          4
        ),
        win_rate: round(trades.length ? (wins.length / trades.length) * 100 : 0, 4),
        profit_factor: round(grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0, 4),
        trade_count: trades.length,
        avg_holding_days: round(average(trades.map(trade => trade.holding_days)), 2),
        benchmark_return_pct: 0,
        excess_return_pct: round(totalReturn, 4),
        metrics: {
          open_positions: positions.size,
          final_value: round(finalValue, 4),
          gross_profit: round(grossProfit, 4),
          gross_loss: round(grossLoss, 4),
        },
        equity_curve: equityCurve,
        drawdown_curve: equityCurve.map(item => ({
          date: item.date,
          drawdown_pct: item.drawdown_pct,
        })),
        trades,
      };
    });
  }

  private collectDates(
    contexts: QuantStockContext[],
    start_date: string,
    end_date: string
  ): string[] {
    const set = new Set<string>();
    for (const context of contexts) {
      for (const bar of context.bars) {
        const date = dateOnly(bar.time);
        if (date >= start_date && date <= end_date) set.add(date);
      }
    }
    return [...set].sort();
  }

  private diffDays(start: string, end: string) {
    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T00:00:00.000Z`);
    return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 86400000));
  }
}

export const quantBacktestEngine = new QuantBacktestEngine();
