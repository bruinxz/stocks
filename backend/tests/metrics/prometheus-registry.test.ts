/**
 * PrometheusRegistry 单元测试 (US-072 运维：Prometheus 指标埋点)
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/metrics/prometheus-registry.test.ts
 *
 * 完全脱离生产 singleton (每个测试自己构造 createPrometheusRegistry())。
 *
 * 覆盖维度：
 *   - 纯函数：
 *     - normalizeMethodLabel (字符串大小写 / 空 / 非字符串)
 *     - normalizeStatusLabel (数字 / 0 / NaN / 字符串 / 负数)
 *     - resolveRouteLabel (route.path + baseUrl / 仅 baseUrl / 都没有 / route 缺 path)
 *   - createPrometheusRegistry：
 *     - 4 个 AC 要求的 metric 全部已注册
 *     - metric label names 完整 (cardinality 隔离)
 *     - 同名 metric 不能在同 registry 重复注册 (prom-client 内置约束)
 *   - 业务 helper：
 *     - incrementBacktestTotal(strategy, success) → counter +1
 *     - incrementBacktestTotal(strategy, failed) → counter +1
 *     - observeAIRequestDuration → histogram count +1 + sum +seconds
 *     - observeAIRequestDuration 负 duration → no observe
 *     - incrementOrderTotal(direction, success, code) → counter +1
 *     - incrementOrderTotal 失败 code 透传
 *   - middleware httpMetricsMiddleware：
 *     - 单次 GET → http_requests_total{method=GET,route='/api/x',status='200'} +1
 *     - POST → method=POST
 *     - status=404 / 500 不丢
 *     - route 缺失 → 'unmatched'
 *   - /metrics 输出 Prometheus text format：
 *     - getMetricsContent() 含 4 个 metric 的 # HELP / # TYPE 行
 *     - getMetricsContentType() 返回 'text/plain; version=0.0.4; charset=utf-8'
 *   - default metrics（process_cpu_user_seconds_total / nodejs_heap）启用时存在
 *   - US-004 [OPS-004] 标准化:
 *     - recordSchedulerTaskRun 三 status (success/failed/skipped) + counter/histogram 隔离
 *     - 无效 duration (负/NaN) counter 仍 inc 但 histogram 不 observe (主流程鲁棒)
 *     - 空 task_type → 'unknown' (cardinality 守门)
 *     - AC: 启 enableDefaultMetrics 后 ≥20 metric 在 /metrics 可见 (26 默认 + 7 业务)
 *     - 新增 scheduler_task_runs_total / scheduler_task_duration_seconds 遵循
 *       `<domain>_<verb>_<unit>` 约定 (scheduler / runs+duration / total+seconds)
 *
 * 与既有 67 个 test (US-068+) 一样：assert / assertEqual / async main / process.exit code.
 */

import {
  PrometheusMetricsBundle,
  createPrometheusRegistry,
  getMetricsContent,
  getMetricsContentType,
  httpMetricsMiddleware,
  incrementBacktestTotal,
  incrementOrderTotal,
  normalizeMethodLabel,
  normalizeStatusLabel,
  observeAIRequestDuration,
  recordSchedulerTaskRun,
  resolveRouteLabel,
} from '../../src/metrics/PrometheusRegistry';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
//  Pure helpers
// ---------------------------------------------------------------------------

async function testNormalizeMethodLabel(): Promise<void> {
  assertEqual('lowercase get → GET', normalizeMethodLabel('get'), 'GET');
  assertEqual('uppercase POST stays POST', normalizeMethodLabel('POST'), 'POST');
  assertEqual('mixed Put → PUT', normalizeMethodLabel('Put'), 'PUT');
  assertEqual('empty string → UNKNOWN', normalizeMethodLabel(''), 'UNKNOWN');
  assertEqual('undefined → UNKNOWN', normalizeMethodLabel(undefined), 'UNKNOWN');
  assertEqual('null → UNKNOWN', normalizeMethodLabel(null), 'UNKNOWN');
  assertEqual('number → UNKNOWN', normalizeMethodLabel(42), 'UNKNOWN');
}

