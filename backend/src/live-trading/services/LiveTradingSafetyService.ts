export const LIVE_ORDER_CONFIRM_TEXT = 'CONFIRM_LIVE_ORDER';

function envBool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function numberEnv(name: string, fallback: number): number {
  const num = Number(process.env[name]);
  return Number.isFinite(num) ? num : fallback;
}

export class LiveTradingSafetyService {
  getStatus() {
    const live_trading_enabled = envBool('LIVE_TRADING_ENABLED', false);
    const live_order_execution_enabled = envBool('LIVE_ORDER_EXECUTION_ENABLED', false);
    const live_readonly_enabled = envBool('LIVE_READONLY_ENABLED', false);
    const broker_gateway = process.env.LIVE_BROKER_GATEWAY || 'mock_guarded';
    const market_data_provider = process.env.LIVE_MARKET_DATA_PROVIDER || 'database_realtime_quotes';
    const global_kill_switch = envBool('LIVE_TRADING_KILL_SWITCH', true);
    const allowSandbox = envBool('LIVE_TRADING_SANDBOX_ENABLED', false);
    const shadowAutopilotEnabled = envBool('LIVE_SHADOW_AUTOPILOT_ENABLED', true);
    const can_submit_orders =
      live_trading_enabled &&
      live_order_execution_enabled &&
      !global_kill_switch &&
      broker_gateway !== 'mock_guarded';
    const unattended_real_order_allowed = false;

    const blockers: string[] = [];
    if (!live_trading_enabled) blockers.push('LIVE_TRADING_ENABLED 未开启');
    if (!live_order_execution_enabled) blockers.push('LIVE_ORDER_EXECUTION_ENABLED 未开启');
    if (global_kill_switch) blockers.push('LIVE_TRADING_KILL_SWITCH 处于熔断状态');
    if (broker_gateway === 'mock_guarded') blockers.push('当前仍使用安全占位券商网关');

    return {
      mode: can_submit_orders ? 'approval_execution_enabled' : live_readonly_enabled ? 'read_only' : 'simulation_only',
      live_trading_enabled,
      live_readonly_enabled,
      live_order_execution_enabled,
      global_kill_switch,
      can_submit_orders,
      can_sync_account: live_readonly_enabled || can_submit_orders,
      broker_gateway,
      market_data_provider,
      sandbox_enabled: allowSandbox,
      shadow_autopilot_enabled: shadowAutopilotEnabled,
      unattended_real_order_allowed,
      confirm_text_required: LIVE_ORDER_CONFIRM_TEXT,
      external_use_allowed: false,
      compliance_state: can_submit_orders ? 'restricted_internal_only' : 'safe_disabled',
      default_risk_limits: this.getDefaultRiskLimits(),
      blockers,
      warnings: [
        '当前系统默认禁止无人确认真实下单。',
        '对外商业化前必须接入授权行情源、持牌/合规券商通道、用户适当性与风险揭示。',
        '所有实盘订单必须经过用户确认、风控校验和审计留痕。',
      ],
      unattended_policy: {
        real_order_submission: 'blocked',
        shadow_execution: shadowAutopilotEnabled ? 'enabled' : 'disabled',
        conclusion: shadowAutopilotEnabled
          ? '可以跳过人工确认做影子执行/模拟闭环；真实券商委托仍不可无人确认提交。'
          : '无人确认影子执行已关闭；真实券商委托仍不可无人确认提交。',
      },
      updated_at: new Date().toISOString(),
    };
  }

  getDefaultRiskLimits() {
    return {
      max_single_order_pct: numberEnv('LIVE_RISK_MAX_SINGLE_ORDER_PCT', 5),
      max_single_position_pct: numberEnv('LIVE_RISK_MAX_SINGLE_POSITION_PCT', 10),
      max_total_exposure_pct: numberEnv('LIVE_RISK_MAX_TOTAL_EXPOSURE_PCT', 60),
      max_daily_new_exposure_pct: numberEnv('LIVE_RISK_MAX_DAILY_NEW_EXPOSURE_PCT', 15),
      max_daily_order_count: numberEnv('LIVE_RISK_MAX_DAILY_ORDER_COUNT', 5),
      price_deviation_guard_pct: numberEnv('LIVE_RISK_PRICE_DEVIATION_GUARD_PCT', 1.5),
      block_st: true,
      block_limit_up_buy: true,
      require_liquidity_check: true,
      require_user_confirmation: true,
    };
  }

  getMarketDataSla() {
    return {
      max_quote_latency_seconds: numberEnv('LIVE_MARKET_QUOTE_MAX_LATENCY_SECONDS', 15 * 60),
      max_missing_quote_ratio_pct: numberEnv('LIVE_MARKET_MAX_MISSING_QUOTE_RATIO_PCT', 10),
      require_quote_before_order: envBool('LIVE_MARKET_REQUIRE_QUOTE_BEFORE_ORDER', true),
      require_realtime_for_order: envBool('LIVE_MARKET_REQUIRE_REALTIME_FOR_ORDER', true),
      licensed_provider_required_for_external_use: true,
    };
  }

  assertOrderExecutionAllowed(confirmText?: string) {
    const status = this.getStatus();
    if (confirmText !== LIVE_ORDER_CONFIRM_TEXT) {
      throw new Error(`实盘下单必须输入强确认文本 ${LIVE_ORDER_CONFIRM_TEXT}`);
    }
    if (!status.can_submit_orders) {
      throw new Error(`实盘下单被安全边界阻断：${status.blockers.join('；')}`);
    }
    return status;
  }
}

export const liveTradingSafetyService = new LiveTradingSafetyService();
