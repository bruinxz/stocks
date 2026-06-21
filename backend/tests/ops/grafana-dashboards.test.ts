/**
 * Grafana dashboards drift guard 单元测试 (US-129 / OPS-010)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/ops/grafana-dashboards.test.ts
 *
 * 这份测试守 `ops/grafana/dashboards/*.json` 与
 * `backend/src/metrics/PrometheusRegistry.ts` 之间的契约:
 *
 *   1. 5 个 AC 要求的 dashboard 文件全部存在 (signal-flow / risk-control /
 *      reconciliation / data-sla / strategy-performance).
 *   2. 每个 dashboard 是 valid JSON, 含 panels[] 非空, uid / title / schemaVersion 齐.
 *   3. uid 全局唯一 (Grafana 用 uid 索引 dashboard, 重复 import 会冲突).
 *   4. **drift guard**: 每个 dashboard panel.targets[].expr 引用的 metric 名
 *      必须出现在 PrometheusRegistry.ts 里的 `new (Counter|Gauge|Histogram)({name: '...'})` 列表中.
 *      改 metric 名 (e.g. rename `order_total` → `orders_total`) 而忘改 dashboard
 *      时这条单测立刻挂.
 *   5. 每个 dashboard 含 DS_PROMETHEUS 模板变量 (datasource template) —
 *      让运维 import 后不需要手改 JSON 改 datasource uid.
 *   6. 反向 false-negative test: 构造一份 expr 引用了不存在的 metric 的 fake dashboard,
 *      checker 必须报 drift — 防 checker 实现错永远过.
 *
 * 测试 [4] + [6] 是这份 story 的核心约束 — 与 US-098 OPS-009 openapi drift checker
 * 同款"代码↔衍生品"模板, 区别在: openapi 是单文件 byte-for-byte, dashboards 是
 * 多文件 + 仅校验 metric 名集合 (允许 dashboard 自己加 PromQL 包装).
 */

import * as fs from 'fs';
import * as path from 'path';

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

// ---------------------------------------------------------------------------
//  Constants — dashboard 文件清单与必需 metric 命名规则
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../..');
const DASHBOARDS_DIR = path.join(REPO_ROOT, 'ops/grafana/dashboards');
const METRICS_SOURCE = path.resolve(__dirname, '../../src/metrics/PrometheusRegistry.ts');

/** AC §2 要求的 5 个 dashboard */
const REQUIRED_DASHBOARDS = [
  'signal-flow.json',
  'risk-control.json',
  'reconciliation.json',
  'data-sla.json',
  'strategy-performance.json',
];

/**
 * 从 PrometheusRegistry.ts 源文件抽取所有已注册的 metric 名.
 * 用 `name: 'xxx'` 出现在 `new (Counter|Gauge|Histogram)({...})` 里的字面量.
 */
function extractRegisteredMetricNames(src: string): Set<string> {
  const names = new Set<string>();
  // 简化: 直接抓所有 `name: '<snake_case>'` 字面量, 实际不会误判
  // (PrometheusRegistry.ts 只在 metric 注册块用这个字段名).
  const re = /name:\s*'([a-z][a-z0-9_]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    names.add(m[1]);
  }
  return names;
}

/**
 * 从 Counter / Histogram metric 名派生 Prometheus 内部派生序列名.
 * - histogram → `<name>_bucket`, `<name>_sum`, `<name>_count`
 * - counter / gauge → 不派生
 *
 * 因为 dashboard 里可能写 `ai_request_duration_seconds_bucket` 而源文件只声明了
 * `ai_request_duration_seconds`, 我们要把派生名加进白名单.
 */
function buildExpandedMetricSet(src: string, names: Set<string>): Set<string> {
  const expanded = new Set<string>(names);
  // 找出 Histogram 的 metric — 在源文件中匹配 `new Histogram<...>({\n  name: '<x>'`
  const histogramRe = /new\s+Histogram[^{]*\{\s*name:\s*'([a-z][a-z0-9_]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = histogramRe.exec(src)) !== null) {
    expanded.add(`${m[1]}_bucket`);
    expanded.add(`${m[1]}_sum`);
    expanded.add(`${m[1]}_count`);
  }
  // Counter 也可能被 caller 查 `_total` 后缀 — 但我们的 counter 命名约定本身就含 _total,
  // 不再额外派生; 但 Prometheus 也允许查 counter 名本身 (不加后缀).
  return expanded;
}

/**
 * 从 dashboard JSON 抽取所有 panel.targets[].expr 中引用的 metric 名.
 * 简化抓法: 把 PromQL 里出现的 `<snake_case>` 标识符 (排除 PromQL 函数名 / label 值)
 * 全部抽出来, 再用启发式过滤.
 */
function extractMetricsFromDashboard(json: unknown): Set<string> {
  const metrics = new Set<string>();
  const panels = (json as { panels?: unknown[] })?.panels;
  if (!Array.isArray(panels)) return metrics;
  for (const p of panels) {
    const targets = (p as { targets?: unknown[] })?.targets;
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      const expr = (t as { expr?: unknown }).expr;
      if (typeof expr !== 'string') continue;
      extractMetricsFromExpr(expr, metrics);
    }
  }
  return metrics;
}

