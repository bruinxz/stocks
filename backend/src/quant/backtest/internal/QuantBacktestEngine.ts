import { strategyRegistry } from '../../engine/StrategyRegistry';
import { average, maxDrawdownFromValues, pct, round, stddev } from '../../engine/QuantMath';
import {
  QuantBacktestOptions,
  QuantBacktestRejectedOrder,
  QuantBacktestStrategyResult,
  QuantBacktestTradeResult,
  QuantEquityPoint,
  QuantStockContext,
  QuantBar,
} from '../../types/QuantTypes';
import {
  AShareConstraintEngine,
  ConstraintSettings,
  DEFAULT_CONSTRAINT_SETTINGS,
  DEFAULT_FEE_SETTINGS,
  DEFAULT_SLIPPAGE_SETTINGS,
  ExecutionTiming,
  FeeSettings,
  RejectionReason,
  SlippageSettings,
} from '../AShareConstraintEngine';

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

/**
 * 内部执行配置（buildExecutionConfig 把 options 合并成这一份配置）。
 *
 * US-014 后，A 股约束相关字段（T+1 / 涨跌停 / 停牌 / ST / 费率 / 滑点）
 * 不再散落在引擎里，而是组装成 AShareConstraintEngine 的三个 settings 对象,
 * 引擎对外只暴露撮合 / 仓位调度。
 */
interface ExecutionConfig {
  initial_capital: number;
  max_positions: number;
  position_pct: number;
  min_score: number;
  execution_timing: ExecutionTiming;
  lot_size: number;
  max_trade_amount_pct_of_turnover: number;
  /** US-014：A 股约束规则（T+1 / 涨跌停 / 停牌 / ST） */
  constraint_settings: ConstraintSettings;
  /** US-014：费率（佣金 / 印花税 / 过户费） */
  fee_settings: FeeSettings;
  /** US-014：滑点 */
  slippage_settings: SlippageSettings;
}

interface ExecutionDiagnostics {
  execution_timing: ExecutionTiming;
  enable_t_plus_one: boolean;
  block_st_stocks: boolean;
  lot_size: number;
  commission_rate: number;
  min_commission: number;
  stamp_tax_rate: number;
  /** US-014：过户费率（双边） */
  transfer_fee_rate: number;
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
  /** US-014：过户费累计 */
  total_transfer_fee: number;
  total_slippage_cost: number;
  block_reasons: Record<string, number>;
  /** US-014：被 A 股约束引擎拦截的订单数（reject path 走的总笔数） */
  rejected_order_count: number;
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
      // 每个策略一个 constraint 引擎实例 —— constructor 拷贝 settings,
      // 互不干扰；可以在未来支持"按策略 override 部分约束"扩展。
      const constraintEngine = new AShareConstraintEngine(
        config.constraint_settings,
        config.fee_settings,
        config.slippage_settings
      );
      let cash = config.initial_capital;
      const positions = new Map<string, OpenPosition>();
      const pendingOrders: PendingOrder[] = [];
      const pendingExitOrders: PendingExitOrder[] = [];
      const trades: QuantBacktestTradeResult[] = [];
      const rejectedOrders: QuantBacktestRejectedOrder[] = [];
      const equityCurve: QuantEquityPoint[] = [];
      const diagnostics = this.createDiagnostics(config);

