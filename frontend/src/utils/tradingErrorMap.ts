/**
 * Trading error code → user-friendly Chinese message + action hint.
 * Batch L (2026-06-17).
 *
 * 后端 facade.placeOrder / runRiskCheck 抛 err.code:
 *   - NON_TRADING_HOURS_HOLIDAY / NON_TRADING_HOURS_OFF_HOURS
 *   - DRAWDOWN_BREAKER_PAUSED
 *   - POSITION_LIMIT_VIOLATION
 *   - T_PLUS_1_VIOLATION
 *   - PER_STOCK_STOP_LOSS_PAUSED
 *   - PORTFOLIO_NOT_FOUND / PORTFOLIO_NOT_FOUND_OR_FORBIDDEN
 *   - INSUFFICIENT_FUNDS / INSUFFICIENT_HOLDING
 *   - INVALID_PARAMS / INVALID_DIRECTION / PRICE_UNAVAILABLE / NO_POSITION
 *
 * 之前前端只 message.error(err.response.data.message) 直接展示原始 string.
 * 现在加 friendly 翻译 + UX action hint (按钮 disable / 跳转配置 / 等待时段).
 */

export interface TradingErrorInfo {
  code: string;
  title: string;
  hint?: string;
  /** 是否建议 disable 按钮一段时间 (T+1 / 非交易时段). */
  disableUntilNextTradingDay?: boolean;
}

const ERROR_CODE_MAP: Record<string, TradingErrorInfo> = {
  NON_TRADING_HOURS_HOLIDAY: {
    code: 'NON_TRADING_HOURS_HOLIDAY',
    title: '今天不是交易日',
    hint: 'A 股节假日 / 周末不开市，明日开盘后再试。',
    disableUntilNextTradingDay: true,
  },
  NON_TRADING_HOURS_OFF_HOURS: {
    code: 'NON_TRADING_HOURS_OFF_HOURS',
    title: '已经收盘 / 不在交易时段',
    hint: 'A 股 09:30-11:30 / 13:00-15:00 才能下单。等下个时段再试。',
  },
  DRAWDOWN_BREAKER_PAUSED: {
    code: 'DRAWDOWN_BREAKER_PAUSED',
    title: '组合回撤熔断中',
    hint: '账户回撤超过 LEVEL_1 阈值（默认 10%），24 小时内禁止新开仓。可继续加仓已有持仓 / 卖出。如需提前解除，前往 风控告警 页或联系管理员。',
  },
  POSITION_LIMIT_VIOLATION: {
    code: 'POSITION_LIMIT_VIOLATION',
    title: '触发仓位上限',
    hint: '单股 / 行业 / 总持仓上限不允许本次下单。前往 风控配置 → 仓位限制 查看并调整。',
  },
  T_PLUS_1_VIOLATION: {
    code: 'T_PLUS_1_VIOLATION',
    title: 'T+1 限制',
    hint: 'A 股当日买入的股份不能当日卖出，明日开盘可平仓。',
    disableUntilNextTradingDay: true,
  },
  PER_STOCK_STOP_LOSS_PAUSED: {
    code: 'PER_STOCK_STOP_LOSS_PAUSED',
    title: '该股触发个股止损暂停',
    hint: '该股在止损 cooldown 期内禁止重新买入，避免反复止损来回交易。',
  },
  PORTFOLIO_NOT_FOUND: {
    code: 'PORTFOLIO_NOT_FOUND',
    title: '模拟盘不存在',
    hint: '请刷新页面或从顶部下拉重新选择模拟盘。',
  },
  PORTFOLIO_NOT_FOUND_OR_FORBIDDEN: {
    code: 'PORTFOLIO_NOT_FOUND_OR_FORBIDDEN',
    title: '模拟盘不存在或无权访问',
    hint: '该模拟盘可能不属于当前账户或已停用。请从顶部下拉重新选择。',
  },
  INSUFFICIENT_FUNDS: {
    code: 'INSUFFICIENT_FUNDS',
    title: '可用资金不足',
    hint: '降低买入数量、释放部分持仓后再试。',
  },
  INSUFFICIENT_HOLDING: {
    code: 'INSUFFICIENT_HOLDING',
    title: '持仓不足',
    hint: '卖出数量超出持仓量。可在持仓表查看可卖份额。',
  },
  INVALID_PARAMS: {
    code: 'INVALID_PARAMS',
    title: '交易参数不合法',
    hint: '请检查 symbol / direction / quantity 是否填写正确（quantity 应为 100 整数倍）。',
  },
  INVALID_DIRECTION: {
    code: 'INVALID_DIRECTION',
    title: '交易方向不合法',
    hint: '只接受 BUY / SELL。',
  },
  PRICE_UNAVAILABLE: {
    code: 'PRICE_UNAVAILABLE',
    title: '无法获取该股票价格',
    hint: '可能停牌或数据延迟。请稍后再试。',
  },
  NO_POSITION: {
    code: 'NO_POSITION',
    title: '当前无该持仓',
    hint: '无法对未持有股票执行平仓操作。',
  },
};

/**
 * 把后端错误对象（axios error.response.data）翻译成可读 title + hint.
 * 不识别的 code 透传 message 即可.
 */
export function translateTradingError(errorBody: any): TradingErrorInfo {
  const code = errorBody?.code || errorBody?.data?.code;
  if (code && ERROR_CODE_MAP[code]) {
    return ERROR_CODE_MAP[code];
  }
  return {
    code: code || 'UNKNOWN',
    title: errorBody?.message || '操作失败',
  };
}

/**
 * 直接从 axios error 拿 friendly info. message 标题作为主提示, hint 作为副提示.
 */
export function translateAxiosTradingError(err: any): TradingErrorInfo {
  return translateTradingError(err?.response?.data);
}