/** PromQL 关键字 / 函数名集合 — 不算 metric 名 */
const PROMQL_KEYWORDS = new Set<string>([
  'sum',
  'min',
  'max',
  'avg',
  'count',
  'rate',
  'irate',
  'increase',
  'topk',
  'bottomk',
  'histogram_quantile',
  'clamp_min',
  'clamp_max',
  'abs',
  'ceil',
  'floor',
  'round',
  'on',
  'by',
  'without',
  'group_left',
  'group_right',
  'le',
  'or',
  'and',
  'unless',
  'bool',
  'offset',
  'ignoring',
  // label 名也是 snake_case — 出现在 {}/by() 里, 我们用上下文剔除
]);

/** 已知 metric label 名 — 出现在 expr 但不是 metric 自身 */
const KNOWN_LABEL_NAMES = new Set<string>([
  'method',
  'route',
  'status',
  'strategy',
  'result',
  'provider',
  'endpoint',
  'direction',
  'code',
  'strategy_key',
  'task_type',
  'user_id',
  'side',
  'severity',
  'window',
]);

function extractMetricsFromExpr(expr: string, out: Set<string>): void {
  // 先识别 label 名 (在剥 quoted string 前 — 否则 `status="failed"` 拆掉后只剩 `status=`)
  // `<id>=` / `<id>!=` / `<id>=~` / `<id>!~` 前的 id 都是 label, 不是 metric.
  const labelPattern = /(?<!\w)([a-z][a-z0-9_]+)\s*[!=]~?\s*"/g;
  const labelsInExpr = new Set<string>();
  let lm: RegExpExecArray | null;
  while ((lm = labelPattern.exec(expr)) !== null) {
    labelsInExpr.add(lm[1]);
  }
  // 同样剔除 `by (a, b)` / `without (a, b)` 内的 label 名
  const byWithoutRe = /\b(?:by|without)\s*\(([^)]+)\)/g;
  let bm: RegExpExecArray | null;
  while ((bm = byWithoutRe.exec(expr)) !== null) {
    bm[1].split(',').forEach((s) => {
      const cleaned = s.trim();
      if (cleaned) labelsInExpr.add(cleaned);
    });
  }

  // 关键: 把所有 quoted string (label value / 正则) 替换成空, 防止把 status="failed" 里的
  // failed 当 metric 名 (snake_case 关键字过滤覆盖不到运行时业务字面量).
  const stripped = expr.replace(/"[^"]*"/g, '');

  const idRe = /\b([a-z][a-z0-9_]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(stripped)) !== null) {
    const id = m[1];
    if (PROMQL_KEYWORDS.has(id)) continue;
    if (KNOWN_LABEL_NAMES.has(id)) continue;
    if (labelsInExpr.has(id)) continue;
    // 数字关键字 / quantile 数字不会匹配 (regex 要求开头是字母)
    out.add(id);
  }
}

// ---------------------------------------------------------------------------
// [1] dashboard 文件存在性
// ---------------------------------------------------------------------------
console.log('\n[1] 5 个 dashboard 文件存在...');
for (const f of REQUIRED_DASHBOARDS) {
  const full = path.join(DASHBOARDS_DIR, f);
  assert(`存在 ${f}`, fs.existsSync(full), `path=${full}`);
}

// ---------------------------------------------------------------------------
// [2] 每个 dashboard 解析 + 必填字段
// ---------------------------------------------------------------------------
console.log('\n[2] 每个 dashboard 是 valid JSON + 必填字段齐...');
const parsedDashboards: Array<{ name: string; json: any }> = [];
for (const f of REQUIRED_DASHBOARDS) {
  const full = path.join(DASHBOARDS_DIR, f);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    assert(`${f} parse`, false, `error=${(e as Error).message}`);
    continue;
  }
  parsedDashboards.push({ name: f, json: parsed });
  assert(`${f} 有 title`, typeof parsed.title === 'string' && parsed.title.length > 0);
  assert(`${f} 有 uid`, typeof parsed.uid === 'string' && parsed.uid.length > 0);
  assert(`${f} schemaVersion=39`, parsed.schemaVersion === 39, `actual=${parsed.schemaVersion}`);
  assert(
    `${f} panels[] 非空`,
    Array.isArray(parsed.panels) && parsed.panels.length > 0,
    `panels=${JSON.stringify(parsed.panels)?.slice(0, 50)}`
  );
}