async function testNormalizeStatusLabel(): Promise<void> {
  assertEqual('status 200 → "200"', normalizeStatusLabel(200), '200');
  assertEqual('status 404 → "404"', normalizeStatusLabel(404), '404');
  assertEqual('status 500 → "500"', normalizeStatusLabel(500), '500');
  assertEqual('status 0 → unknown', normalizeStatusLabel(0), 'unknown');
  assertEqual('status NaN → unknown', normalizeStatusLabel(NaN), 'unknown');
  assertEqual('status Infinity → unknown', normalizeStatusLabel(Infinity), 'unknown');
  assertEqual('status negative → unknown', normalizeStatusLabel(-1), 'unknown');
  assertEqual('status undefined → unknown', normalizeStatusLabel(undefined), 'unknown');
  assertEqual('status string → unknown', normalizeStatusLabel('200'), 'unknown');
}

async function testResolveRouteLabel(): Promise<void> {
  // happy path: 已挂载 + 路由匹配 → baseUrl + route.path
  assertEqual(
    'baseUrl=/api/portfolio + route.path=/:id → /api/portfolio/:id',
    resolveRouteLabel({ route: { path: '/:id' } as any, baseUrl: '/api/portfolio', path: '/42' }),
    '/api/portfolio/:id'
  );

  // 顶层 route（无 baseUrl）
  assertEqual(
    'no baseUrl + route.path=/health → /health',
    resolveRouteLabel({ route: { path: '/health' } as any, baseUrl: '', path: '/health' }),
    '/health'
  );

  // 只匹配到挂载，没匹配到具体 endpoint
  assertEqual(
    'baseUrl only → baseUrl',
    resolveRouteLabel({ route: undefined as any, baseUrl: '/api/unknown', path: '/api/unknown/x' }),
    '/api/unknown'
  );

  // 都没有 → unmatched
  assertEqual(
    'no route + no baseUrl → unmatched',
    resolveRouteLabel({ route: undefined as any, baseUrl: '', path: '/anything' }),
    'unmatched'
  );

  // route 对象存在但没 path 字段 → 退回 baseUrl / unmatched
  assertEqual(
    'route without path + baseUrl → baseUrl',
    resolveRouteLabel({ route: {} as any, baseUrl: '/api/x', path: '/api/x/y' }),
    '/api/x'
  );

  // 极端 cardinality 防御：路径含 user_id 不应泄漏
  const url = '/api/portfolio/12345?token=secret';
  const result = resolveRouteLabel({
    route: { path: '/:id' } as any,
    baseUrl: '/api/portfolio',
    path: url,
  });
  assert(
    'label should not contain user_id 12345 (route template only)',
    !result.includes('12345'),
    `result=${result}`
  );
  assert(
    'label should not contain query string',
    !result.includes('token'),
    `result=${result}`
  );
}

// ---------------------------------------------------------------------------
//  createPrometheusRegistry — metric registration
// ---------------------------------------------------------------------------

async function testCreateRegistry(): Promise<void> {
  const bundle = createPrometheusRegistry();
  assert('registry exists', !!bundle.registry);
  assert('httpRequestsTotal exists', !!bundle.httpRequestsTotal);
  assert('backtestTotal exists', !!bundle.backtestTotal);
  assert('aiRequestDurationSeconds exists', !!bundle.aiRequestDurationSeconds);
  assert('orderTotal exists', !!bundle.orderTotal);

  // 所有 4 个 metric 都已在 registry 中可查到
  assert(
    'registry has http_requests_total',
    !!bundle.registry.getSingleMetric('http_requests_total')
  );
  assert('registry has backtest_total', !!bundle.registry.getSingleMetric('backtest_total'));
  assert(
    'registry has ai_request_duration_seconds',
    !!bundle.registry.getSingleMetric('ai_request_duration_seconds')
  );
  assert('registry has order_total', !!bundle.registry.getSingleMetric('order_total'));

  // 不能在同 registry 重复注册（prom-client 内置约束）
  let threw = false;
  try {
    // 直接构造同名 counter 注入同一 registry 应该抛
    const promClient = await import('prom-client');
    new promClient.Counter({
      name: 'http_requests_total',
      help: 'duplicate',
      registers: [bundle.registry],
    });
  } catch {
    threw = true;
  }
  assert('duplicate registration throws', threw);
}

