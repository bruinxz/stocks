/**
 * 集成 smoke test — Sprint 1-3 五个新 service 端到端验证
 *
 * 模拟一次完整的决策流程：
 *
 *   1. 输入: 5 个候选股票 + 各自历史 daily_returns + alpha_scores
 *
 *   2. 候选过滤 (MetaLabel 已退役, pass-through) — 见批5 §5.1/§5.2
 *
 *   3. ExecutionFeasibility 评估 — 涨跌停 / 流动性 / spread / 状态约束
 *
 *   4. PortfolioConstruction 构造 — Risk Parity + 行业约束 + 总仓位约束
 *
 *   5. ResearchIntegrity 审计 — DSR / OOS decay
 *
 *   6. Governor 评估 — 5 档 Kelly 倍数
 *
 * 全部在内存 + fake data source，不依赖 DB，可在 CI 跑。
 */
import {
  ResearchIntegrityService,
  ResearchIntegrityDataSource,
} from '../../src/services/research/ResearchIntegrityService';
import {
  ExecutionFeasibilityService,
  ExecutionFeasibilityDataSource,
} from '../../src/services/execution/ExecutionFeasibilityService';
import { PortfolioConstructionService } from '../../src/services/portfolio/PortfolioConstructionService';
import {
  EquityCurveGovernorService,
  GovernorDataSource,
} from '../../src/services/governor/EquityCurveGovernorService';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

interface Candidate {
  symbol: string;
  industry: string;
  alpha_score: number; // 0-100
  daily_returns: number[];
  source: 'quant' | 'ai' | 'recommendation';
}

function makeCandidates(): Candidate[] {
  // 生成 6 个候选 — 3 银行 / 2 消费 / 1 科技；不同 alpha 分数 + 波动率
  const random = (seed: number) => {
    let s = seed;
    return () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  };
  const rng = random(42);
  const make = (symbol: string, industry: string, alpha: number, vol: number, source: 'quant' | 'ai' | 'recommendation') => ({
    symbol,
    industry,
    alpha_score: alpha,
    source,
    daily_returns: Array.from({ length: 25 }, () => (rng() - 0.5) * vol * 2),
  });
  return [
    make('sh.600000', '银行', 85, 0.02, 'quant'),
    make('sh.600036', '银行', 78, 0.022, 'quant'),
    make('sz.000001', '银行', 72, 0.018, 'ai'),
    make('sh.600519', '消费', 88, 0.025, 'quant'),
    make('sz.000858', '消费', 75, 0.024, 'recommendation'),
    make('sz.300750', '科技', 82, 0.03, 'ai'),
  ];
}