// ---------------------------------------------------------------------------
// [3] uid 全局唯一
// ---------------------------------------------------------------------------
console.log('\n[3] dashboard uid 全局唯一...');
const uids = parsedDashboards.map((d) => d.json.uid);
const uidSet = new Set(uids);
assert(`uid 无重复 (有 ${uids.length} 个)`, uids.length === uidSet.size, `uids=${uids.join(',')}`);

// ---------------------------------------------------------------------------
// [4] drift guard — 所有 expr metric 名都在 PrometheusRegistry.ts 注册过
// ---------------------------------------------------------------------------
console.log('\n[4] drift guard — dashboard expr ↔ PrometheusRegistry.ts metric 名...');
const metricsSrc = fs.readFileSync(METRICS_SOURCE, 'utf8');
const registeredNames = extractRegisteredMetricNames(metricsSrc);
assert(
  `PrometheusRegistry.ts 至少注册了 11 个 metric (现实就是 11)`,
  registeredNames.size >= 11,
  `count=${registeredNames.size} names=${[...registeredNames].join(',')}`
);
const expandedNames = buildExpandedMetricSet(metricsSrc, registeredNames);

for (const { name, json } of parsedDashboards) {
  const referenced = extractMetricsFromDashboard(json);
  for (const metric of referenced) {
    assert(
      `${name}: metric '${metric}' 已在 PrometheusRegistry.ts 注册`,
      expandedNames.has(metric),
      `expanded set has ${expandedNames.size} entries`
    );
  }
  // 至少引用了一个 metric (空 dashboard 没意义)
  assert(`${name}: 至少引用一个 metric`, referenced.size > 0);
}

// ---------------------------------------------------------------------------
// [5] DS_PROMETHEUS 模板变量
// ---------------------------------------------------------------------------
console.log('\n[5] 每个 dashboard 含 DS_PROMETHEUS 模板变量...');
for (const { name, json } of parsedDashboards) {
  const vars = json?.templating?.list;
  assert(`${name} templating.list 是数组`, Array.isArray(vars));
  const hasDs = Array.isArray(vars) && vars.some((v: any) => v?.name === 'DS_PROMETHEUS' && v?.type === 'datasource');
  assert(`${name} 含 DS_PROMETHEUS datasource template var`, hasDs);
}

// ---------------------------------------------------------------------------
// [6] 反向 false-negative test — fake dashboard 引用未注册 metric 必须被识破
// ---------------------------------------------------------------------------
console.log('\n[6] 反向 false-negative: fake dashboard 引用未注册 metric 应被识破...');
const fakeDashboard = {
  title: 'fake',
  uid: 'fake-uid',
  schemaVersion: 39,
  panels: [
    {
      targets: [{ expr: 'sum(rate(definitely_not_a_real_metric_xyz123[5m]))' }],
    },
  ],
};
const fakeRefs = extractMetricsFromDashboard(fakeDashboard);
assert(
  '[6.a] fake dashboard 引用 definitely_not_a_real_metric_xyz123',
  fakeRefs.has('definitely_not_a_real_metric_xyz123')
);
assert(
  '[6.b] fake metric 不在 PrometheusRegistry 注册集合中',
  !expandedNames.has('definitely_not_a_real_metric_xyz123')
);
// 模拟一次完整 drift check —— 应当报 drift
let driftDetected = false;
for (const m of fakeRefs) {
  if (!expandedNames.has(m)) {
    driftDetected = true;
    break;
  }
}
assert('[6.c] checker 真的能识破 fake drift', driftDetected);

// ---------------------------------------------------------------------------
// [7] README 存在
// ---------------------------------------------------------------------------
console.log('\n[7] ops/grafana/README.md 存在...');
const readme = path.join(REPO_ROOT, 'ops/grafana/README.md');
assert('README.md 存在', fs.existsSync(readme));
if (fs.existsSync(readme)) {
  const md = fs.readFileSync(readme, 'utf8');
  for (const f of REQUIRED_DASHBOARDS) {
    assert(`README 提及 ${f}`, md.includes(f));
  }
}

// ---------------------------------------------------------------------------
// 总结
// ---------------------------------------------------------------------------
console.log(`\n=== ${passed} ok / ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