async function testDefaultMetricsToggle(): Promise<void> {
  const withDefaults = createPrometheusRegistry({ enableDefaultMetrics: true });
  const text = await withDefaults.registry.metrics();
  assert(
    'default metrics emit process_cpu_user_seconds_total',
    text.includes('process_cpu_user_seconds_total'),
    `len=${text.length}`
  );
  assert(
    'default metrics emit nodejs_heap_size_total_bytes',
    text.includes('nodejs_heap_size_total_bytes')
  );

  const without = createPrometheusRegistry();
  const text2 = await without.registry.metrics();
  assert(
    'no default metrics by default',
    !text2.includes('process_cpu_user_seconds_total'),
    `len=${text2.length}`
  );
}

// ---------------------------------------------------------------------------
//  Business helpers — increment/observe
// ---------------------------------------------------------------------------

async function metricValue(
  bundle: PrometheusMetricsBundle,
  metricName: string,
  labels: Record<string, string>
): Promise<number> {
  const json = await bundle.registry.getMetricsAsJSON();
  const m = json.find(x => x.name === metricName);
  if (!m) return 0;
  const v = (m as any).values?.find((entry: any) => {
    for (const k of Object.keys(labels)) {
      if (String(entry.labels?.[k]) !== labels[k]) return false;
    }
    return true;
  });
  return v?.value || 0;
}

async function testIncrementBacktestTotal(): Promise<void> {
  const bundle = createPrometheusRegistry();
  incrementBacktestTotal('multi_factor_alpha', 'success', bundle);
  incrementBacktestTotal('multi_factor_alpha', 'success', bundle);
  incrementBacktestTotal('dragon_head', 'failed', bundle);

  assertEqual(
    'multi_factor_alpha success count = 2',
    await metricValue(bundle, 'backtest_total', {
      strategy: 'multi_factor_alpha',
      result: 'success',
    }),
    2
  );
  assertEqual(
    'dragon_head failed count = 1',
    await metricValue(bundle, 'backtest_total', { strategy: 'dragon_head', result: 'failed' }),
    1
  );
  // 不同 label 组合互相隔离
  assertEqual(
    'multi_factor_alpha failed count = 0 (untouched)',
    await metricValue(bundle, 'backtest_total', {
      strategy: 'multi_factor_alpha',
      result: 'failed',
    }),
    0
  );

  // 空 strategy 退回 'unknown'
  incrementBacktestTotal('', 'success', bundle);
  assertEqual(
    'empty strategy → unknown',
    await metricValue(bundle, 'backtest_total', { strategy: 'unknown', result: 'success' }),
    1
  );
}

async function testObserveAIRequestDuration(): Promise<void> {
  const bundle = createPrometheusRegistry();
  observeAIRequestDuration('trading_agents', 'analyze', 'success', 1.5, bundle);
  observeAIRequestDuration('trading_agents', 'analyze', 'success', 3.5, bundle);
  observeAIRequestDuration('trading_agents', 'analyze', 'failed', 25, bundle);

  const json = await bundle.registry.getMetricsAsJSON();
  const histogram = json.find(x => x.name === 'ai_request_duration_seconds');
  assert('histogram exists in JSON dump', !!histogram);

  // sum / count 字段在 prom-client 中通过 values 数组里 metricName='_sum' / '_count' 表示
  const sumValue =
    (histogram as any).values?.find(
      (v: any) =>
        v.metricName === 'ai_request_duration_seconds_sum' &&
        v.labels?.endpoint === 'analyze' &&
        v.labels?.status === 'success'
    )?.value || 0;
  const countValue =
    (histogram as any).values?.find(
      (v: any) =>
        v.metricName === 'ai_request_duration_seconds_count' &&
        v.labels?.endpoint === 'analyze' &&
        v.labels?.status === 'success'
    )?.value || 0;

  assertEqual('histogram success count = 2', countValue, 2);
  assertEqual('histogram success sum = 5.0', sumValue, 5);

  // 负 duration 应该被拒绝（不 observe）
  observeAIRequestDuration('trading_agents', 'analyze', 'success', -1, bundle);
  observeAIRequestDuration('trading_agents', 'analyze', 'success', NaN, bundle);
  const json2 = await bundle.registry.getMetricsAsJSON();
  const histogram2 = json2.find(x => x.name === 'ai_request_duration_seconds');
  const countAfter =
    (histogram2 as any).values?.find(
      (v: any) =>
        v.metricName === 'ai_request_duration_seconds_count' &&
        v.labels?.endpoint === 'analyze' &&
        v.labels?.status === 'success'
    )?.value || 0;
  assertEqual('negative/NaN duration not observed', countAfter, 2);
}

