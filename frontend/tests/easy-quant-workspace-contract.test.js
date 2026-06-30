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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
const storyHintCss = css.match(/\.eq-story-hint\s*\{[\s\S]*?\n\}/)?.[0] || '';
const storyBubbleCss = css.match(/\.eq-story-bubble\s*\{[\s\S]*?\n\}/)?.[0] || '';
const quickEntryBlock = page.match(/<div className="eq-quick-list">([\s\S]*?)<\/div>/)?.[1] || '';
const forbiddenEasyRuntimeLiterals = [
  ['stock', '_backtest', '_dev'].join(''),
  ['stock', '_dev'].join(''),
  ['127', '0', '0', '1:15432'].join('.'),
  ['REACT_APP_API_BASE_URL=http://127', '0', '0', '1:3002'].join('.'),
  ['103', '242', '3', '87'].join('.'),
];
const forbiddenEasyRuntimeLiteralPattern = new RegExp(
  forbiddenEasyRuntimeLiterals.map(escapeRegExp).join('|')
);

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
  ['选择策略模板', '查数据', '回测报告', '可信度', '模拟观察'].every(label => page.includes(label))
);
assert(
  'page adds credibility step before observation',
  page.includes('可信度') && page.indexOf('可信度') < page.indexOf('模拟观察')
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
    service.includes('api.get(`/quant/backtests/${taskId}/research-audit`)') &&
    service.includes('createBacktestTask') &&
    service.includes('createPortfolio') &&
    !service.includes('/live-trading')
);
assert(
  'easy history reuses quant backtest list and filters simplified runs',
  service.includes('listBacktestTasks') &&
    service.includes('listEasyQuantBacktestHistory') &&
    service.includes('isEasyQuantBacktestTask') &&
    service.includes('task.parameters?.easy_mode') &&
    service.includes("task.task_name?.startsWith('简易版-')")
);
assert(
  'easy workspace relies on environment API routing instead of hard-coded dev database hosts',
  !forbiddenEasyRuntimeLiteralPattern.test(
    [page, service, labService, hooks, templates, helpers].join('\n')
  ) &&
    service.includes("import api from './api'") &&
    service.includes('createBacktestTask')
);
assert(
  'bootstrap keeps workflow presets optional but fails closed when strategies cannot load',
  service.includes('listQuantStrategies()') &&
    service.includes('strategyLoadFailed') &&
    service.includes('readOptional(listWorkflowPresets(), [])') &&
    service.includes('!strategyLoadFailed && Boolean(backendStrategy)') &&
    service.includes('策略列表加载失败，请刷新后再试。') &&
    !/strategies\.length === 0\s*\?\s*true/.test(service)
);
assert(
  'easy mode defaults to an available template after backend strategy state loads',
  service.includes('templates.find(template => template.available)?.id') &&
    page.includes('bootstrap.selected_template_id') &&
    page.includes('currentTemplate?.available === false')
);
assert(
  'easy service sends easy-mode research payload',
  service.includes('easy_mode: true') && service.includes('hypothesis')
);
assert(
  'easy run config exposes bounded beginner controls before backtest',
  templates.includes('EasyQuantRunConfig') &&
    templates.includes('buildDefaultEasyQuantRunConfig') &&
    service.includes('runConfig?: EasyQuantRunConfig') &&
    page.includes('eq-run-config') &&
    ['初始资金', '回测区间', '股票池', '单票仓位', '最大持仓'].every(label =>
      page.includes(label)
    ) &&
    page.includes('updateRunConfig') &&
    page.includes('run_config')
);
assert(
  'easy service reads research audit',
  service.includes('getEasyQuantResearchAudit') && service.includes('/research-audit')
);
assert(
  'completed backtests keep polling audit until phase-one artifacts are complete',
  page.includes('REQUIRED_RESEARCH_ARTIFACT_TYPES') &&
    ['backtest', 'integrity_audit', 'execution_audit'].every(type => page.includes(type)) &&
    page.includes('isResearchAuditComplete') &&
    page.includes('pickMostCompleteResearchAudit') &&
    page.includes('EASY_QUANT_AUDIT_POLL_INTERVAL_MS') &&
    page.includes('EASY_QUANT_AUDIT_POLL_TIMEOUT_MS') &&
    page.includes('getEasyQuantResearchAudit(taskId)') &&
    page.includes('resolvedResearchAudit') &&
    page.includes('researchAuditComplete')
);
assert(
  'health checks map warn to caution but fail closed on missing or unknown state',
  service.includes("['degraded', 'warning', 'warn', 'caution', 'risk']") &&
    service.includes('健康检查没有拿到完整结论') &&
    /return\s+'blocked';\s*\n\}/.test(service) &&
    service.includes('can_run_backtest: true') &&
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
  'beginner templates send position_pct as whole percent values',
  /default_position_pct:\s*12/.test(templates) &&
    /default_position_pct:\s*10/.test(templates) &&
    !/default_position_pct:\s*0\.\d+/.test(templates)
);
assert(
  'result helpers support backend verdict with local fallback thresholds',
  helpers.includes('pickBackendVerdict') &&
    helpers.includes('credibility_verdict') &&
    helpers.includes("credibility_verdict.verdict === 'pending'") &&
    helpers.includes('EASY_QUANT_OBSERVATION_THRESHOLDS') &&
    helpers.includes('Math.abs(toFiniteNumber(result.max_drawdown_pct) ?? 0)')
);
assert(
  'result helpers normalize ratio win rate for beginner display',
  helpers.includes('formatWinRatePct') &&
    helpers.includes('toFiniteNumber') &&
    helpers.includes("typeof value === 'string'") &&
    helpers.includes(
      'numericValue >= 0 && numericValue <= 1 ? numericValue * 100 : numericValue'
    ) &&
    helpers.includes('value: formatWinRatePct(winRate)')
);
assert(
  'backtest drawer has real report tabs instead of duplicating main cards',
  page.includes('eq-report-tabs') &&
    ['完整指标', '交易明细', '成交阻断'].every(label => page.includes(label)) &&
    page.includes('reportMetricGroups') &&
    page.includes('tradeRows') &&
    page.includes('blockedOrderRows') &&
    page.includes('entry_reason') &&
    page.includes('exit_reason') &&
    page.includes('买入原因') &&
    page.includes('卖出原因')
);
assert(
  'easy workspace has a history drawer with simplified and professional actions',
  page.includes("type DrawerKey = StepKey | 'guide' | 'ledger' | 'history' | null") &&
    page.includes('历史回测') &&
    page.includes('historyItems') &&
    page.includes('loadEasyQuantHistory') &&
    page.includes('handleOpenHistoryBacktest') &&
    page.includes('在简易版查看') &&
    page.includes('专业版详情') &&
    page.includes('eq-history-list') &&
    page.includes('eq-history-card') &&
    page.includes('to={`/legacy/backtest/${item.id}`}')
);
assert(
  'history entry is discoverable from the backtest report surface',
  page.includes('eq-report-actions') &&
    page.includes('eq-report-history-link') &&
    /回测报告[\s\S]{0,2600}?eq-report-history-link[\s\S]{0,260}?历史回测/.test(page)
);
assert(
  'quick entries are ordered by expected beginner usage frequency',
  [
    '历史回测',
    '交易明细',
    '完整指标',
    '查数据',
    '模板对比',
    '观察日志',
    '成交阻断',
    '实验账本',
  ].every((label, index, labels) => {
    const current = quickEntryBlock.indexOf(label);
    const previous = index === 0 ? -1 : quickEntryBlock.indexOf(labels[index - 1]);
    return current >= 0 && current > previous;
  })
);
assert(
  'easy workspace exposes concise user-story hints through icon hover tooltips',
  page.includes('easyQuantStoryHints') &&
    page.includes('StoryHint') &&
    css.includes('eq-story-hint') &&
    css.includes('eq-story-bubble') &&
    [
      '说明这次想验证什么，后续账本、审计和报告都会挂在这条链路上。',
      '看完整收益、回撤、成本和交易质量，确认结论不是只看一个数字。',
      '复盘每笔买卖发生的时间、盈亏，以及系统给出的买入/卖出原因。',
      '看哪些订单被涨跌停、停牌、T+1 或资金不足挡住。',
      '找回以前的简易版回测；可在这里复看，也可跳专业版深挖。',
      '串起研究假设、数据审计、成交约束和最终可信度。',
    ].every(text => page.includes(text))
);
assert(
  'easy story hints keep the warm-paper visual language and typography',
  storyHintCss.includes('font-family: inherit') &&
    storyBubbleCss.includes('background: var(--eq-sheet)') &&
    storyBubbleCss.includes('color: var(--eq-ink)') &&
    storyBubbleCss.includes('border: 1px solid rgba(201, 99, 56, 0.34)') &&
    !storyBubbleCss.includes('background: var(--eq-ink)')
);
assert(
  'full metrics include benchmark, final value, cost, and execution diagnostics',
  ['年化收益', '基准收益', '超额收益', '最终资产', '换手率', '手续费', '印花税', '滑点成本'].every(
    label => page.includes(label)
  ) &&
    page.includes('execution_diagnostics') &&
    page.includes('rejected_orders_json')
);
assert(
  'observation is gated by credibility verdict',
  helpers.includes('credibility_verdict') &&
    page.includes('researchAuditVerdict.can_create_observation')
);
assert(
  'easy workspace preserves edited hypothesis and keeps audit polling stable',
  page.includes('hypothesisTouchedRef') &&
    page.includes('latestEmbeddedResearchAuditRef') &&
    page.includes('pickMostCompleteResearchAudit(embeddedAudit, current)') &&
    !/backtestDetail\?\.research_audit,\s*\n\s*backtestDetail\?\.task\?\.id/.test(page)
);
assert(
  'credibility verdict includes a plain next-step action hint',
  page.includes('credibilityActionHint') &&
    page.includes('eq-action-brief') &&
    page.includes('先观察 5 到 10 个交易日') &&
    page.includes('先处理')
);
assert(
  'beginner errors are translated into plain Chinese',
  helpers.includes('explainEasyQuantError') &&
    helpers.includes('登录状态失效') &&
    helpers.includes('行情数据可能不完整') &&
    helpers.includes("lower.includes('超时')")
);
assert(
  'bootstrap timeout copy is distinct from real backtest timeout copy',
  helpers.includes("context: 'bootstrap' | 'backtest' | 'audit'") &&
    helpers.includes('读取数据和运行状态超时') &&
    page.includes("explainEasyQuantError(bootstrapError, 'bootstrap')") &&
    page.includes("explainEasyQuantError(backtestError, 'backtest')") &&
    page.includes("explainEasyQuantError(researchAuditError, 'audit')")
);
assert(
  'backtest running state shows elapsed progress and a refresh path instead of static waiting',
  hooks.includes('useEasyQuantElapsedSeconds') &&
    page.includes('backtestElapsedSeconds') &&
    page.includes('eq-running-status') &&
    page.includes('正在排队和计算') &&
    page.includes('仍在运行') &&
    page.includes('刷新结果')
);
assert(
  'backtest running state explains the live phase instead of waiting until final failure',
  page.includes('backtestRunningStages') &&
    page.includes('eq-running-timeline') &&
    ['提交任务', '排队', '计算收益', '写入可信度'].every(label => page.includes(label)) &&
    page.includes('backtestFailureGuidance') &&
    page.includes('失败发生在') &&
    page.includes('hasCompletedResearchAudit') &&
    page.includes("completedResearchAuditVerdict !== 'pending'") &&
    css.includes('eq-running-timeline') &&
    css.includes('eq-running-node--active') &&
    css.includes('eq-running-node--done') &&
    css.includes('eq-running-dot')
);
assert(
  'easy workspace restores the last local backtest after refresh and clears it when restarting',
  page.includes('EASY_QUANT_LAST_RUN_STORAGE_KEY') &&
    /localStorage\.setItem\(\s*EASY_QUANT_LAST_RUN_STORAGE_KEY/.test(page) &&
    /localStorage\.getItem\(\s*EASY_QUANT_LAST_RUN_STORAGE_KEY/.test(page) &&
    page.includes('handleResetResearchFlow') &&
    /localStorage\.removeItem\(\s*EASY_QUANT_LAST_RUN_STORAGE_KEY/.test(page)
);
assert(
  'data bootstrap loading explains progress instead of silent waiting',
  hooks.includes('bootstrapElapsedSeconds') &&
    hooks.includes('reloadBootstrap') &&
    page.includes('bootstrapLoadingSteps') &&
    page.includes('远端 dev 库响应较慢') &&
    page.includes('这不是回测失败') &&
    page.includes('重新检查') &&
    css.includes('eq-loading-status') &&
    css.includes('eq-status-sheen') &&
    css.includes('eq-lens-breathe')
);
assert(
  'loading motion respects reduced motion and mobile layout',
  /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.eq-verdict-card--loading::after[\s\S]*?display:\s*none/.test(
    css
  ) &&
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.eq-running-node--active/.test(css) &&
    /@media \(max-width:\s*820px\)[\s\S]*?\.eq-loading-steps[\s\S]*?grid-template-columns:\s*1fr/.test(
      css
    )
);
assert(
  'copy keeps one data-checking term and removes duplicate current-step card',
  !/检查数据|数据体检|当前步骤/.test(page) &&
    page.includes('下一步：查数据') &&
    page.includes('查数据详情')
);
assert('ledger drawer is available', page.includes('实验账本') && page.includes('eq-ledger'));
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

// ---------------------------------------------------------------------------
// PR-L emergency stop-loss (2026-06-29) — HomeWorkspace guards.
// 见 frontend/src/pages/HomeWorkspace.tsx 顶部 PR-L 注释:
// PR-K 30 天回测证实 win 32%, 必须把"一键跟单"按钮变灰 + 加 banner + 弹 Modal.
// 这些断言只检 source 关键字 (不验视觉) — 防止 PR-L 警示在后续重构里被无意删除.
// ---------------------------------------------------------------------------
const home = read('frontend/src/pages/HomeWorkspace.tsx');
assert(
  'PR-L: HomeWorkspace banner data-testid + Alert',
  home.includes('data-testid="home-emergency-banner"') &&
    /Alert[\s\S]{0,300}?type="warning"[\s\S]{0,400}?推荐系统处于评估期/.test(home)
);
assert(
  'PR-L: reco CTA button changed from 一键跟单 to 手动评估',
  home.includes('手动评估 (暂停一键跟单)') &&
    home.includes('data-testid="home-reco-cta-paused"') &&
    !/>\s*一键跟单 ¥/.test(home)
);
assert(
  'PR-L: handleFollowBuy wraps emergency Modal first',
  home.includes('data-testid="home-emergency-modal-title"') &&
    home.includes('我已了解, 继续手动买入') &&
    /Modal\.confirm\(\{[\s\S]{0,1500}?我已了解, 继续手动买入/.test(home)
);
assert(
  'PR-L: doc header records emergency context',
  home.includes('PR-L emergency stop-loss (2026-06-29)') && home.includes('EMERGENCY_CONF_GATE')
);

// ---------------------------------------------------------------------------
// PR-M4 (2026-06-29) — HomeWorkspace 仓位风控 hard caps + UI 整合.
// 见 backend/src/portfolio/PaperTradingFacade.ts PR-M4 段 (5% 单仓 / 25% 板块).
// 这些断言只检 source 关键字 — 防止 PR-M4 UI 在后续重构里被无意删除.
// ---------------------------------------------------------------------------
assert(
  'PR-M4: HomeWorkspace 今日市场卡 data-testid',
  home.includes('data-testid="home-market-card"') &&
    home.includes('data-testid="home-market-regime"')
);
assert(
  'PR-M4: HomeWorkspace 加载 marketJudgment',
  home.includes('getMarketJudgmentToday') &&
    home.includes('setMarketJudgment(') &&
    home.includes('loadMarketJudgment')
);
assert(
  'PR-M4: HomeWorkspace export buildSizingCapWarn helper',
  home.includes('export function buildSizingCapWarn') &&
    home.includes('PR_M4_FRONTEND_SINGLE_POSITION_CAP_PCT = 5')
);
assert(
  'PR-M4: 推荐卡 badges (sizing_cap / signal_type / industry_sentiment)',
  home.includes('data-testid="home-reco-card-badges"') &&
    home.includes('data-testid="home-reco-sizing-cap-warn"') &&
    home.includes('已自动降低到 5% 上限')
);
assert(
  'PR-M4: 推荐卡 前向兼容反转/动量 badge (PR-M2 backend 字段未 merged 也不挂)',
  home.includes('signal_type') &&
    home.includes("'reversal'") &&
    home.includes("'momentum'") &&
    home.includes('data-testid="home-reco-signal-reversal"') &&
    home.includes('data-testid="home-reco-signal-momentum"')
);
assert(
  'PR-M4: 推荐卡 前向兼容板块强弱 badge (PR-M3 backend 字段未 merged 也不挂)',
  home.includes('industry_sentiment') &&
    home.includes("'strong'") &&
    home.includes("'weak'") &&
    home.includes('data-testid="home-reco-industry-strong"') &&
    home.includes('data-testid="home-reco-industry-weak"')
);
assert(
  'PR-M4: riskCenterHelpers 加 PR-M4 rule_id 中文映射',
  read('frontend/src/pages/workspace/riskCenterHelpers.ts').includes('sizing_cap_exceeded') &&
    read('frontend/src/pages/workspace/riskCenterHelpers.ts').includes(
      'industry_concentration_cap_exceeded'
    ) &&
    read('frontend/src/pages/workspace/riskCenterHelpers.ts').includes('单仓 5% 上限') &&
    read('frontend/src/pages/workspace/riskCenterHelpers.ts').includes('板块 25% 上限')
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