      for (const currentDate of dates) {
        this.executePendingExitOrders(
          currentDate,
          pendingExitOrders,
          positions,
          contextBySymbol,
          config,
          constraintEngine,
          diagnostics,
          trades,
          rejectedOrders,
          strategy.definition.strategy_key,
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
          constraintEngine,
          diagnostics,
          rejectedOrders,
          strategy.definition.strategy_key,
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
                constraintEngine,
                diagnostics,
                trades,
                rejectedOrders,
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
            constraintEngine,
            diagnostics,
            rejectedOrders,
            strategy.definition.strategy_key,
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
      diagnostics.total_transfer_fee = round(diagnostics.total_transfer_fee, 4);
      diagnostics.total_slippage_cost = round(diagnostics.total_slippage_cost, 4);
      diagnostics.rejected_order_count = rejectedOrders.length;

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
        rejected_orders: rejectedOrders,
      };
    });
  }

  private buildExecutionConfig(options: QuantBacktestOptions): ExecutionConfig {
    const constraint_settings: ConstraintSettings = {
      enable_t_plus_one: options.enable_t_plus_one !== false,
      block_limit_up: options.block_limit_up !== false,
      block_limit_down: options.block_limit_down !== false,
      block_suspended: options.block_suspended !== false,
      block_st_stocks: options.block_st_stocks !== false,
      limit_up_pct: Number(options.limit_up_pct || DEFAULT_CONSTRAINT_SETTINGS.limit_up_pct),
      limit_down_pct: Number(options.limit_down_pct || DEFAULT_CONSTRAINT_SETTINGS.limit_down_pct),
      min_turnover_yuan: Math.max(Number(options.min_turnover_yuan || 0), 0),
    };
    const fee_settings: FeeSettings = {
      commission_rate: Number(options.commission_rate ?? DEFAULT_FEE_SETTINGS.commission_rate),
      min_commission: Number(options.min_commission ?? DEFAULT_FEE_SETTINGS.min_commission),
      stamp_tax_rate: Number(options.stamp_tax_rate ?? DEFAULT_FEE_SETTINGS.stamp_tax_rate),
      transfer_fee_rate: Number(
        options.transfer_fee_rate ?? DEFAULT_FEE_SETTINGS.transfer_fee_rate
      ),
    };
    const slippage_settings: SlippageSettings = {
      slippage_rate: Number(options.slippage_rate ?? DEFAULT_SLIPPAGE_SETTINGS.slippage_rate),
      dynamic: options.dynamic_slippage !== false,
    };
    return {
      initial_capital: Number(options.initial_capital || 200000),
      max_positions: Number(options.max_positions || 8),
      position_pct: Number(options.position_pct || 10) / 100,
      min_score: Number(options.min_score || 68),
      execution_timing: (options.execution_timing as ExecutionTiming) || 'next_open',
      lot_size: Math.max(Number(options.lot_size || 100), 1),
      max_trade_amount_pct_of_turnover: Math.max(
        Number(options.max_trade_amount_pct_of_turnover || 1),
        0.01
      ),
      constraint_settings,
      fee_settings,
      slippage_settings,
    };
  }

  private createDiagnostics(config: ExecutionConfig): ExecutionDiagnostics {
    return {
      execution_timing: config.execution_timing,
      enable_t_plus_one: config.constraint_settings.enable_t_plus_one,
      block_st_stocks: config.constraint_settings.block_st_stocks,
      lot_size: config.lot_size,
      commission_rate: config.fee_settings.commission_rate,
      min_commission: config.fee_settings.min_commission,
      stamp_tax_rate: config.fee_settings.stamp_tax_rate,
      transfer_fee_rate: config.fee_settings.transfer_fee_rate,
      base_slippage_rate: config.slippage_settings.slippage_rate,
      dynamic_slippage: config.slippage_settings.dynamic,
      min_turnover_yuan: config.constraint_settings.min_turnover_yuan,
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
      total_transfer_fee: 0,
      total_slippage_cost: 0,
      block_reasons: {},
      rejected_order_count: 0,
    };
  }

  private executePendingExitOrders(
    currentDate: string,
    pendingExitOrders: PendingExitOrder[],
    positions: Map<string, OpenPosition>,
    contextBySymbol: Map<string, QuantStockContext>,
    config: ExecutionConfig,
    constraintEngine: AShareConstraintEngine,
    diagnostics: ExecutionDiagnostics,
    trades: QuantBacktestTradeResult[],
    rejectedOrders: QuantBacktestRejectedOrder[],
    strategy_key: string,
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
        addBlock(diagnostics, 'sell', RejectionReason.NEXT_EXIT_BAR_MISSING);
        rejectedOrders.push({
          trade_date: currentDate,
          strategy_key,
          symbol: order.symbol,
          name: context.name,
          side: 'sell',
          reason: RejectionReason.NEXT_EXIT_BAR_MISSING,
          detail: '次日 bar 缺失，无法执行 pending 退出单',
        });
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
        constraintEngine,
        diagnostics,
        trades,
        rejectedOrders,
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
    constraintEngine: AShareConstraintEngine,
    diagnostics: ExecutionDiagnostics,
    rejectedOrders: QuantBacktestRejectedOrder[],
    strategy_key: string,
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
      constraintEngine,
      diagnostics,
      rejectedOrders,
      strategy_key,
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
    constraintEngine: AShareConstraintEngine,
    diagnostics: ExecutionDiagnostics,
    rejectedOrders: QuantBacktestRejectedOrder[],
    strategy_key: string,
    applyCashPatch: (delta: number) => void,
    getCash: () => number
  ) {
    candidates.sort((a, b) => b.ranking_score - a.ranking_score);
    for (const candidate of candidates) {
      diagnostics.buy_attempt_count += 1;
      if (positions.size >= config.max_positions) {
        addBlock(diagnostics, 'buy', RejectionReason.MAX_POSITIONS);
        rejectedOrders.push({
          trade_date: currentDate,
          strategy_key,
          symbol: candidate.context.symbol,
          name: candidate.context.name,
          side: 'buy',
          reason: RejectionReason.MAX_POSITIONS,
          detail: `已持仓 ${positions.size} ≥ 上限 ${config.max_positions}`,
        });
        continue;
      }
      if (positions.has(candidate.context.symbol)) {
        addBlock(diagnostics, 'buy', RejectionReason.ALREADY_HOLDING);
        rejectedOrders.push({
          trade_date: currentDate,
          strategy_key,
          symbol: candidate.context.symbol,
          name: candidate.context.name,
          side: 'buy',
          reason: RejectionReason.ALREADY_HOLDING,
        });
        continue;
      }
      const context = contextBySymbol.get(candidate.context.symbol) || candidate.context;
      const bar = context.bars.find(item => dateOnly(item.time) === currentDate);
      if (!bar) {
        addBlock(diagnostics, 'buy', RejectionReason.NEXT_BAR_MISSING);
        rejectedOrders.push({
          trade_date: currentDate,
          strategy_key,
          symbol: context.symbol,
          name: context.name,
          side: 'buy',
          reason: RejectionReason.NEXT_BAR_MISSING,
          detail: '次日 bar 缺失，无法执行 pending 买入单',
        });
        continue;
      }
      const evaluation = constraintEngine.evaluateOrder({
        side: 'buy',
        bar,
        stock_name: context.name,
        trade_date: currentDate,
      });
      if (!evaluation.ok) {
        const reason = evaluation.reason || 'buy_blocked';
        addBlock(diagnostics, 'buy', reason);
        rejectedOrders.push({
          trade_date: currentDate,
          strategy_key,
          symbol: context.symbol,
          name: context.name,
          side: 'buy',
          reason,
          detail: evaluation.detail,
          reference_price: Number(bar.close || bar.open) || null,
        });
        continue;
      }
      const buyExecution = constraintEngine.executionPrice(bar, 'buy', config.execution_timing);
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
        addBlock(diagnostics, 'buy', RejectionReason.LOT_OR_CASH_TOO_SMALL);
        rejectedOrders.push({
          trade_date: currentDate,
          strategy_key,
          symbol: context.symbol,
          name: context.name,
          side: 'buy',
          reason: RejectionReason.LOT_OR_CASH_TOO_SMALL,
          detail: `目标金额 ${targetAmount.toFixed(2)} 元不足以买入 1 手 (${
            config.lot_size
          } 股 @ ${buyPrice.toFixed(2)} 元)`,
          reference_price: buyPrice,
        });
        continue;
      }
      const amount = quantity * buyPrice;
      const fees = constraintEngine.computeFees(amount, 'buy');
      if (Number.isFinite(cash) && amount + fees.total_cost > cash) {
        addBlock(diagnostics, 'buy', RejectionReason.CASH_NOT_ENOUGH);
        rejectedOrders.push({
          trade_date: currentDate,
          strategy_key,
          symbol: context.symbol,
          name: context.name,
          side: 'buy',
          reason: RejectionReason.CASH_NOT_ENOUGH,
          detail: `所需 ${(amount + fees.total_cost).toFixed(2)} 元 > 现金 ${cash.toFixed(2)} 元`,
          reference_price: buyPrice,
        });
        continue;
      }
      applyCashPatch(-(amount + fees.total_cost));
      diagnostics.buy_fill_count += 1;
      diagnostics.total_commission += fees.commission;
      diagnostics.total_transfer_fee += fees.transfer_fee;
      diagnostics.total_slippage_cost += buyExecution.slippage_cost * quantity;
      positions.set(candidate.context.symbol, {
        symbol: candidate.context.symbol,
        name: candidate.context.name,
        quantity,
        buy_price: buyPrice,
        buy_date: currentDate,
        entry_reason: (candidate.signal.reasons || []).slice(0, 2).join('；'),
        // 买入时的佣金 + 过户费一并记入 buy_commission，便于 sell 时计算净 PnL
        buy_commission: fees.commission + fees.transfer_fee,
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
    constraintEngine: AShareConstraintEngine;
    diagnostics: ExecutionDiagnostics;
    trades: QuantBacktestTradeResult[];
    rejectedOrders: QuantBacktestRejectedOrder[];
    applyCashPatch: (delta: number) => void;
  }) {
    const open = options.positions.get(options.context.symbol);
    if (!open) return;
    options.diagnostics.sell_attempt_count += 1;

    const evaluation = options.constraintEngine.evaluateOrder({
      side: 'sell',
      bar: options.bar,
      stock_name: options.context.name,
      buy_date: open.buy_date,
      trade_date: options.currentDate,
    });
    if (!evaluation.ok) {
      const reason = evaluation.reason || 'sell_blocked';
      addBlock(options.diagnostics, 'sell', reason);
      options.rejectedOrders.push({
        trade_date: options.currentDate,
        strategy_key: options.strategy_key,
        symbol: options.context.symbol,
        name: options.context.name,
        side: 'sell',
        reason,
        detail: evaluation.detail,
        reference_price: Number(options.bar.close || options.bar.open) || null,
      });
      return;
    }

    const executionPrice = options.constraintEngine.executionPrice(
      options.bar,
      'sell',
      options.config.execution_timing
    );
    const sellPrice = executionPrice.price;
    const amount = sellPrice * open.quantity;
    const fees = options.constraintEngine.computeFees(amount, 'sell');
    const pnl =
      amount - fees.total_cost - open.buy_price * open.quantity - (open.buy_commission || 0);

    options.applyCashPatch(amount - fees.total_cost);
    options.diagnostics.sell_fill_count += 1;
    options.diagnostics.total_commission += fees.commission;
    options.diagnostics.total_stamp_tax += fees.stamp_tax;
    options.diagnostics.total_transfer_fee += fees.transfer_fee;
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

  private maxAmountByTurnover(bar: QuantBar, config: ExecutionConfig) {
    const turnover = this.resolveTurnover(bar);
    if (turnover <= 0) return Number.POSITIVE_INFINITY;
    return turnover * (config.max_trade_amount_pct_of_turnover / 100);
  }

  private resolveTurnover(bar: QuantBar): number {
    const persistedTurnover = Number(bar.turnover ?? bar.amount ?? 0);
    if (Number.isFinite(persistedTurnover) && persistedTurnover > 0) return persistedTurnover;

    const volume = Number(bar.volume || 0);
    const close = Number(bar.close || bar.open || 0);
    if (volume > 0 && close > 0) return volume * close;
    return 0;
  }

  private isSuspended(bar: QuantBar): boolean {
    const volume = Number(bar.volume || 0);
    const turnover = this.resolveTurnover(bar);
    return volume <= 0 && turnover <= 0;
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