async function testIncrementOrderTotal(): Promise<void> {
  const bundle = createPrometheusRegistry();
  incrementOrderTotal('BUY', 'success', 'ok', bundle);
  incrementOrderTotal('BUY', 'success', 'ok', bundle);
  incrementOrderTotal('SELL', 'success', 'ok', bundle);
  incrementOrderTotal('BUY', 'failed', 'POSITION_LIMIT_VIOLATION', bundle);
  incrementOrderTotal('BUY', 'failed', 'INSUFFICIENT_FUNDS', bundle);
  incrementOrderTotal('BUY', 'failed', 'DRAWDOWN_BREAKER_PAUSED', bundle);

  assertEqual(
    'BUY success ok count = 2',
    await metricValue(bundle, 'order_total', { direction: 'BUY', status: 'success', code: 'ok' }),
    2
  );
  assertEqual(
    'SELL success ok count = 1',
    await metricValue(bundle, 'order_total', { direction: 'SELL', status: 'success', code: 'ok' }),
    1
  );
  assertEqual(
    'BUY failed POSITION_LIMIT_VIOLATION = 1',
    await metricValue(bundle, 'order_total', {
      direction: 'BUY',
      status: 'failed',
      code: 'POSITION_LIMIT_VIOLATION',
    }),
    1
  );
  assertEqual(
    'BUY failed INSUFFICIENT_FUNDS = 1',
    await metricValue(bundle, 'order_total', {
      direction: 'BUY',
      status: 'failed',
      code: 'INSUFFICIENT_FUNDS',
    }),
    1
  );
  assertEqual(
    'BUY failed DRAWDOWN_BREAKER_PAUSED = 1',
    await metricValue(bundle, 'order_total', {
      direction: 'BUY',
      status: 'failed',
      code: 'DRAWDOWN_BREAKER_PAUSED',
    }),
    1
  );

  // 空 code → fallback
  incrementOrderTotal('SELL', 'failed', '', bundle);
  assertEqual(
    'empty code on failed → unknown',
    await metricValue(bundle, 'order_total', {
      direction: 'SELL',
      status: 'failed',
      code: 'unknown',
    }),
    1
  );
  incrementOrderTotal('SELL', 'success', '', bundle);
  assertEqual(
    'empty code on success → ok',
    await metricValue(bundle, 'order_total', { direction: 'SELL', status: 'success', code: 'ok' }),
    2 // 已经有 1（SELL success ok）+ 现在再 +1
  );
}

// ---------------------------------------------------------------------------
//  httpMetricsMiddleware
// ---------------------------------------------------------------------------

function makeFakeReqRes(
  method: string,
  routePath: string | undefined,
  baseUrl: string,
  statusCode: number
) {
  // 模拟 EventEmitter-like 'finish' callback registration
  let finishHandler: (() => void) | null = null;
  const res: any = {
    statusCode,
    on(event: string, handler: () => void) {
      if (event === 'finish') finishHandler = handler;
    },
    fireFinish() {
      if (finishHandler) finishHandler();
    },
  };
  const req: any = {
    method,
    route: routePath ? { path: routePath } : undefined,
    baseUrl,
    path: baseUrl + (routePath || ''),
  };
  return { req, res };
}