async function main() {
  console.log('\n## End-to-end integration smoke test\n');

  // ============================================================
  // Step 1: 创建所有 service 实例 (默认 in-process)
  // ============================================================

  // ResearchIntegrity: 用 fake source 返回 backtest 统计
  const fakeRiSource: ResearchIntegrityDataSource = {
    async loadBacktestStats() {
      return { observed_sharpe: 1.8, oos_sharpe: 1.2, num_trials: 10, sample_length: 252, strategy_key: 'multi_factor_alpha' };
    },
  };
  const riService = new ResearchIntegrityService(fakeRiSource);

  // ExecutionFeasibility: fake source 模拟正常市场
  const fakeFeasibilitySource: ExecutionFeasibilityDataSource = {
    async loadMarketSnapshot(symbol) {
      // 模拟正常股票
      return {
        close: 10 + Math.random() * 2,
        open: 9.95,
        high: 10.1,
        low: 9.9,
        prev_close: 10,
        volume: 1000000,
        avg_volume_5d: 800000,
        is_limit_up: false,
        is_limit_down: false,
        is_suspended: false,
        is_st: symbol.includes('300') ? false : false,
      };
    },
  };
  const feasibilityService = new ExecutionFeasibilityService(fakeFeasibilitySource);

  const portfolioService = new PortfolioConstructionService();

  // Governor: fake source — 模拟健康 portfolio
  const fakeGovernorSource: GovernorDataSource = {
    async loadAllPortfolios() {
      return [{ portfolio_id: 1, user_id: 100 }];
    },
    async loadStats() {
      return {
        sharpe_30d: 1.5,
        drawdown_current: 0.04,
        winrate_30d: 0.62,
        trades_30d: 20,
        snapshots_count: 30,
      };
    },
    async loadPreviousTier() {
      return null;
    },
  };
  const governorService = new EquityCurveGovernorService(fakeGovernorSource);

  // ============================================================
  // Step 2: 输入 — 6 个候选股票
  // ============================================================
  const candidates = makeCandidates();
  assert('6 个候选股票准备就绪', candidates.length === 6);

  // ============================================================
  // Step 3: 候选过滤 — 批5 旧 MetaLabelService (v1 logistic) 已退役,
  //   运行期改用 ConfidenceCalibrationService(Wilson) + EV gate (见 §5.1/§5.2)。
  //   本集成测试聚焦 Feasibility/Portfolio/Governor 链路, 候选过滤此处 pass-through。
  // ============================================================
  const survived = [...candidates];

  // ============================================================
  // Step 4: ExecutionFeasibility 评估 — 每个候选都 fillable?
  // ============================================================
  const fillableCandidates: Candidate[] = [];
  for (const c of survived) {
    const r = await feasibilityService.computeFeasibility(
      { symbol: c.symbol, side: 'BUY', target_qty: 1000, as_of_date: '2026-06-13' },
      { persist: false }
    );
    if (r.decision === 'fillable' || r.decision === 'risky') {
      fillableCandidates.push(c);
    }
  }
  console.log(`  → Feasibility: ${fillableCandidates.length}/${survived.length} 个候选可成交`);
  assert('Feasibility 全部 fillable (mock 数据均正常)', fillableCandidates.length === survived.length);

  // ============================================================
  // Step 5: PortfolioConstruction 构造组合 — Risk Parity
  // ============================================================
  const constructionResult = await portfolioService.construct(
    {
      as_of_date: '2026-06-13',
      candidates: fillableCandidates.map(c => ({
        symbol: c.symbol,
        industry: c.industry,
        alpha_score: c.alpha_score,
        daily_returns: c.daily_returns,
      })),
    },
    {
      method: 'risk_parity',
      max_weight: 0.30,
      max_industry_weight: 0.50,
      total_allocation: 0.95,
      persist: false,
    }
  );
  console.log(`  → PortfolioConstruction: ${constructionResult.weights.length} 个 weights`);
  console.log(`    weights: [${constructionResult.weights.map(w => (w * 100).toFixed(1)).join(', ')}]%`);
  console.log(`    industry: ${JSON.stringify(constructionResult.industry_exposure)}`);
  assert('权重数量 = fillable 数', constructionResult.weights.length === fillableCandidates.length);
  assert(
    '行业最大不超过 0.51 (cap 0.50 + epsilon)',
    Math.max(...Object.values(constructionResult.industry_exposure)) <= 0.51
  );
  assert(
    '总仓位 <= total_allocation',
    Math.abs(constructionResult.total_allocation - 0.95) < 0.01 ||
      constructionResult.total_allocation < 0.95
  );

  // ============================================================
  // Step 6: ResearchIntegrity 审计回测
  // ============================================================
  const riReport = await riService.auditBacktest(
    {
      backtest_id: 100,
      source: 'quant_backtest_result',
      strategy_key: 'multi_factor_alpha',
    },
    { persist: false }
  );
  console.log(`  → ResearchIntegrity: verdict=${riReport.verdict} DSR=${riReport.dsr?.toFixed(3)}`);
  assert('RI verdict 不是 INSUFFICIENT (DSR / OOS 都有数据)', riReport.verdict !== 'INSUFFICIENT');

  // ============================================================
  // Step 7: Governor 评估 portfolio 健康度
  // ============================================================
  const govResult = await governorService.evaluatePortfolio(
    { portfolio_id: 1, user_id: 100 },
    { persist: false }
  );
  console.log(`  → Governor: tier=${govResult.tier} multiplier=${govResult.kelly_multiplier}`);
  assert('healthy portfolio → tier=healthy', govResult.tier === 'healthy');
  assert('healthy → multiplier=1.0', govResult.kelly_multiplier === 1.0);

  // ============================================================
  // Step 8: 模拟应用 Governor multiplier 到最终下单量
  // ============================================================
  const targetTotalCapital = 1_000_000;
  const finalOrders = constructionResult.symbols.map((sym, i) => {
    const w = constructionResult.weights[i];
    const adjustedW = w * govResult.kelly_multiplier;
    return {
      symbol: sym,
      target_amount: targetTotalCapital * adjustedW,
      weight_raw: w,
      weight_after_governor: adjustedW,
    };
  });
  console.log('\n  Final orders (after Governor):');
  for (const o of finalOrders) {
    console.log(`    ${o.symbol}: ¥${o.target_amount.toFixed(0)} (${(o.weight_after_governor * 100).toFixed(1)}%)`);
  }
  const totalFinal = finalOrders.reduce((s, o) => s + o.target_amount, 0);
  assert(
    'Final 下单总额 = total_allocation × multiplier × capital',
    Math.abs(totalFinal - targetTotalCapital * constructionResult.total_allocation * govResult.kelly_multiplier) < 1
  );

  // ============================================================
  // Summary
  // ============================================================
  console.log(`\n========================================`);
  console.log(`E2E Integration Smoke Test: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
