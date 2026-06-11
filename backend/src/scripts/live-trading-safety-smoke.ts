import { LiveTradingSafetyService } from '../live-trading/services/LiveTradingSafetyService';

const originalEnv = { ...process.env };

function resetEnv() {
  process.env = { ...originalEnv };
  delete process.env.LIVE_TRADING_ENABLED;
  delete process.env.LIVE_ORDER_EXECUTION_ENABLED;
  delete process.env.LIVE_TRADING_KILL_SWITCH;
  delete process.env.LIVE_READONLY_ENABLED;
  delete process.env.LIVE_BROKER_GATEWAY;
  delete process.env.LIVE_MARKET_DATA_PROVIDER;
  delete process.env.LIVE_LICENSED_PROVIDER_REQUIRED_FOR_LIVE_ORDER;
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function runBridgeReadonlyGuard() {
  resetEnv();
  process.env.LIVE_TRADING_ENABLED = 'true';
  process.env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_KILL_SWITCH = 'false';
  process.env.LIVE_BROKER_GATEWAY = 'bridge_readonly';

  const status = new LiveTradingSafetyService().getStatus({
    broker_key: 'bridge_readonly',
    trading_supported: false,
  });

  assert(!status.can_submit_orders, 'bridge_readonly must never allow live order submission');
  assert(!status.broker_gateway_trading_allowed, 'bridge_readonly should not be in trading allowlist');
  assert(
    status.blockers.join('；').includes('不在真实交易允许列表'),
    'bridge_readonly should report allowlist blocker'
  );
}

function runGatewayCapabilityGuard() {
  resetEnv();
  process.env.LIVE_TRADING_ENABLED = 'true';
  process.env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_KILL_SWITCH = 'false';
  process.env.LIVE_BROKER_GATEWAY = 'qmt_bridge';
  // 不影响本用例：先把持牌闸门关掉，专注 capability 检查
  process.env.LIVE_LICENSED_PROVIDER_REQUIRED_FOR_LIVE_ORDER = 'false';

  const blocked = new LiveTradingSafetyService().getStatus({
    broker_key: 'qmt_bridge',
    trading_supported: false,
  });
  const allowed = new LiveTradingSafetyService().getStatus({
    broker_key: 'qmt_bridge',
    trading_supported: true,
  });

  assert(!blocked.can_submit_orders, 'qmt_bridge without trading capability must be blocked');
  assert(
    blocked.blockers.join('；').includes('能力声明不支持真实交易'),
    'qmt_bridge without capability should report capability blocker'
  );
  assert(allowed.can_submit_orders, 'qmt_bridge with trading capability and open switches should be allowed');
}

function runKillSwitchStillBlocksGuard() {
  // 回归用例：即便网关 + capability 都通过，只要 kill switch 处于熔断（默认 true），
  // 也绝对不能放行真实下单。这是最容易因为 .env 漏配而被忽略的回归路径。
  resetEnv();
  process.env.LIVE_TRADING_ENABLED = 'true';
  process.env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_BROKER_GATEWAY = 'qmt_bridge';
  // 故意不设置 LIVE_TRADING_KILL_SWITCH，让它走默认 true

  const status = new LiveTradingSafetyService().getStatus({
    broker_key: 'qmt_bridge',
    trading_supported: true,
  });

  assert(status.global_kill_switch, 'kill switch must default to true when env missing');
  assert(!status.can_submit_orders, 'kill switch must block even when gateway+capability are OK');
  assert(
    status.blockers.join('；').includes('熔断'),
    'kill switch blocker should be reported in blockers list'
  );
}

function runGatewayAllowlistAuditGuard() {
  // 回归用例：env_readonly / bridge_readonly / mock_guarded 永远不能进入真实下单路径
  for (const gateway of ['env_readonly', 'bridge_readonly', 'mock_guarded']) {
    resetEnv();
    process.env.LIVE_TRADING_ENABLED = 'true';
    process.env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
    process.env.LIVE_TRADING_KILL_SWITCH = 'false';
    process.env.LIVE_BROKER_GATEWAY = gateway;
    process.env.LIVE_LICENSED_PROVIDER_REQUIRED_FOR_LIVE_ORDER = 'false';
    // 即使 capability 谎称支持也必须被 allowlist 拦下
    const status = new LiveTradingSafetyService().getStatus({
      broker_key: gateway,
      trading_supported: true,
    });
    assert(
      !status.can_submit_orders,
      `${gateway} must never enter live trading path even when capability lies`
    );
    assert(
      !status.broker_gateway_trading_allowed,
      `${gateway} must not be in trading allowlist`
    );
  }
}

function runLicensedProviderGuard() {
  // 回归用例：默认要求持牌行情源，非持牌源即便其他开关都开也必须 block
  resetEnv();
  process.env.LIVE_TRADING_ENABLED = 'true';
  process.env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_KILL_SWITCH = 'false';
  process.env.LIVE_BROKER_GATEWAY = 'qmt_bridge';
  // 持牌闸门走默认 true，provider 缺省 database_realtime_quotes（非持牌）

  const blocked = new LiveTradingSafetyService().getStatus({
    broker_key: 'qmt_bridge',
    trading_supported: true,
  });
  assert(blocked.licensed_provider_required, 'licensed provider gate should default to required');
  assert(!blocked.licensed_provider_satisfied, 'default provider should not satisfy licensed gate');
  assert(!blocked.can_submit_orders, 'live order must be blocked when non-licensed provider is used');
  assert(
    blocked.blockers.join('；').includes('持牌闸门阻断'),
    'licensed provider blocker should be reported'
  );

  // 切到 licensed_configured 即可放行
  process.env.LIVE_MARKET_DATA_PROVIDER = 'licensed_configured';
  const allowed = new LiveTradingSafetyService().getStatus({
    broker_key: 'qmt_bridge',
    trading_supported: true,
  });
  assert(allowed.licensed_provider_satisfied, 'licensed_configured must satisfy gate');
  assert(allowed.can_submit_orders, 'licensed_configured with all switches on should be allowed');

  // 显式关闭持牌要求（内部联调）也能放行，但 licensed_provider_required=false
  resetEnv();
  process.env.LIVE_TRADING_ENABLED = 'true';
  process.env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_KILL_SWITCH = 'false';
  process.env.LIVE_BROKER_GATEWAY = 'qmt_bridge';
  process.env.LIVE_LICENSED_PROVIDER_REQUIRED_FOR_LIVE_ORDER = 'false';
  const internal = new LiveTradingSafetyService().getStatus({
    broker_key: 'qmt_bridge',
    trading_supported: true,
  });
  assert(!internal.licensed_provider_required, 'gate can be disabled for internal testing');
  assert(internal.can_submit_orders, 'with gate disabled and other switches on should be allowed');
}

function runDbKillSwitchInjectionGuard() {
  // 回归用例：即便环境变量 kill switch 关闭，DB 注入的活跃 kill switch 也必须挡住下单。
  resetEnv();
  process.env.LIVE_TRADING_ENABLED = 'true';
  process.env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_KILL_SWITCH = 'false';
  process.env.LIVE_BROKER_GATEWAY = 'qmt_bridge';
  process.env.LIVE_LICENSED_PROVIDER_REQUIRED_FOR_LIVE_ORDER = 'false';

  const svc = new LiveTradingSafetyService();
  const capability = { broker_key: 'qmt_bridge', trading_supported: true } as const;

  const noKill = svc.getStatus(capability);
  assert(noKill.can_submit_orders, 'baseline: env-only path should allow submit when all switches OK');
  assert(!noKill.db_kill_switch, 'no DB kill switch by default');

  const withKill = svc.getStatus(capability, {
    active: true,
    reason_code: 'order_failure_streak',
    reason_detail: 'mocked: 3 failures in a row',
    source: 'auto',
  });
  assert(withKill.db_kill_switch, 'db_kill_switch must be true when DB state injected');
  assert(withKill.global_kill_switch, 'global_kill_switch must be true when either side trips');
  assert(!withKill.can_submit_orders, 'DB kill switch must block submit');
  assert(
    withKill.blockers.join('；').includes('kill switch 已自动触发'),
    'DB kill switch should produce a clear blocker message'
  );
}

runBridgeReadonlyGuard();
runGatewayCapabilityGuard();
runKillSwitchStillBlocksGuard();
runGatewayAllowlistAuditGuard();
runLicensedProviderGuard();
runDbKillSwitchInjectionGuard();
resetEnv();

console.log('Live trading safety smoke passed');