async function testHttpMiddleware(): Promise<void> {
  const bundle = createPrometheusRegistry();
  const middleware = httpMetricsMiddleware(bundle);

  // GET /api/portfolio/:id → 200
  const { req, res } = makeFakeReqRes('GET', '/:id', '/api/portfolio', 200);
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  assert('next() called immediately', nextCalled);
  res.fireFinish();

  assertEqual(
    'GET /api/portfolio/:id 200 → counter +1',
    await metricValue(bundle, 'http_requests_total', {
      method: 'GET',
      route: '/api/portfolio/:id',
      status: '200',
    }),
    1
  );

  // POST /api/x → 500
  const { req: req2, res: res2 } = makeFakeReqRes('POST', '/', '/api/x', 500);
  middleware(req2, res2, () => undefined);
  res2.fireFinish();
  assertEqual(
    'POST /api/x/ 500 → counter +1',
    await metricValue(bundle, 'http_requests_total', {
      method: 'POST',
      route: '/api/x/',
      status: '500',
    }),
    1
  );

  // 404: route undefined, baseUrl empty → unmatched
  const { req: req3, res: res3 } = makeFakeReqRes('GET', undefined, '', 404);
  middleware(req3, res3, () => undefined);
  res3.fireFinish();
  assertEqual(
    'GET unmatched 404 → counter +1',
    await metricValue(bundle, 'http_requests_total', {
      method: 'GET',
      route: 'unmatched',
      status: '404',
    }),
    1
  );

  // 重复同一组 label 应该累加
  const { req: req4, res: res4 } = makeFakeReqRes('GET', '/:id', '/api/portfolio', 200);
  middleware(req4, res4, () => undefined);
  res4.fireFinish();
  assertEqual(
    'GET /api/portfolio/:id 200 → counter +1 (= 2 total)',
    await metricValue(bundle, 'http_requests_total', {
      method: 'GET',
      route: '/api/portfolio/:id',
      status: '200',
    }),
    2
  );
}

// ---------------------------------------------------------------------------
//  /metrics endpoint format
// ---------------------------------------------------------------------------

async function testMetricsTextFormat(): Promise<void> {
  const bundle = createPrometheusRegistry();
  // 触发一次每种 metric 让 HELP / TYPE / 实际样本 line 都出现
  bundle.httpRequestsTotal.inc({ method: 'GET', route: '/x', status: '200' });
  incrementBacktestTotal('mfa', 'success', bundle);
  observeAIRequestDuration('trading_agents', 'analyze', 'success', 1, bundle);
  incrementOrderTotal('BUY', 'success', 'ok', bundle);

  const text = await getMetricsContent(bundle);
  assert('text format contains HELP http_requests_total', text.includes('# HELP http_requests_total'));
  assert('text format contains TYPE http_requests_total counter', text.includes('# TYPE http_requests_total counter'));
  assert('text format contains HELP backtest_total', text.includes('# HELP backtest_total'));
  assert('text format contains TYPE backtest_total counter', text.includes('# TYPE backtest_total counter'));
  assert(
    'text format contains HELP ai_request_duration_seconds',
    text.includes('# HELP ai_request_duration_seconds')
  );
  assert(
    'text format contains TYPE ai_request_duration_seconds histogram',
    text.includes('# TYPE ai_request_duration_seconds histogram')
  );
  assert('text format contains HELP order_total', text.includes('# HELP order_total'));
  assert('text format contains TYPE order_total counter', text.includes('# TYPE order_total counter'));

  // 实际样本 line 出现
  assert(
    'http_requests_total sample with labels present',
    text.includes('http_requests_total{method="GET",route="/x",status="200"} 1')
  );
  assert(
    'backtest_total sample with labels present',
    text.includes('backtest_total{strategy="mfa",result="success"} 1')
  );
  assert(
    'order_total sample with labels present',
    text.includes('order_total{direction="BUY",status="success",code="ok"} 1')
  );

  // Histogram 必须有 _bucket / _sum / _count 三种 sample
  assert(
    'ai_request_duration_seconds_bucket present',
    text.includes('ai_request_duration_seconds_bucket')
  );
  assert(
    'ai_request_duration_seconds_sum present',
    text.includes('ai_request_duration_seconds_sum')
  );
  assert(
    'ai_request_duration_seconds_count present',
    text.includes('ai_request_duration_seconds_count')
  );
}

