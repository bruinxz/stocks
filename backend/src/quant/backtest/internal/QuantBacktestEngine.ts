import { strategyRegistry } from '../../engine/StrategyRegistry';
import { average, maxDrawdownFromValues, pct, round, stddev } from '../../engine/QuantMath';
import {
  QuantBacktestOptions,
  QuantBacktestStrategyResult,
  QuantBacktestTradeResult,
  QuantEquityPoint,
  QuantStockContext,
  QuantBar,
} from '../../types/QuantTypes';

function dateOnly(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface OpenPosition {
  symbol: string;
  name?: string;
  quantity: number;
  buy_price: number;
  buy_date: string;
  entry_reason?: string;
  buy_commission?: number;
  strategy_score?: number;
}

interface PendingOrder {
  symbol: string;
  signal_date: string;
  strategy_key: string;
  context: QuantStockContext;
  signal: any;
  ranking_score: number;
}

interface PendingExitOrder {
  symbol: string;
  signal_date: string;
  strategy_key: string;
  context: QuantStockContext;
  signal: any;
  exit_reason: string;
}

type TradeSide = 'buy' | 'sell';

interface ExecutionConfig {
  initial_capital: number;
  commission_rate: number;
  min_commission: number;
  slippage_rate: number;
  stamp_tax_rate: number;
  max_positions: number;
  position_pct: number;
  min_score: number;
  execution_timing: 'next_open' | 'same_close';
  enable_t_plus_one: boolean;
  lot_size: number;
  limit_up_pct: number;
  limit_down_pct: number;
  block_limit_up: boolean;
  block_limit_down: boolean;
  block_suspended: boolean;
  min_turnover_yuan: number;
  max_trade_amount_pct_of_turnover: number;
  dynamic_slippage: boolean;
}

interface ExecutionDiagnostics {
  execution_timing: 'next_open' | 'same_close';
  enable_t_plus_one: boolean;
  lot_size: number;
  commission_rate: number;
  min_commission: number;
  stamp_tax_rate: number;
  base_slippage_rate: number;
  dynamic_slippage: boolean;
  min_turnover_yuan: number;
  max_trade_amount_pct_of_turnover: number;
  buy_attempt_count: number;
  buy_fill_count: number;
  sell_attempt_count: number;
  sell_fill_count: number;
  pending_signal_count: number;
  pending_exit_signal_count: number;
  blocked_buy_count: number;
  blocked_sell_count: number;
  suspended_bar_count: number;
  total_commission: number;
  total_stamp_tax: number;
  total_slippage_cost: number;
  block_reasons: Record<string, number>;
}

function addBlock(diagnostics: ExecutionDiagnostics, side: TradeSide, reason: string) {
  diagnostics.block_reasons[reason] = (diagnostics.block_reasons[reason] || 0) + 1;
  if (side === 'buy') diagnostics.blocked_buy_count += 1;
  if (side === 'sell') diagnostics.blocked_sell_count += 1;
}

export class QuantBacktestEngine {
  run(contexts: QuantStockContext[], options: QuantBacktestOptions): QuantBacktestStrategyResult[] {
    const strategies = strategyRegistry.resolve(options.strategy_keys);
    const contextBySymbol = new Map(contexts.map(context => [context.symbol, context]));
    const dates = this.collectDates(contexts, options.start_date, options.end_date);

    return strategies.map(strategy => {
      const config = this.buildExecutionConfig(options);
      let cash = config.initial_capital;
      const positions = new Map<string, OpenPosition>();
      const pendingOrders: PendingOrder[] = [];
      const pendingExitOrders: PendingExitOrder[] = [];
      const trades: QuantBacktestTradeResult[] = [];
      const equityCurve: QuantEquityPoint[] = [];
      const diagnostics = this.createDiagnostics(config);

      for (const currentDate of dates) {
        this.executePendingExitOrders(
          currentDate,
          pendingExitOrders,
          positions,
          contextBySymbol,
          config,
          diagnostics,
          trades,
          cashPatch => {
            cash += cashPatch;
          }
        );

        this.executePendingOrders(
          currentDate,
          pendingOrders,
          positions,
          contextBySymbol,
          config,
          diagnostics,
          cashPatch => {
            cash += cashPatch;
          },
          () => cash
        );

        const sameDayCandidates: PendingOrder[] = [];

        for (const context of contexts) {
          const barsUntilDate = context.bars.filter(bar => dateOnly(bar.time) <= currentDate);
          const todayBar = barsUntilDate[barsUntilDate.length - 1];
          if (!todayBar || dateOnly(todayBar.time) !== currentDate) continue;
          if (this.isSuspended(todayBar)) diagnostics.suspended_bar_count += 1;
          if (barsUntilDate.length < Number(strategy.definition.default_params?.min_bars || 30)) {
            continue;
          }

          const signal = strategy.evaluate(
            { ...context, bars: barsUntilDate },
            {
              as_of: currentDate,
              params: options.params_by_strategy?.[strategy.definition.strategy_key],
            }
          );

          const open = positions.get(context.symbol);
          const closePrice = todayBar.close;
          const shouldExit =
            open &&
            (signal.signal === 'sell' ||
              closePrice <= Number(signal.stop_loss_price || open.buy_price * 0.93) ||
              closePrice >= Number(signal.take_profit_price || open.buy_price * 1.16) ||
              this.diffDays(open.buy_date, currentDate) >=
                Number(signal.target_holding_days || 20));

          if (shouldExit && open) {
            const exitReason = this.resolveExitReason(signal, closePrice, open, currentDate);
            if (config.execution_timing === 'same_close') {
              this.executeSellOrder({
                currentDate,
                bar: todayBar,
                context,
                signal,
                exitReason,
                strategy_key: strategy.definition.strategy_key,
                positions,
                config,
                diagnostics,
                trades,
                applyCashPatch: cashPatch => {
                  cash += cashPatch;
                },
              });
            } else if (!pendingExitOrders.some(order => order.symbol === context.symbol)) {
              pendingExitOrders.push({
                symbol: context.symbol,
                signal_date: currentDate,
                strategy_key: strategy.definition.strategy_key,
                context,
                signal,
                exit_reason: exitReason,
              });
              diagnostics.pending_exit_signal_count += 1;
            }
          }

          if (
            !positions.has(context.symbol) &&
            signal.signal === 'buy' &&
            signal.score >= config.min_score
          ) {
            const candidate: PendingOrder = {
              symbol: context.symbol,
              signal_date: currentDate,
              strategy_key: strategy.definition.strategy_key,
              context,
              signal,
              ranking_score: Number(signal.score || 0),
            };
            diagnostics.pending_signal_count += 1;
            if (config.execution_timing === 'same_close') {
              sameDayCandidates.push(candidate);
            } else {
              pendingOrders.push(candidate);
            }
          }
        }

        if (sameDayCandidates.length) {
          this.executeCandidateOrders(
            currentDate,
            sameDayCandidates,
            positions,
            contextBySymbol,
            config,
            diagnostics,
            cashPatch => {
              cash += cashPatch;
            },
            () => cash
          );
        }

        const positionValue = [...positions.values()].reduce((sum, position) => {
          const context = contextBySymbol.get(position.symbol);
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
          cumulative_return_pct: round(
            ((totalValue - config.initial_capital) / config.initial_capital) * 100,
            4
          ),
          drawdown_pct: round(maxDrawdownFromValues(values), 4),
        });
      }

      const finalValue = equityCurve[equityCurve.length - 1]?.total_value || config.initial_capital;
      const totalReturn = ((finalValue - config.initial_capital) / config.initial_capital) * 100;
      const dailyReturns = equityCurve
        .slice(1)
        .map((point, index) => pct(point.total_value, equityCurve[index].total_value));
      const wins = trades.filter(trade => Number(trade.pnl || 0) > 0);
      const losses = trades.filter(trade => Number(trade.pnl || 0) < 0);
      const grossProfit = wins.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
      const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0));
      const calendarDays = Math.max(this.diffDays(options.start_date, options.end_date), 1);
      diagnostics.total_commission = round(diagnostics.total_commission, 4);
      diagnostics.total_stamp_tax = round(diagnostics.total_stamp_tax, 4);
      diagnostics.total_slippage_cost = round(diagnostics.total_slippage_cost, 4);

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
          pending_orders: pendingOrders.length,
          pending_exit_orders: pendingExitOrders.length,
          final_value: round(finalValue, 4),
          gross_profit: round(grossProfit, 4),
          gross_loss: round(grossLoss, 4),
          execution_diagnostics: diagnostics,
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

  private buildExecutionConfig(options: QuantBacktestOptions): ExecutionConfig {
    return {
      initial_capital: Number(options.initial_capital || 200000),
      commission_rate: Number(options.commission_rate ?? 0.0003),
      min_commission: Number(options.min_commission ?? 5),
      slippage_rate: Number(options.slippage_rate ?? 0.0005),
      stamp_tax_rate: Number(options.stamp_tax_rate ?? 0.001),
      max_positions: Number(options.max_positions || 8),
      position_pct: Number(options.position_pct || 10) / 100,
      min_score: Number(options.min_score || 68),
      execution_timing: options.execution_timing || 'next_open',
      enable_t_plus_one: options.enable_t_plus_one !== false,
      lot_size: Math.max(Number(options.lot_size || 100), 1),
      limit_up_pct: Number(options.limit_up_pct || 9.8),
      limit_down_pct: Number(options.limit_down_pct || -9.8),
      block_limit_up: options.block_limit_up !== false,
      block_limit_down: options.block_limit_down !== false,
      block_suspended: options.block_suspended !== false,
      min_turnover_yuan: Math.max(Number(options.min_turnover_yuan || 0), 0),
      max_trade_amount_pct_of_turnover: Math.max(
        Number(options.max_trade_amount_pct_of_turnover || 1),
        0.01
      ),
      dynamic_slippage: options.dynamic_slippage !== false,
    };
  }

  private createDiagnostics(config: ExecutionConfig): ExecutionDiagnostics {
    return {
      execution_timing: config.execution_timing,
      enable_t_plus_one: config.enable_t_plus_one,
      lot_size: config.lot_size,
      commission_rate: config.commission_rate,
      min_commission: config.min_commission,
      stamp_tax_rate: config.stamp_tax_rate,
      base_slippage_rate: config.slippage_rate,
      dynamic_slippage: config.dynamic_slippage,
      min_turnover_yuan: config.min_turnover_yuan,
      max_trade_amount_pct_of_turnover: config.max_trade_amount_pct_of_turnover,
      buy_attempt_count: 0,
      buy_fill_count: 0,
      sell_attempt_count: 0,
      sell_fill_count: 0,
      pending_signal_count: 0,
      pending_exit_signal_count: 0,
      blocked_buy_count: 0,
      blocked_sell_count: 0,
      suspended_bar_count: 0,
      total_commission: 0,
      total_stamp_tax: 0,
      total_slippage_cost: 0,
      block_reasons: {},
    };
  }

  private executePendingExitOrders(
    currentDate: string,
    pendingExitOrders: PendingExitOrder[],
    positions: Map<string, OpenPosition>,
    contextBySymbol: Map<string, QuantStockContext>,
    config: ExecutionConfig,
    diagnostics: ExecutionDiagnostics,
    trades: QuantBacktestTradeResult[],
    applyCashPatch: (delta: number) => void
  ) {
    const due = pendingExitOrders.filter(order => order.signal_date < currentDate);
    if (!due.length) return;
    for (const order of due) {
      const index = pendingExitOrders.indexOf(order);
      if (index >= 0) pendingExitOrders.splice(index, 1);
      const context = contextBySymbol.get(order.symbol) || order.context;
      const bar = context.bars.find(item => dateOnly(item.time) === currentDate);
      if (!bar) {
        addBlock(diagnostics, 'sell', 'next_exit_bar_missing');
        continue;
      }
      this.executeSellOrder({
        currentDate,
        bar,
        context,
        signal: order.signal,
        exitReason: `${order.exit_reason}；次日开盘执行`,
        strategy_key: order.strategy_key,
        positions,
        config,
        diagnostics,
        trades,
        applyCashPatch,
      });
    }
  }

  private executePendingOrders(
    currentDate: string,
    pendingOrders: PendingOrder[],
    positions: Map<string, OpenPosition>,
    contextBySymbol: Map<string, QuantStockContext>,
    config: ExecutionConfig,
    diagnostics: ExecutionDiagnostics,
    applyCashPatch: (delta: number) => void,
    getCash: () => number
  ) {
    const due = pendingOrders.filter(order => order.signal_date < currentDate);
    if (!due.length) return;
    for (const order of due) {
      const index = pendingOrders.indexOf(order);
      if (index >= 0) pendingOrders.splice(index, 1);
    }
    this.executeCandidateOrders(
      currentDate,
      due,
      positions,
      contextBySymbol,
      config,
      diagnostics,
      delta => {
        applyCashPatch(delta);
      },
      getCash
    );
  }

  private executeCandidateOrders(
    currentDate: string,
    candidates: PendingOrder[],
    positions: Map<string, OpenPosition>,
    contextBySymbol: Map<string, QuantStockContext>,
    config: ExecutionConfig,
    diagnostics: ExecutionDiagnostics,
    applyCashPatch: (delta: number) => void,
    getCash: () => number
  ) {
    candidates.sort((a, b) => b.ranking_score - a.ranking_score);
    for (const candidate of candidates) {
      diagnostics.buy_attempt_count += 1;
      if (positions.size >= config.max_positions) {
        addBlock(diagnostics, 'buy', 'max_positions');
        continue;
      }
      if (positions.has(candidate.context.symbol)) {
        addBlock(diagnostics, 'buy', 'already_holding');
        continue;
      }
      const context = contextBySymbol.get(candidate.context.symbol) || candidate.context;
      const bar = context.bars.find(item => dateOnly(item.time) === currentDate);
      if (!bar) {
        addBlock(diagnostics, 'buy', 'next_bar_missing');
        continue;
      }
      const buyCheck = this.canExecute(bar, 'buy', config);
      if (!buyCheck.ok) {
        addBlock(diagnostics, 'buy', buyCheck.reason || 'buy_blocked');
        continue;
      }
      const buyExecution = this.executionPrice(bar, 'buy', config);
      const buyPrice = buyExecution.price;
      const cash = getCash();
      const maxByTurnover = this.maxAmountByTurnover(bar, config);
      const targetAmount = Math.min(
        cash,
        config.initial_capital * config.position_pct,
        maxByTurnover
      );
      const quantity =
        Math.floor(targetAmount / Math.max(buyPrice, 0.01) / config.lot_size) * config.lot_size;
      if (quantity <= 0) {
        addBlock(diagnostics, 'buy', 'lot_or_cash_too_small');
        continue;
      }
      const amount = quantity * buyPrice;
      const commission = this.commission(amount, config);
      if (Number.isFinite(cash) && amount + commission > cash) {
        addBlock(diagnostics, 'buy', 'cash_not_enough');
        continue;
      }
      applyCashPatch(-(amount + commission));
      diagnostics.buy_fill_count += 1;
      diagnostics.total_commission += commission;
      diagnostics.total_slippage_cost += buyExecution.slippage_cost * quantity;
      positions.set(candidate.context.symbol, {
        symbol: candidate.context.symbol,
        name: candidate.context.name,
        quantity,
        buy_price: buyPrice,
        buy_date: currentDate,
        entry_reason: (candidate.signal.reasons || []).slice(0, 2).join('；'),
        buy_commission: commission,
        strategy_score: Number(candidate.signal.score || 0),
      });
    }
  }

  private executeSellOrder(options: {
    currentDate: string;
    bar: QuantBar;
    context: QuantStockContext;
    signal: any;
    exitReason: string;
    strategy_key: string;
    positions: Map<string, OpenPosition>;
    config: ExecutionConfig;
    diagnostics: ExecutionDiagnostics;
    trades: QuantBacktestTradeResult[];
    applyCashPatch: (delta: number) => void;
  }) {
    const open = options.positions.get(options.context.symbol);
    if (!open) return;
    options.diagnostics.sell_attempt_count += 1;
    if (options.config.enable_t_plus_one && this.diffDays(open.buy_date, options.currentDate) < 1) {
      addBlock(options.diagnostics, 'sell', 't_plus_one_block');
      return;
    }
    const sellCheck = this.canExecute(options.bar, 'sell', options.config);
    if (!sellCheck.ok) {
      addBlock(options.diagnostics, 'sell', sellCheck.reason || 'sell_blocked');
      return;
    }

    const executionPrice = this.executionPrice(options.bar, 'sell', options.config);
    const sellPrice = executionPrice.price;
    const amount = sellPrice * open.quantity;
    const commission = this.commission(amount, options.config);
    const stampTax = amount * options.config.stamp_tax_rate;
    const cost = commission + stampTax;
    const pnl = amount - cost - open.buy_price * open.quantity - (open.buy_commission || 0);

    options.applyCashPatch(amount - cost);
    options.diagnostics.sell_fill_count += 1;
    options.diagnostics.total_commission += commission;
    options.diagnostics.total_stamp_tax += stampTax;
    options.diagnostics.total_slippage_cost += executionPrice.slippage_cost * open.quantity;
    options.trades.push({
      strategy_key: options.strategy_key,
      symbol: options.context.symbol,
      name: options.context.name,
      buy_date: open.buy_date,
      sell_date: options.currentDate,
      buy_price: round(open.buy_price, 4),
      sell_price: round(sellPrice, 4),
      quantity: open.quantity,
      amount: round(amount, 4),
      pnl: round(pnl, 4),
      return_pct: round((pnl / Math.max(open.buy_price * open.quantity, 1)) * 100, 4),
      holding_days: this.diffDays(open.buy_date, options.currentDate),
      entry_reason: open.entry_reason,
      exit_reason: options.exitReason,
    });
    options.positions.delete(options.context.symbol);
  }

  private canExecute(
    bar: QuantBar,
    side: TradeSide,
    config: ExecutionConfig
  ): { ok: boolean; reason?: string } {
    if (config.block_suspended && this.isSuspended(bar))
      return { ok: false, reason: 'suspended_or_zero_volume' };
    const changePercent = this.resolveChangePercent(bar);
    if (side === 'buy' && config.block_limit_up && changePercent >= config.limit_up_pct) {
      return { ok: false, reason: 'limit_up_block_buy' };
    }
    if (side === 'sell' && config.block_limit_down && changePercent <= config.limit_down_pct) {
      return { ok: false, reason: 'limit_down_block_sell' };
    }
    if (config.min_turnover_yuan > 0 && this.resolveTurnover(bar) < config.min_turnover_yuan) {
      return { ok: false, reason: 'turnover_below_threshold' };
    }
    return { ok: true };
  }

  private executionPrice(bar: QuantBar, side: TradeSide, config: ExecutionConfig) {
    const basePrice =
      config.execution_timing === 'next_open'
        ? Number(bar.open || bar.close)
        : Number(bar.close || bar.open);
    const slippageRate = this.resolveSlippageRate(bar, config);
    const price = basePrice * (side === 'buy' ? 1 + slippageRate : 1 - slippageRate);
    return {
      price,
      slippage_rate: slippageRate,
      slippage_cost: Math.abs(price - basePrice),
    };
  }

  private resolveSlippageRate(bar: QuantBar, config: ExecutionConfig) {
    if (!config.dynamic_slippage) return config.slippage_rate;
    const turnover = this.resolveTurnover(bar);
    if (turnover <= 0) return config.slippage_rate * 2;
    if (turnover < 30000000) return config.slippage_rate * 1.8;
    if (turnover < 100000000) return config.slippage_rate * 1.25;
    return config.slippage_rate;
  }

  private maxAmountByTurnover(bar: QuantBar, config: ExecutionConfig) {
    const turnover = this.resolveTurnover(bar);
    if (turnover <= 0) return Number.POSITIVE_INFINITY;
    return turnover * (config.max_trade_amount_pct_of_turnover / 100);
  }

  private resolveTurnover(bar: QuantBar): number {
    const persistedTurnover = toNumber(bar.turnover ?? bar.amount, 0);
    if (persistedTurnover > 0) return persistedTurnover;

    const volume = toNumber(bar.volume, 0);
    const close = toNumber(bar.close || bar.open, 0);
    if (volume > 0 && close > 0) return volume * close;
    return 0;
  }

  private resolveChangePercent(bar: QuantBar): number {
    return toNumber(bar.change_percent, 0);
  }

  private isSuspended(bar: QuantBar): boolean {
    const volume = toNumber(bar.volume, 0);
    const turnover = this.resolveTurnover(bar);
    return volume <= 0 && turnover <= 0;
  }

  private commission(amount: number, config: ExecutionConfig): number {
    return Math.max(amount * config.commission_rate, config.min_commission);
  }

  private resolveExitReason(
    signal: any,
    closePrice: number,
    open: OpenPosition,
    currentDate: string
  ) {
    if (signal.signal === 'sell') return '策略卖出信号（A股真实规则）';
    if (closePrice <= Number(signal.stop_loss_price || 0)) return '触发止损（A股真实规则）';
    if (closePrice >= Number(signal.take_profit_price || Infinity))
      return '触发止盈（A股真实规则）';
    if (this.diffDays(open.buy_date, currentDate) >= Number(signal.target_holding_days || 20)) {
      return '达到最长持有期（A股真实规则）';
    }
    return '策略退出（A股真实规则）';
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
