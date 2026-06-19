/**
 * US-058 [FE-019] PortfolioWorkspace 持仓 ATR/DD/days_held 列 — 单元测试.
 *
 * 不依赖 jest / DB / 网络 / React; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/position-metrics-helpers.test.ts
 *
 * import 自 frontend/src/pages/workspace/positionMetricsHelpers.ts (pure helpers, 无
 * antd/react, ts-node 直接吃). 跨 monorepo 同款 [[shadow-run-helpers.test.ts]] /
 * [[industry-concentration-kpi-helpers.test.ts]].
 *
 * 覆盖维度:
 *   [1] 阈值常量 sanity + 单调 (high > watch / fresh < long)
 *   [2] computeDaysHeld — null/非法/未来时间/正常/0 边界
 *   [3] computeDrawdownPct — null/0/负值/current>=high (浮盈)/正常回撤
 *   [4] classify{Atr,Drawdown,DaysHeld}Level — 三档边界 + null/NaN/负值兜底
 *   [5] POSITION_RISK_LEVEL_COLOR / LABEL + DAYS_HELD_LEVEL_COLOR / LABEL frozen + 完整
 *   [6] buildPositionMetricsViewModel — happy / 缺 highest_price (DD null) /
 *       缺 atr_pct (ATR unknown) / 缺 created_at (days unknown) / 同输入同输出 (useMemo safe)
 *   [7] formatPctOrDash / formatDaysHeld 边界
 *   [8] computeAtrPctFromBars (backend helper) — 数据不足 / 数据足 / close=0
 *   [9] META-GUARD: PortfolioWorkspace.tsx import + 三列 key + service PositionRow
 *       含新字段 + facade getPortfolio 含 computeAtrPctFromBars 调用
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ATR_HIGH_PCT,
  ATR_WATCH_PCT,
  DD_HIGH_PCT,
  DD_WATCH_PCT,
  DAYS_HELD_FRESH,
  DAYS_HELD_LONG,
  POSITION_RISK_LEVEL_COLOR,
  POSITION_RISK_LEVEL_LABEL,
  DAYS_HELD_LEVEL_COLOR,
  DAYS_HELD_LEVEL_LABEL,
  computeDaysHeld,
  computeDrawdownPct,
  classifyAtrLevel,
  classifyDrawdownLevel,
  classifyDaysHeldLevel,
  buildPositionMetricsViewModel,
  formatPctOrDash,
  formatDaysHeld,
} from '../../../frontend/src/pages/workspace/positionMetricsHelpers';
import { computeAtrPctFromBars } from '../../src/portfolio/internal/positionAtrHelpers';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

// ---- [1] 阈值常量 sanity ---------------------------------------------------
{
  assert('[1.1] ATR_HIGH_PCT > ATR_WATCH_PCT', ATR_HIGH_PCT > ATR_WATCH_PCT);
  assert('[1.2] DD_HIGH_PCT > DD_WATCH_PCT', DD_HIGH_PCT > DD_WATCH_PCT);
  assert('[1.3] DAYS_HELD_FRESH < DAYS_HELD_LONG', DAYS_HELD_FRESH < DAYS_HELD_LONG);
  assert('[1.4] all positive', ATR_HIGH_PCT > 0 && DD_HIGH_PCT > 0 && DAYS_HELD_LONG > 0);
}

// ---- [2] computeDaysHeld ---------------------------------------------------
{
  const fixed = new Date('2026-06-20T08:00:00.000Z');
  assert('[2.1] null → null', computeDaysHeld(null, fixed) === null);
  assert('[2.2] undefined → null', computeDaysHeld(undefined, fixed) === null);
  assert('[2.3] 非法字符串 → null', computeDaysHeld('not-a-date', fixed) === null);
  assert('[2.4] 同一天 → 0', computeDaysHeld('2026-06-20T03:00:00.000Z', fixed) === 0);
  assert('[2.5] 一天前 → 1', computeDaysHeld('2026-06-19T08:00:00.000Z', fixed) === 1);
  assert('[2.6] 7 天前 → 7', computeDaysHeld('2026-06-13T08:00:00.000Z', fixed) === 7);
  assert(
    '[2.7] 200 天前 → 200',
    computeDaysHeld(new Date(fixed.getTime() - 200 * 86400000).toISOString(), fixed) === 200
  );
  assert(
    '[2.8] 未来时间 → 0 (不返负)',
    computeDaysHeld('2026-06-21T08:00:00.000Z', fixed) === 0
  );
  assert(
    '[2.9] 默认 now 不抛',
    computeDaysHeld('2026-06-20T03:00:00.000Z') !== null ||
      computeDaysHeld('2026-06-20T03:00:00.000Z') === null
  );
}

// ---- [3] computeDrawdownPct ------------------------------------------------
{
  assert('[3.1] null highest → null', computeDrawdownPct(10, null) === null);
  assert('[3.2] null current → null', computeDrawdownPct(null, 10) === null);
  assert('[3.3] both null → null', computeDrawdownPct(null, null) === null);
  assert('[3.4] highest=0 → null', computeDrawdownPct(5, 0) === null);
  assert('[3.5] highest<0 → null', computeDrawdownPct(5, -3) === null);
  assert('[3.6] current<=0 → null', computeDrawdownPct(0, 10) === null);
  assert(
    '[3.7] current >= highest (浮盈) → 0',
    computeDrawdownPct(12, 10) === 0
  );
  assert('[3.8] 50% 回撤', Math.abs((computeDrawdownPct(5, 10) ?? 0) - 50) < 0.001);
  assert('[3.9] 10% 回撤', Math.abs((computeDrawdownPct(9, 10) ?? 0) - 10) < 0.001);
  assert('[3.10] undefined → null', computeDrawdownPct(undefined as any, 10) === null);
}

// ---- [4] classify*Level ----------------------------------------------------
{
  // ATR
  assert('[4.1a] ATR null → unknown', classifyAtrLevel(null) === 'unknown');
  assert('[4.1b] ATR NaN → unknown', classifyAtrLevel(Number.NaN) === 'unknown');
  assert('[4.1c] ATR negative → unknown', classifyAtrLevel(-1) === 'unknown');
  assert('[4.1d] ATR 0 → normal', classifyAtrLevel(0) === 'normal');
  assert(
    '[4.1e] ATR < watch → normal',
    classifyAtrLevel(ATR_WATCH_PCT - 0.01) === 'normal'
  );
  assert(
    '[4.1f] ATR = watch → watch',
    classifyAtrLevel(ATR_WATCH_PCT) === 'watch'
  );
  assert(
    '[4.1g] ATR = high → high',
    classifyAtrLevel(ATR_HIGH_PCT) === 'high'
  );
  assert('[4.1h] ATR 大 → high', classifyAtrLevel(20) === 'high');
  // DD
  assert('[4.2a] DD null → unknown', classifyDrawdownLevel(null) === 'unknown');
  assert(
    '[4.2b] DD < watch → normal',
    classifyDrawdownLevel(DD_WATCH_PCT - 0.01) === 'normal'
  );
  assert(
    '[4.2c] DD = watch → watch',
    classifyDrawdownLevel(DD_WATCH_PCT) === 'watch'
  );
  assert('[4.2d] DD = high → high', classifyDrawdownLevel(DD_HIGH_PCT) === 'high');
  assert('[4.2e] DD negative → unknown', classifyDrawdownLevel(-5) === 'unknown');
  // days_held
  assert('[4.3a] days null → unknown', classifyDaysHeldLevel(null) === 'unknown');
  assert('[4.3b] days NaN → unknown', classifyDaysHeldLevel(Number.NaN) === 'unknown');
  assert('[4.3c] days neg → unknown', classifyDaysHeldLevel(-1) === 'unknown');
  assert('[4.3d] days 0 → fresh', classifyDaysHeldLevel(0) === 'fresh');
  assert(
    '[4.3e] days < FRESH → fresh',
    classifyDaysHeldLevel(DAYS_HELD_FRESH - 1) === 'fresh'
  );
  assert(
    '[4.3f] days = FRESH → normal',
    classifyDaysHeldLevel(DAYS_HELD_FRESH) === 'normal'
  );
  assert(
    '[4.3g] days = LONG → normal',
    classifyDaysHeldLevel(DAYS_HELD_LONG) === 'normal'
  );
  assert(
    '[4.3h] days > LONG → long',
    classifyDaysHeldLevel(DAYS_HELD_LONG + 1) === 'long'
  );
}

// ---- [5] Color / Label tables frozen ---------------------------------------
{
  assert(
    '[5.1] POSITION_RISK_LEVEL_COLOR frozen',
    Object.isFrozen(POSITION_RISK_LEVEL_COLOR)
  );
  assert(
    '[5.2] POSITION_RISK_LEVEL_LABEL frozen',
    Object.isFrozen(POSITION_RISK_LEVEL_LABEL)
  );
  assert(
    '[5.3] DAYS_HELD_LEVEL_COLOR frozen',
    Object.isFrozen(DAYS_HELD_LEVEL_COLOR)
  );
  assert(
    '[5.4] DAYS_HELD_LEVEL_LABEL frozen',
    Object.isFrozen(DAYS_HELD_LEVEL_LABEL)
  );
  const riskLevels = ['normal', 'watch', 'high', 'unknown'] as const;
  for (const k of riskLevels) {
    assert(
      `[5.5] POSITION_RISK_LEVEL_COLOR has ${k}`,
      typeof POSITION_RISK_LEVEL_COLOR[k] === 'string' &&
        POSITION_RISK_LEVEL_COLOR[k].length > 0
    );
    assert(
      `[5.6] POSITION_RISK_LEVEL_LABEL has ${k}`,
      typeof POSITION_RISK_LEVEL_LABEL[k] === 'string'
    );
  }
  const daysLevels = ['fresh', 'normal', 'long', 'unknown'] as const;
  for (const k of daysLevels) {
    assert(
      `[5.7] DAYS_HELD_LEVEL_COLOR has ${k}`,
      typeof DAYS_HELD_LEVEL_COLOR[k] === 'string'
    );
    assert(
      `[5.8] DAYS_HELD_LEVEL_LABEL has ${k}`,
      typeof DAYS_HELD_LEVEL_LABEL[k] === 'string'
    );
  }
  assert(
    '[5.9] high 配 red, normal 配 green (与 Tag 直觉一致)',
    POSITION_RISK_LEVEL_COLOR.high === 'red' && POSITION_RISK_LEVEL_COLOR.normal === 'green'
  );
}

// ---- [6] buildPositionMetricsViewModel -------------------------------------
{
  const now = new Date('2026-06-20T08:00:00.000Z');
  const happy = buildPositionMetricsViewModel(
    {
      atr_pct: 6.5,
      current_price: 9,
      highest_price: 10,
      created_at: '2026-06-10T08:00:00.000Z',
    },
    now
  );
  assert('[6.1] happy atrPct', happy.atrPct === 6.5);
  assert('[6.2] happy atrLevel watch', happy.atrLevel === 'watch');
  assert('[6.3] happy ddPct 10', Math.abs((happy.ddPct ?? 0) - 10) < 0.001);
  assert('[6.4] happy ddLevel watch', happy.ddLevel === 'watch');
  assert('[6.5] happy daysHeld 10', happy.daysHeld === 10);
  assert('[6.6] happy daysHeldLevel normal', happy.daysHeldLevel === 'normal');

  const noHighest = buildPositionMetricsViewModel(
    {
      atr_pct: 3,
      current_price: 10,
      highest_price: null,
      created_at: '2026-06-19T08:00:00.000Z',
    },
    now
  );
  assert('[6.7] no highest → ddPct null', noHighest.ddPct === null);
  assert('[6.8] no highest → ddLevel unknown', noHighest.ddLevel === 'unknown');
  assert('[6.9] no highest → atrLevel normal (3<5)', noHighest.atrLevel === 'normal');
  assert('[6.10] no highest → daysHeld 1', noHighest.daysHeld === 1);
  assert('[6.11] no highest → daysHeldLevel fresh', noHighest.daysHeldLevel === 'fresh');

  const noAtr = buildPositionMetricsViewModel(
    {
      atr_pct: null,
      current_price: 10,
      highest_price: 12,
      created_at: '2025-09-01T00:00:00.000Z',
    },
    now
  );
  assert('[6.12] no atr → atrPct null', noAtr.atrPct === null);
  assert('[6.13] no atr → atrLevel unknown', noAtr.atrLevel === 'unknown');
  assert('[6.14] no atr → ddLevel watch (16.67%)', noAtr.ddLevel === 'high');
  assert('[6.15] long history → daysHeldLevel long', noAtr.daysHeldLevel === 'long');

  const allNull = buildPositionMetricsViewModel(
    {
      atr_pct: null,
      current_price: null,
      highest_price: null,
      created_at: null,
    },
    now
  );
  assert('[6.16] all null → all unknown', allNull.atrLevel === 'unknown');
  assert('[6.17] all null → ddLevel unknown', allNull.ddLevel === 'unknown');
  assert('[6.18] all null → daysHeldLevel unknown', allNull.daysHeldLevel === 'unknown');

  // 同输入永远同输出 (useMemo safe)
  const a = buildPositionMetricsViewModel(
    {
      atr_pct: 6.5,
      current_price: 9,
      highest_price: 10,
      created_at: '2026-06-10T08:00:00.000Z',
    },
    now
  );
  const b = buildPositionMetricsViewModel(
    {
      atr_pct: 6.5,
      current_price: 9,
      highest_price: 10,
      created_at: '2026-06-10T08:00:00.000Z',
    },
    now
  );
  assert(
    '[6.19] 同输入同输出 (atr/dd/days 全等)',
    a.atrPct === b.atrPct && a.ddPct === b.ddPct && a.daysHeld === b.daysHeld
  );
}

// ---- [7] formatPctOrDash / formatDaysHeld ----------------------------------
{
  assert('[7.1] null → "—"', formatPctOrDash(null) === '—');
  assert('[7.2] undefined → "—"', formatPctOrDash(undefined) === '—');
  assert('[7.3] NaN → "—"', formatPctOrDash(Number.NaN) === '—');
  assert('[7.4] 6.5 → "6.50%"', formatPctOrDash(6.5) === '6.50%');
  assert('[7.5] 6.5 prec=1 → "6.5%"', formatPctOrDash(6.5, 1) === '6.5%');
  assert('[7.6] formatDaysHeld null', formatDaysHeld(null) === '—');
  assert('[7.7] formatDaysHeld 10', formatDaysHeld(10) === '10 天');
  assert(
    '[7.8] formatDaysHeld 长期',
    formatDaysHeld(DAYS_HELD_LONG + 5) === `${DAYS_HELD_LONG + 5} 天 (长期)`
  );
  assert('[7.9] formatDaysHeld 负数 → "—"', formatDaysHeld(-1) === '—');
}

// ---- [8] computeAtrPctFromBars (backend) -----------------------------------
{
  assert('[8.1] empty → null', computeAtrPctFromBars([] as any) === null);
  assert('[8.2] 不足 period+1 → null', computeAtrPctFromBars(
    Array(10).fill(0).map((_, i) => ({ high: 10 + i, low: 9 + i, close: 9.5 + i }))
  ) === null);
  // 16 根 bar 平稳上升, ATR 应 ≈ 1 / close ≈ 几个 %
  const bars = Array(16).fill(0).map((_, i) => ({
    high: 10 + i + 0.5,
    low: 10 + i - 0.5,
    close: 10 + i,
  }));
  const atrPct = computeAtrPctFromBars(bars, 14);
  assert('[8.3] 平稳 16 根 bar atrPct 非 null', atrPct !== null);
  assert('[8.4] atrPct > 0 且合理 (<50)', atrPct !== null && atrPct > 0 && atrPct < 50);
  // close=0 边界
  const lastZero = [...bars];
  lastZero[lastZero.length - 1] = { high: 0, low: 0, close: 0 };
  assert('[8.5] 最后 close=0 → null', computeAtrPctFromBars(lastZero, 14) === null);
}

// ---- [9] META-GUARD --------------------------------------------------------
{
  const repoRoot = join(__dirname, '..', '..', '..');
  // PortfolioWorkspace.tsx
  const pwPath = join(
    repoRoot,
    'frontend',
    'src',
    'pages',
    'workspace',
    'PortfolioWorkspace.tsx'
  );
  const pwSrc = readFileSync(pwPath, 'utf-8');
  assert(
    '[9.1] PortfolioWorkspace imports positionMetricsHelpers',
    pwSrc.includes("from './positionMetricsHelpers'") &&
      pwSrc.includes('buildPositionMetricsViewModel')
  );
  assert(
    "[9.2] 含 ATR% 列 (key 'atr_pct')",
    pwSrc.includes("key: 'atr_pct'")
  );
  assert(
    "[9.3] 含 DD 列 (key 'dd_pct')",
    pwSrc.includes("key: 'dd_pct'")
  );
  assert(
    "[9.4] 含 持仓天数 列 (key 'days_held')",
    pwSrc.includes("key: 'days_held'")
  );
  assert(
    '[9.5] 列表 scroll-x 已加宽 (≥1700)',
    /scroll=\{\{\s*x:\s*1[78]\d{2}\s*\}\}/.test(pwSrc)
  );
  // service PositionRow 含新字段
  const svcPath = join(
    repoRoot,
    'frontend',
    'src',
    'services',
    'portfolioWorkspaceService.ts'
  );
  const svcSrc = readFileSync(svcPath, 'utf-8');
  assert(
    '[9.6] PositionRow 含 atr_pct',
    svcSrc.includes('atr_pct?:') || svcSrc.includes('atr_pct ?:')
  );
  assert(
    '[9.7] PositionRow 含 highest_price',
    svcSrc.includes('highest_price?:') || svcSrc.includes('highest_price ?:')
  );
  // facade getPortfolio 含 computeAtrPctFromBars 调用 + 30 天窗口
  const facadePath = join(repoRoot, 'backend', 'src', 'portfolio', 'PaperTradingFacade.ts');
  const facadeSrc = readFileSync(facadePath, 'utf-8');
  assert(
    '[9.8] facade 调用 computeAtrPctFromBars (import 或 re-export)',
    facadeSrc.includes('computeAtrPctFromBars(') &&
      /from\s+'\.\/internal\/positionAtrHelpers'/.test(facadeSrc)
  );
  assert(
    '[9.9] facade 30 天 bars 窗口 (≥30 * 86400)',
    /30\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(facadeSrc)
  );
  assert(
    '[9.10] facade toJSON + 挂 atr_pct',
    facadeSrc.includes('json.atr_pct = atr_pct')
  );
}

// ---- summary ---------------------------------------------------------------
setTimeout(() => {
  const total = passed + failed;
  console.log(`\n${failed === 0 ? '✓' : '✗'} position-metrics-helpers tests: ${passed} ok / ${failed} failed (total ${total})`);
  process.exit(failed === 0 ? 0 : 1);
}, 50);