async function testContentType(): Promise<void> {
  const bundle = createPrometheusRegistry();
  const ct = getMetricsContentType(bundle);
  // prom-client v15 default: text/plain version=0.0.4 charset=utf-8
  assert(
    'content type starts with text/plain',
    ct.startsWith('text/plain'),
    `actual=${ct}`
  );
  assert('content type declares version 0.0.4', ct.includes('version=0.0.4'), `actual=${ct}`);
  assert('content type declares utf-8', ct.includes('charset=utf-8'), `actual=${ct}`);
}

// ---------------------------------------------------------------------------
//  US-004 [OPS-004]: 标准化 — 新增 scheduler 域 metric + AC "≥20 metric 可见"
// ---------------------------------------------------------------------------

async function testRecordSchedulerTaskRun(): Promise<void> {
  const bundle = createPrometheusRegistry();
  recordSchedulerTaskRun('DAILY_UPDATE', 'success', 1.2, bundle);
  recordSchedulerTaskRun('DAILY_UPDATE', 'success', 0.8, bundle);
  recordSchedulerTaskRun('DAILY_UPDATE', 'failed', 5.5, bundle);
  recordSchedulerTaskRun('SYNC_HISTORY', 'skipped', 0.01, bundle);

  // counter 计数维度: task_type + status 隔离
  assertEqual(
    'DAILY_UPDATE success count = 2',
    await metricValue(bundle, 'scheduler_task_runs_total', {
      task_type: 'DAILY_UPDATE',
      status: 'success',
    }),
    2
  );
  assertEqual(
    'DAILY_UPDATE failed count = 1',
    await metricValue(bundle, 'scheduler_task_runs_total', {
      task_type: 'DAILY_UPDATE',
      status: 'failed',
    }),
    1
  );
  assertEqual(
    'SYNC_HISTORY skipped count = 1',
    await metricValue(bundle, 'scheduler_task_runs_total', {
      task_type: 'SYNC_HISTORY',
      status: 'skipped',
    }),
    1
  );
  assertEqual(
    'DAILY_UPDATE skipped count = 0 (untouched)',
    await metricValue(bundle, 'scheduler_task_runs_total', {
      task_type: 'DAILY_UPDATE',
      status: 'skipped',
    }),
    0
  );

  // histogram sum / count: success 维 2 次 → count=2, sum=2.0
  const json = await bundle.registry.getMetricsAsJSON();
  const hist = json.find(x => x.name === 'scheduler_task_duration_seconds');
  assert('scheduler_task_duration_seconds exists', !!hist);
  const successCount =
    (hist as any).values?.find(
      (v: any) =>
        v.metricName === 'scheduler_task_duration_seconds_count' &&
        v.labels?.task_type === 'DAILY_UPDATE' &&
        v.labels?.status === 'success'
    )?.value || 0;
  const successSum =
    (hist as any).values?.find(
      (v: any) =>
        v.metricName === 'scheduler_task_duration_seconds_sum' &&
        v.labels?.task_type === 'DAILY_UPDATE' &&
        v.labels?.status === 'success'
    )?.value || 0;
  assertEqual('DAILY_UPDATE success histogram count = 2', successCount, 2);
  assert(
    'DAILY_UPDATE success histogram sum ≈ 2.0',
    Math.abs(successSum - 2.0) < 1e-6,
    `actual=${successSum}`
  );

  // 负 duration / NaN: counter 仍 +1, histogram 不 observe (主流程不被 metric 拒绝)
  recordSchedulerTaskRun('DAILY_UPDATE', 'failed', -1, bundle);
  recordSchedulerTaskRun('DAILY_UPDATE', 'failed', NaN, bundle);
  assertEqual(
    'DAILY_UPDATE failed counter advances past invalid duration (was 1, +2 → 3)',
    await metricValue(bundle, 'scheduler_task_runs_total', {
      task_type: 'DAILY_UPDATE',
      status: 'failed',
    }),
    3
  );
  const json2 = await bundle.registry.getMetricsAsJSON();
  const hist2 = json2.find(x => x.name === 'scheduler_task_duration_seconds');
  const failedCount =
    (hist2 as any).values?.find(
      (v: any) =>
        v.metricName === 'scheduler_task_duration_seconds_count' &&
        v.labels?.task_type === 'DAILY_UPDATE' &&
        v.labels?.status === 'failed'
    )?.value || 0;
  assertEqual('histogram only observed valid duration (count=1, not 3)', failedCount, 1);

  // 空 task_type 退回 'unknown'
  recordSchedulerTaskRun('', 'success', 0.1, bundle);
  assertEqual(
    'empty task_type → unknown',
    await metricValue(bundle, 'scheduler_task_runs_total', {
      task_type: 'unknown',
      status: 'success',
    }),
    1
  );
}

