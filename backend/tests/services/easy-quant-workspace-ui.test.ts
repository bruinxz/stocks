/**
 * easy-quant-workspace-ui.test.ts
 *
 * Static frontend contract guard for the simplified quant workspace.
 * Local checkouts may not have frontend node_modules installed, so this
 * verifies route wiring, mock-only data, standalone shell isolation, and the
 * Claude-like warm editorial UI tokens.
 */

import * as fs from 'fs';
import * as path from 'path';

let failed = 0;
let passed = 0;
const REPO_ROOT = findRepoRoot();

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function read(relativePath: string): string {
  const full = path.join(REPO_ROOT, relativePath);
  if (!fs.existsSync(full)) {
    failed += 1;
    console.error(`  FAIL file exists: ${relativePath}`);
    return '';
  }
  return fs.readFileSync(full, 'utf8');
}

function findRepoRoot(start = process.cwd()): string {
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

console.log('\n## EasyQuant simplified workspace UI contract');

const app = read('frontend/src/App.tsx');
const page = read('frontend/src/pages/workspace/EasyQuantWorkspace.tsx');
const css = read('frontend/src/pages/workspace/EasyQuantWorkspace.css');
const service = read('frontend/src/services/easyQuantService.ts');
const templates = read('frontend/src/pages/workspace/easyQuantTemplates.ts');
const helpers = read('frontend/src/pages/workspace/easyQuantResultHelpers.ts');

assert(
  'App lazy loads EasyQuantWorkspace',
  /const EasyQuantWorkspace = lazy\(\(\) => import\('\.\/pages\/workspace\/EasyQuantWorkspace'\)\)/.test(
    app
  )
);
assert(
  'sidebar contains simplified workspace route',
  /menuLink\('\/workspace\/easy'[\s\S]{0,140}?简易版/.test(app)
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
  'page uses EasyQuant service orchestration',
  /easyQuantService/.test(page) &&
    /loadEasyQuantBootstrap/.test(page) &&
    /runEasyQuantBacktest/.test(page)
);
assert(
  'page no longer owns mock strategy, data, report, or observe constants',
  !/const strategyTemplates\s*=/.test(page) &&
    !/const dataChecks\s*=/.test(page) &&
    !/const reportMetrics\s*=/.test(page) &&
    !/const observeLogs\s*=/.test(page)
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
  'beginner templates map to existing strategy keys',
  ['ma_trend', 'breakout_atr', 'low_volatility_quality'].every(key =>
    templates.includes(key)
  )
);
assert(
  'result helpers expose beginner verdict builder',
  /buildEasyQuantBacktestVerdict/.test(helpers) && /can_create_observation/.test(helpers)
);
assert(
  'beginner errors are translated into plain Chinese',
  helpers.includes('explainEasyQuantError') &&
    helpers.includes('登录状态失效') &&
    helpers.includes('行情数据可能不完整')
);
assert(
  'observation flow is paper-only and explicit',
  service.includes('auto_trade_enabled: false') &&
    page.includes('不会下真实订单') &&
    page.includes('/workspace/portfolio')
);
assert(
  'hero uses Chinese start button and scroll target for guided flow',
  page.includes('开始 <ArrowRightOutlined />') &&
    page.includes('startGuidedFlow') &&
    page.includes('id="easy-quant-flow"') &&
    !page.includes('看动线说明')
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
  'risk labels have semantic tones',
  page.includes('getRiskTone') &&
    css.includes('eq-risk-tag--low') &&
    css.includes('eq-risk-tag--medium') &&
    css.includes('eq-risk-tag--high')
);
assert(
  'hero recommendation content is grouped near visual center',
  /\.eq-recommendation\s*\{[\s\S]{0,220}?display:\s*grid;[\s\S]{0,220}?align-content:\s*center;/.test(
    css
  ) &&
    /\.eq-recommendation\s*\{[\s\S]{0,220}?gap:\s*12px;/.test(css) &&
    /\.eq-rec-top\s*\{[\s\S]{0,140}?padding-bottom:\s*12px;/.test(css) &&
    /\.eq-sketch--hero\s*\{[\s\S]{0,140}?height:\s*116px;[\s\S]{0,80}?margin:\s*0 auto 12px;/.test(
      css
    ) &&
    /\.eq-rec-body\s*\{[\s\S]{0,160}?justify-content:\s*flex-start;/.test(css)
);
assert(
  'hero main card is gently lower than mathematical center',
  /\.eq-hero-main\s*\{[\s\S]{0,180}?padding:\s*58px 32px 36px;/.test(css)
);
assert(
  'page is split into full-screen scroll sections',
  page.includes('eq-screen-section') &&
    page.includes('IntersectionObserver') &&
    page.includes('ref={scrollRootRef}') &&
    css.includes('.eq-scroll-root') &&
    css.includes('scroll-snap-type: y proximity') &&
    css.includes('min-height: 100%') &&
    css.includes('scroll-snap-align: center') &&
    !/html:has\(\.easy-quant\)[\s\S]{0,120}?scroll-snap-type/.test(css) &&
    !/scroll-snap-type:\s*y\s+mandatory/.test(css)
);
assert(
  'programmatic navigation controls the dedicated scroller',
  page.includes('scrollRootRef') &&
    page.includes('scrollRoot.scrollTo') &&
    page.includes('sectionTop - scrollRootTop + scrollRoot.scrollTop') &&
    page.includes('programmaticSectionRef') &&
    page.includes("behavior: 'auto'") &&
    page.includes("scrollRoot.style.scrollBehavior = 'auto'") &&
    !page.includes('top: section.offsetTop') &&
    !page.includes("behavior: 'smooth'") &&
    page.includes("scrollRoot.classList.add('eq-scroll-root--no-snap')") &&
    page.includes("scrollRoot.classList.remove('eq-scroll-root--no-snap')") &&
    css.includes('.eq-scroll-root--no-snap') &&
    css.includes('scroll-behavior: auto') &&
    css.includes('scroll-snap-type: none')
);
assert(
  'short desktop viewports fall back from snap to regular flow',
  /@media \(max-height:\s*760px\) and \(min-width:\s*821px\)[\s\S]{0,260}?\.eq-scroll-root\s*\{[\s\S]{0,80}?scroll-snap-type:\s*none/.test(
    css
  ) &&
    /@media \(max-height:\s*760px\) and \(min-width:\s*821px\)[\s\S]{0,420}?\.eq-screen-section\s*\{[\s\S]{0,120}?min-height:\s*auto/.test(
      css
    )
);
assert(
  'page keeps proximity snap rather than mandatory snap',
  css.includes('eq-scroll-root') &&
    css.includes('scroll-snap-type: y proximity') &&
    !/scroll-snap-type:\s*y\s+mandatory/.test(css)
);
assert(
  'section dot navigation has center-based scroll spy and fixed desktop dots',
  page.includes('eq-section-dots') &&
    page.includes('scrollToSection(item.id)') &&
    page.includes('viewportCenter') &&
    page.includes('setActiveSectionId(sectionId)') &&
    /\.eq-section-dots\s*\{[\s\S]{0,220}?position:\s*fixed/.test(css) &&
    /\.eq-section-dot\s+em\s*\{[\s\S]{0,180}?position:\s*absolute/.test(css) &&
    /@media \(max-width:\s*820px\)[\s\S]{0,900}?\.eq-section-dots\s*\{[\s\S]{0,80}?display:\s*none/.test(
      css
    )
);
assert(
  'workflow sidebars are shared instead of duplicated per stage',
  page.includes('eq-workflow-grid') &&
    (page.match(/renderStepDock\(\)/g) || []).length === 1 &&
    (page.match(/renderQuickCard\(\)/g) || []).length === 1 &&
    css.includes('eq-workflow-grid > .eq-step-dock')
);
assert(
  'workflow sidebars do not intrude into the flow section',
  /\.eq-workflow-grid > \.eq-step-dock,\s*\.eq-workflow-grid > \.eq-inspector\s*\{[\s\S]{0,140}?top:\s*56px;[\s\S]{0,80}?transform:\s*none;/.test(
    css
  ) && !/\.eq-workflow-grid > \.eq-step-dock,[\s\S]{0,160}?translateY\(-50%\)/.test(css)
);
assert(
  'stage panels avoid nested named section regions',
  !/<section className="eq-stage-panel/.test(page) &&
    /<article className="eq-stage-panel/.test(page)
);
assert(
  'stage panels keep desktop visual rhythm with near-viewport height',
  /\.eq-stage-panel\s*\{[\s\S]{0,140}?min-height:\s*clamp\(620px,\s*calc\(100dvh - 186px\),\s*840px\)/.test(
    css
  )
);
assert(
  'backtest metrics have semantic colors',
  page.includes('getMetricTone') &&
    css.includes('eq-metric-value--positive') &&
    css.includes('eq-metric-value--negative')
);
assert(
  'mobile falls back to normal single-column long scroll',
  /@media \(max-width:\s*820px\)[\s\S]{0,760}?\.eq-screen-section\s*\{[\s\S]{0,180}?min-height:\s*auto/.test(
    css
  ) &&
    /@media \(max-width:\s*820px\)[\s\S]{0,420}?scroll-snap-type:\s*none/.test(css) &&
    page.includes('eq-quick-card')
);
assert(
  'Claude-like warm editorial tokens are defined',
  css.includes('#f7f2e8') && css.includes('#171512') && css.includes('#c96338')
);
assert(
  'logo and restrained hand-drawn concepts are implemented in code',
  /EasyQuantMark/.test(page) && /JourneySketch/.test(page) && /eq-logo-mark/.test(css)
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
assert(
  'visible source avoids em dash and en dash',
  !/[\u2014\u2013]/.test(page) && !/[\u2014\u2013]/.test(css)
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
