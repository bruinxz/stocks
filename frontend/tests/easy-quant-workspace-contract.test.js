/**
 * Frontend contract guard for the simplified Easy Quant workspace.
 *
 * This is intentionally a lightweight source-level check: it protects route
 * wiring, real API orchestration, fail-closed health behavior, and beginner
 * copy without making the visual CSS implementation brittle.
 */

const fs = require('fs');
const path = require('path');

let failed = 0;
let passed = 0;
const REPO_ROOT = findRepoRoot();

function assert(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function read(relativePath) {
  const full = path.join(REPO_ROOT, relativePath);
  if (!fs.existsSync(full)) {
    failed += 1;
    console.error(`  FAIL file exists: ${relativePath}`);
    return '';
  }
  return fs.readFileSync(full, 'utf8');
}

function findRepoRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (
      fs.existsSync(path.join(current, 'frontend')) &&
      fs.existsSync(path.join(current, 'backend'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Cannot find repo root from ${start}`);
    }
    current = parent;
  }
}

console.log('\n## Easy Quant workspace frontend contract');

const app = read('frontend/src/App.tsx');
const page = read('frontend/src/pages/workspace/EasyQuantWorkspace.tsx');
const css = read('frontend/src/pages/workspace/EasyQuantWorkspace.css');
const service = read('frontend/src/services/easyQuantService.ts');
const labService = read('frontend/src/services/labService.ts');
const hooks = read('frontend/src/pages/workspace/easyQuantHooks.ts');
const templates = read('frontend/src/pages/workspace/easyQuantTemplates.ts');
const helpers = read('frontend/src/pages/workspace/easyQuantResultHelpers.ts');

assert(
  'App lazy loads EasyQuantWorkspace',
  /const EasyQuantWorkspace = lazy\(\(\) => import\('\.\/pages\/workspace\/EasyQuantWorkspace'\)\)/.test(
    app
  )
);
assert(
  'router mounts /workspace/easy behind ProtectedRoute',
  /path="\/workspace\/easy"[\s\S]{0,220}?<ProtectedRoute>[\s\S]{0,120}?<EasyQuantWorkspace \/>/.test(
    app
  )
);
assert(
  'easy workspace has standalone route before modern layout shell',
  /location\.pathname\.startsWith\(['"]\/workspace\/easy['"]\)[\s\S]{0,360}?<EasyQuantWorkspace \/>[\s\S]{0,360}?<Layout className="modern-layout">/.test(
    app
  )
);
assert('page exposes stable test id', /data-testid=["']easy-quant-workspace["']/.test(page));
assert(
  'page keeps professional mode available',
  /to=["']\/workspace\/lab["'][\s\S]{0,80}?专业版/.test(page)
);
assert(
  'page covers the beginner flow',
  ['选择策略模板', '查数据', '回测报告', '模拟观察'].every(label => page.includes(label))
);
assert(
  'bootstrap is independent from selected template changes',
  /loadEasyQuantBootstrap\(\)/.test(hooks) &&
    !/loadEasyQuantBootstrap\(selectedTemplateId\)/.test(page) &&
    page.includes('useEasyQuantBootstrap()') &&
    /export async function loadEasyQuantBootstrap\(\)/.test(service)
);
assert(
  'easy service calls existing quant and paper APIs only',
  service.includes("api.get('/quant/data-freshness'") &&
    service.includes("api.get('/quant/runtime-health'") &&
    service.includes('createBacktestTask') &&
    service.includes('createPortfolio') &&
    !service.includes('/live-trading')
);
assert(
  'health checks fail closed on unknown or business failure',
  /return 'blocked';[\s\S]{0,80}\n}/.test(
    service.match(/function normalizeHealthStatus[\s\S]*?\n}/)?.[0] || ''
  ) &&
    service.includes('res?.data?.success === false') &&
    service.includes('can_run_backtest: false')
);
assert(
  'createBacktestTask normalizes a deterministic task_id',
  /task_id:\s*number/.test(labService) &&
    /extractCreateBacktestTaskId/.test(labService) &&
    /throw new Error\('创建回测任务成功/.test(labService) &&
    page.includes('setBacktestTaskId(created.task_id)')
);
assert(
  'backtest polling stops on terminal state, timeout, or error',
  page.includes('useEasyQuantBacktestPolling') &&
    hooks.includes('timerRef') &&
    hooks.includes('window.setTimeout(poll, nextDelay)') &&
    hooks.includes('stopPolling()') &&
    !page.includes('window.setInterval(async () =>')
);
assert(
  'display username comes from auth state with cached fallback',
  page.includes('useEasyQuantDisplayUsername') &&
    hooks.includes('useSelector') &&
    hooks.includes('state.auth.user') &&
    !page.includes("localStorage.getItem('username')")
);
assert(
  'section visibility and scroll spy are isolated in a hook',
  page.includes('useEasyQuantSectionScrollSpy') &&
    hooks.includes('export function useEasyQuantSectionScrollSpy') &&
    hooks.includes('IntersectionObserver') &&
    hooks.includes('viewportCenter')
);
assert(
  'observation portfolio names avoid duplicate collisions',
  service.includes('new Date()') &&
    /name:\s*`简易观察-\$\{template\.name\}-\$\{timestamp\}`/.test(service) &&
    service.includes('auto_trade_enabled: false')
);
assert(
  'beginner templates map to existing strategy keys',
  ['ma_trend', 'breakout_atr', 'low_volatility_quality'].every(key => templates.includes(key))
);
assert(
  'result helpers support backend verdict with local fallback thresholds',
  helpers.includes('pickBackendVerdict') &&
    helpers.includes('EASY_QUANT_OBSERVATION_THRESHOLDS') &&
    helpers.includes('Math.abs(result.max_drawdown_pct)')
);
assert(
  'beginner errors are translated into plain Chinese',
  helpers.includes('explainEasyQuantError') &&
    helpers.includes('登录状态失效') &&
    helpers.includes('行情数据可能不完整') &&
    helpers.includes("lower.includes('超时')")
);
assert(
  'copy keeps one data-checking term and removes duplicate current-step card',
  !/检查数据|数据体检|当前步骤/.test(page) &&
    page.includes('下一步：查数据') &&
    page.includes('查数据详情')
);
assert(
  'template selection is expressed by selected card state',
  page.includes('eq-template-check') && !page.includes('已选模板')
);
assert(
  'risk labels and metrics have semantic tones',
  page.includes('getRiskTone') &&
    css.includes('eq-risk-tag--low') &&
    css.includes('eq-risk-tag--medium') &&
    css.includes('eq-risk-tag--high') &&
    css.includes('eq-metric-value--good') &&
    css.includes('eq-metric-value--bad')
);
assert(
  'page uses dedicated scroll container with proximity snap',
  page.includes('ref={scrollRootRef}') &&
    page.includes('scrollToSection(item.id)') &&
    css.includes('.eq-scroll-root') &&
    css.includes('scroll-snap-type: y proximity') &&
    css.includes('scroll-snap-align: center') &&
    !/scroll-snap-type:\s*y\s+mandatory/.test(css)
);
assert(
  'mobile and short desktops fall back to regular flow',
  /@media \(max-width:\s*820px\)[\s\S]{0,760}?\.eq-screen-section\s*\{[\s\S]{0,180}?min-height:\s*auto/.test(
    css
  ) &&
    /@media \(max-height:\s*760px\) and \(min-width:\s*821px\)[\s\S]{0,420}?\.eq-screen-section\s*\{[\s\S]{0,120}?min-height:\s*auto/.test(
      css
    )
);
assert(
  'display typography uses Heiti-style fallback',
  css.includes('--eq-display-font') &&
    /Heiti SC|STHeiti|PingFang SC/.test(css) &&
    !/Songti|宋体|Noto Serif SC|Kaiti|KaiTi|STKaiti|FangSong|LXGW WenKai/.test(page + css)
);
assert(
  'style avoids rejected blue dashboard palette',
  !/#2764b8|#1f3a5f|geekblue|蓝色后台/.test(page + css)
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