async function testTwentyMetricsVisible(): Promise<void> {
  // US-004 AC: "至少 20 个 metric 在 /metrics 可见".
  // 单 createPrometheusRegistry({enableDefaultMetrics:true}) 已注册:
  //   - 26 个 prom-client 默认 process_ / nodejs_ 系列 metric
  //   - 7 个业务 metric (http_requests_total, backtest_total, ai_request_duration_seconds,
  //     order_total, backtest_trade_count_total, scheduler_task_runs_total,
  //     scheduler_task_duration_seconds)
  // 触发各 metric 让 HELP / TYPE 都暴露 (counter 不 inc 不会 emit 行).
  const bundle = createPrometheusRegistry({ enableDefaultMetrics: true });
  bundle.httpRequestsTotal.inc({ method: 'GET', route: '/x', status: '200' });
  incrementBacktestTotal('mfa', 'success', bundle);
  observeAIRequestDuration('tg', 'analyze', 'success', 1, bundle);
  incrementOrderTotal('BUY', 'success', 'ok', bundle);
  bundle.backtestTradeCountTotal.inc({ strategy_key: 'mfa' }, 1);
  recordSchedulerTaskRun('DAILY_UPDATE', 'success', 1.0, bundle);

  const text = await getMetricsContent(bundle);
  const helpLines = text.split('\n').filter(l => l.startsWith('# HELP '));
  assert(
    `≥20 metrics visible (got ${helpLines.length})`,
    helpLines.length >= 20,
    `metrics=${helpLines.map(l => l.split(' ')[2]).join(',')}`
  );

  // 各域命名遵循 `<domain>_<verb>_<unit>` 约定: scheduler_task_runs_total / scheduler_task_duration_seconds
  assert(
    'scheduler_task_runs_total exposed in /metrics text',
    text.includes('# TYPE scheduler_task_runs_total counter')
  );
  assert(
    'scheduler_task_duration_seconds exposed in /metrics text',
    text.includes('# TYPE scheduler_task_duration_seconds histogram')
  );
}

// ---------------------------------------------------------------------------
//  Driver — async sequencing (per US-037 codebase pattern)
// ---------------------------------------------------------------------------

async function main() {
  await testNormalizeMethodLabel();
  await testNormalizeStatusLabel();
  await testResolveRouteLabel();
  await testCreateRegistry();
  await testDefaultMetricsToggle();
  await testIncrementBacktestTotal();
  await testObserveAIRequestDuration();
  await testIncrementOrderTotal();
  await testHttpMiddleware();
  await testMetricsTextFormat();
  await testContentType();
  await testRecordSchedulerTaskRun();
  await testTwentyMetricsVisible();

  console.log(`\n${passed} ok, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('TEST RUNNER CRASHED:', err);
  process.exitCode = 1;
});
