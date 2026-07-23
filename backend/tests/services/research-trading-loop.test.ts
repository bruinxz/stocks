import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  ResearchTradingLoopService,
  buildResearchLoopDecisions,
  canSellPositionOnTradingDay,
  hasResearchLoopPositionCapacity,
  isResearchLoopPriceFresh,
  mergeResearchCandidates,
  selectResearchLoopTargets,
  type ResearchBundle,
  type ResearchLoopPortfolioRow,
  type ResearchTradingLoopRepository,
} from '../../src/services/ResearchTradingLoopService';

function source(
  source_id: string,
  symbol: string,
  score: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    source_id,
    symbol,
    name: `股票${symbol.slice(-2)}`,
    score,
    rating: 'A',
    risk_gate_status: 'GREEN',
    ...overrides,
  };
}

function bundle(overrides: Partial<ResearchBundle> = {}): ResearchBundle {
  return {
    expected_research_day: '2026-07-21',
    morning: {
      snapshot_id: '11111111-1111-4111-8111-111111111111',
      research_day: '2026-07-21',
      as_of: '2026-07-22T01:03:00.000Z',
      candidates: [],
    },
    multibagger: {
      research_day: '2026-07-21',
      as_of: '2026-07-22T01:04:00.000Z',
      candidates: [],
    },
    ...overrides,
  };
}

function testMergeAndPriority() {
  const input = bundle();
  input.morning.candidates = [
    source('m1', '600001.SH', 62),
    source('m2', '600002.SH', 99),
    source('m3', '600003.SH', 30),
  ];
  input.multibagger.candidates = [
    source('b1', '600001.SH', 58),
    source('b2', '600004.SH', 90),
    source('b3', '600099.SH', 100, { risk_gate_status: 'RED' }),
  ];
  const merged = mergeResearchCandidates(input);
  assert.equal(merged[0].symbol, 'sh.600001', '双源候选必须排在单源高分候选之前');
  assert.equal(merged[0].target_weight_pct, 12);
  assert.equal(merged.find(row => row.symbol === 'sh.600002')?.target_weight_pct, 9);
  assert.equal(merged.find(row => row.symbol === 'sh.600004')?.target_weight_pct, 6);
  assert(
    merged.some(row => row.symbol === 'sh.600003'),
    '不得复活历史 min_score 门槛'
  );
  assert(!merged.some(row => row.symbol === 'sh.600099'), '红灯风险候选必须失效');
}

function testBuyHoldSellAndSixPositionCap() {
  const input = bundle();
  input.morning.candidates = Array.from({ length: 8 }, (_, index) =>
    source(`m${index + 1}`, `60000${index + 1}.SH`, 90 - index)
  );
  const positions = [
    {
      id: 1,
      symbol: 'sh.600001',
      name: '第一名',
      quantity: 100,
      avg_cost: 10,
      current_price: 10.5,
      created_at: new Date('2026-07-20T01:35:00.000Z'),
    },
    {
      id: 2,
      symbol: 'sh.600007',
      name: '第七名',
      quantity: 100,
      avg_cost: 10,
      current_price: 10,
      created_at: new Date('2026-07-20T01:35:00.000Z'),
    },
    {
      id: 3,
      symbol: 'sh.600099',
      name: '已退出研究池',
      quantity: 100,
      avg_cost: 10,
      current_price: 10,
      created_at: new Date('2026-07-20T01:35:00.000Z'),
    },
    {
      id: 4,
      symbol: 'sh.600002',
      name: '硬止损',
      quantity: 100,
      avg_cost: 10,
      current_price: 9,
      created_at: new Date('2026-07-20T01:35:00.000Z'),
    },
  ];
  const prices = new Map(
    positions.map(row => [
      row.symbol,
      {
        symbol: row.symbol,
        name: row.name,
        price: row.current_price,
        quote_time: new Date('2026-07-22T01:34:00.000Z'),
        trade_date: '2026-07-22',
      },
    ])
  );
  const decisions = buildResearchLoopDecisions({ bundle: input, positions, prices });
  assert.equal(decisions.find(row => row.symbol === 'sh.600001')?.action, 'HOLD');
  assert.equal(decisions.find(row => row.symbol === 'sh.600007')?.action, 'SELL');
  assert.equal(decisions.find(row => row.symbol === 'sh.600099')?.action, 'SELL');
  assert.match(decisions.find(row => row.symbol === 'sh.600002')?.reason || '', /硬止损/);
  assert.equal(decisions.filter(row => row.action === 'BUY').length, 4);
  const heldTargetCount = decisions.filter(row => row.action === 'HOLD').length;
  const boughtTargetCount = decisions.filter(row => row.action === 'BUY').length;
  assert.equal(heldTargetCount + boughtTargetCount, 5, '硬止损卖出后最多保留六只且不得保留第七名');
}

function testSourceDiversityWithDifferentScoreScales() {
  const input = bundle();
  input.morning.candidates = Array.from({ length: 8 }, (_, index) =>
    source(`m${index + 1}`, `6001${String(index + 1).padStart(2, '0')}.SH`, 72 - index * 0.7)
  );
  input.multibagger.candidates = Array.from({ length: 8 }, (_, index) =>
    source(`b${index + 1}`, `3001${String(index + 1).padStart(2, '0')}.SZ`, 66 - index * 0.7)
  );
  const targets = selectResearchLoopTargets(input);
  assert.equal(targets.length, 6);
  assert.equal(
    targets.filter(candidate => candidate.sources.some(item => item.source === 'multibagger'))
      .length,
    2,
    '评分标尺较低时，高倍潜力仍必须实际进入六仓目标池'
  );
  assert.equal(
    targets.filter(candidate => candidate.sources.some(item => item.source === 'morning_brief'))
      .length,
    4
  );
}

function testTPlusOne() {
  assert.equal(
    canSellPositionOnTradingDay(new Date('2026-07-22T01:35:00.000Z'), '2026-07-22'),
    false,
    '当日买入不得当日卖出'
  );
  assert.equal(
    canSellPositionOnTradingDay(new Date('2026-07-21T06:30:00.000Z'), '2026-07-22'),
    true,
    '上一交易日买入允许卖出'
  );
}

function testHardPositionCapacity() {
  assert.equal(hasResearchLoopPositionCapacity(5), true);
  assert.equal(hasResearchLoopPositionCapacity(6), false);
  assert.equal(hasResearchLoopPositionCapacity(7), false);
}

function testQuoteFreshness() {
  const now = new Date('2026-07-24T01:35:00.000Z');
  const fresh = {
    symbol: 'sh.600001',
    name: '测试股票',
    price: 10,
    quote_time: new Date('2026-07-24T01:30:00.000Z'),
    trade_date: '2026-07-24',
  };
  assert.equal(isResearchLoopPriceFresh(fresh, '2026-07-24', now), true);
  assert.equal(
    isResearchLoopPriceFresh(
      { ...fresh, quote_time: new Date('2026-07-24T00:59:59.000Z') },
      '2026-07-24',
      now
    ),
    false,
    '超过 30 分钟的报价不得占用当日 run'
  );
  assert.equal(
    isResearchLoopPriceFresh({ ...fresh, trade_date: '2026-07-23' }, '2026-07-24', now),
    false,
    '上一交易日报价不得用于今日模拟成交'
  );
}

class FakeRepository implements ResearchTradingLoopRepository {
  ready_count = 0;
  ensure_count = 0;
  claim_count = 0;
  execution_count = 0;
  completed_count = 0;
  portfolio_load_count = 0;
  stale = false;
  prices_ready = true;

  async assertReady() {
    this.ready_count += 1;
  }
  async ensureLoopPortfolios() {
    this.ensure_count += 1;
  }
  async loadLoopPortfolios(): Promise<ResearchLoopPortfolioRow[]> {
    this.portfolio_load_count += 1;
    return [
      {
        id: 10,
        user_id: 4,
        name: '研究闭环模拟盘',
        initial_capital: 200000,
        current_cash: 200000,
        total_value: 200000,
      },
    ];
  }
  async loadResearchBundle() {
    const value = bundle();
    value.morning.candidates = [source('m1', '600001.SH', 80)];
    if (this.stale) value.multibagger.research_day = '2026-07-16';
    return value;
  }
  async loadPositions() {
    return [];
  }
  async loadPrices(_symbols: string[], trading_day: string) {
    if (!this.prices_ready) return new Map();
    return new Map([
      [
        'sh.600001',
        {
          symbol: 'sh.600001',
          name: '测试股票',
          price: 10,
          quote_time: new Date(`${trading_day}T01:34:00.000Z`),
          trade_date: trading_day,
        },
      ],
    ]);
  }
  async claimRun(input: any) {
    this.claim_count += 1;
    if (this.claim_count > 1) return null;
    return {
      id: 88,
      user_id: input.portfolio.user_id,
      portfolio_id: input.portfolio.id,
      trading_day: input.trading_day,
      research_day: input.research_day,
      status: 'running',
    };
  }
  async executeDecision(input: any) {
    this.execution_count += 1;
    return { status: input.decision.action === 'HOLD' ? 'held' : 'executed', trade_id: 1 };
  }
  async markToMarket() {}
  async completeRun() {
    this.completed_count += 1;
  }
  async loadDashboard() {
    return null;
  }
}

async function testFreshnessAndIdempotency() {
  const freshRepo = new FakeRepository();
  const service = new ResearchTradingLoopService(freshRepo);
  const now = new Date('2026-07-22T01:35:00.000Z');
  const first: any = await service.run({ user_id: 4, now });
  const second: any = await service.run({ user_id: 4, now });
  assert.equal(first.status, 'completed');
  assert.equal(freshRepo.execution_count, 1, '同一用户同一天只执行一轮交易');
  assert.equal(second.users[0].status, 'deduped');

  const staleRepo = new FakeRepository();
  staleRepo.stale = true;
  const stale: any = await new ResearchTradingLoopService(staleRepo).run({ now });
  assert.equal(stale.status, 'skipped');
  assert.equal(stale.reason, 'research_not_fresh');
  assert.equal(staleRepo.portfolio_load_count, 0, '任一研究源过期时禁止触碰交易账户');

  const closedRepo = new FakeRepository();
  const closed: any = await new ResearchTradingLoopService(closedRepo).run({
    now: new Date('2026-07-22T00:00:00.000Z'),
  });
  assert.equal(closed.reason, 'market_closed');
  assert.equal(closedRepo.ready_count, 0, '非交易时段不需要探测研究闭环结构');
  assert.equal(closedRepo.ensure_count, 0, '非交易时段不得创建或执行账户');

  const quoteWaitingRepo = new FakeRepository();
  quoteWaitingRepo.prices_ready = false;
  const waiting: any = await new ResearchTradingLoopService(quoteWaitingRepo).run({
    now: new Date('2026-07-22T01:35:00.000Z'),
  });
  assert.equal(waiting.status, 'waiting_for_quotes');
  assert.equal(quoteWaitingRepo.claim_count, 0, '报价未齐不得占用幂等 run，9:50 必须可重试');
  assert.equal(quoteWaitingRepo.execution_count, 0, '报价未齐不得生成成交决策');
}

async function testDashboardExecutionState() {
  const preopenRepo = new FakeRepository();
  const preopen: any = await new ResearchTradingLoopService(preopenRepo).getDashboard(
    4,
    new Date('2026-07-22T01:20:00.000Z')
  );
  assert.equal(preopen.execution.status, 'scheduled');
  assert.equal(preopen.execution.next_attempt_label, '今日 09:35');
  assert.match(preopen.execution.message, /不会|行情齐全/);
  assert.equal(preopenRepo.portfolio_load_count, 0, '盘前状态不应伪装成行情就绪检查');

  const quoteWaitingRepo = new FakeRepository();
  quoteWaitingRepo.prices_ready = false;
  const quoteWaiting: any = await new ResearchTradingLoopService(quoteWaitingRepo).getDashboard(
    4,
    new Date('2026-07-22T01:35:00.000Z')
  );
  assert.equal(quoteWaiting.execution.status, 'waiting_for_quotes');
  assert.equal(quoteWaiting.execution.required_quote_count, 1);
  assert.equal(quoteWaiting.execution.fresh_quote_count, 0);
  assert.match(quoteWaiting.execution.message, /不会使用昨日收盘价伪造成交/);

  const staleRepo = new FakeRepository();
  staleRepo.stale = true;
  const stale: any = await new ResearchTradingLoopService(staleRepo).getDashboard(
    4,
    new Date('2026-07-22T01:35:00.000Z')
  );
  assert.equal(stale.execution.status, 'research_blocked');
  assert.match(stale.execution.message, /已暂停/);
}

function testPipelineContracts() {
  const root = path.resolve(__dirname, '../../..');
  const scheduler = fs.readFileSync(
    path.join(root, 'backend/src/services/SchedulerService.ts'),
    'utf8'
  );
  const globalSync = fs.readFileSync(
    path.join(root, 'scripts/ops/sync_global_markets_daily.py'),
    'utf8'
  );
  const multibaggerController = fs.readFileSync(
    path.join(root, 'backend/src/api/controllers/MultibaggerController.ts'),
    'utf8'
  );
  const migration = fs.readFileSync(
    path.join(root, 'backend/scripts/migrations/2026-07-22-research-trading-loop.sql'),
    'utf8'
  );
  const schemaMigration = fs.readFileSync(
    path.join(root, 'backend/scripts/migrations/2026-07-24-research-trading-loop-schema.sql'),
    'utf8'
  );
  const runtimeMigration = fs.readFileSync(
    path.join(root, 'scripts/deployment/runtime_schema_migration.js'),
    'utf8'
  );
  const deployment = fs.readFileSync(
    path.join(root, 'scripts/deployment/deploy_remote_build.sh'),
    'utf8'
  );
  assert.match(
    scheduler,
    /type: 'RESEARCH_TRADING_LOOP'[\s\S]{0,160}cron_expression: '35,50 9 \* \* 1-5'/
  );
  const loopService = fs.readFileSync(
    path.join(root, 'backend/src/services/ResearchTradingLoopService.ts'),
    'utf8'
  );
  assert.match(loopService, /hasResearchLoopPositionCapacity\(activePositions\.length\)/);
  assert.match(loopService, /status = 'running'[\s\S]{0,180}INTERVAL '30 minutes'/);
  assert.match(
    loopService,
    /UPDATE paper_trading_portfolios[\s\S]{0,1000}auto_trade_enabled = TRUE/,
    '半迁移的旧账户必须在执行前归一化为唯一研究闭环盘'
  );
  assert.match(
    globalSync,
    /refresh_multibagger_cn_a[\s\S]{0,200}populate_live_multibagger\.py|populate_live_multibagger\.py[\s\S]{0,300}refresh_multibagger_cn_a/
  );
  assert.match(multibaggerController, /latest_batches[\s\S]{0,500}MAX\(as_of_utc\)/);
  assert.match(
    migration,
    /runtime_data_migrations[\s\S]{0,4000}TRUNCATE TABLE paper_trading_portfolios/
  );
  assert.match(migration, /uq_research_loop_active_portfolio_per_user/);
  assert.match(schemaMigration, /CREATE TABLE IF NOT EXISTS research_trading_loop_runs/);
  assert.match(schemaMigration, /CREATE TABLE IF NOT EXISTS research_trading_loop_decisions/);
  assert.doesNotMatch(schemaMigration, /TRUNCATE|DELETE FROM|INSERT INTO paper_trading_portfolios/);
  assert.match(runtimeMigration, /2026-07-24-research-trading-loop-schema\.sql/);
  assert.doesNotMatch(runtimeMigration, /2026-07-22-research-trading-loop\.sql/);
  const migrationRetirementBlock = migration.slice(migration.indexOf('-- 旧自动跟单'));
  const schedulerRetirementBlock = scheduler.slice(scheduler.indexOf('// 研究闭环上线后'));
  for (const retiredType of [
    'PAPER_TRADING_ATTRIBUTION_REPORT',
    'RECOMMENDATION_TRADE_OUTCOME_REFRESH',
  ]) {
    assert(
      migrationRetirementBlock.includes(`'${retiredType}'`),
      `${retiredType} 必须由一次性迁移停用，防止旧盘复活`
    );
    assert(
      schedulerRetirementBlock.includes(`'${retiredType}'`),
      `${retiredType} 必须在每次启动后保持停用`
    );
  }
  assert.match(
    migrationRetirementBlock,
    /type = 'PAPER_TRADING_DAILY_DIGEST'[\s\S]{0,300}parameters \? 'portfolio_id'/
  );
  assert.match(
    schedulerRetirementBlock,
    /type: 'PAPER_TRADING_DAILY_DIGEST'[\s\S]{0,400}parameters[^\n]*portfolio_id/
  );
  assert.match(
    schedulerRetirementBlock,
    /is_active: true[\s\S]{0,240}name: '飞书当日交易日报'[\s\S]{0,240}NOT \(\"parameters\" \? 'portfolio_id'\)/
  );
  assert.match(
    schedulerRetirementBlock,
    /PAPER_TRADING_DAILY_DIGEST'[\s\S]{0,500}per_strategy_limit'[\s\S]{0,120}perStrategyLimit'/
  );
  assert.match(
    migrationRetirementBlock,
    /SET is_active = TRUE[\s\S]{0,240}name = '飞书当日交易日报'[\s\S]{0,240}NOT \(parameters \? 'portfolio_id'\)/
  );
  assert.match(
    deployment,
    /APPLY_RESEARCH_TRADING_LOOP_SCHEMA=1[\s\S]{0,120}apply-research-trading-loop-schema\.js/
  );
  assert.match(
    deployment,
    /if \[\[ "\$\{APPLY_RESEARCH_TRADING_LOOP_RESET:-false\}" == "true" \]\][\s\S]{0,400}APPLY_RESEARCH_TRADING_LOOP_MIGRATION=1/
  );
}

async function main() {
  testMergeAndPriority();
  testBuyHoldSellAndSixPositionCap();
  testSourceDiversityWithDifferentScoreScales();
  testTPlusOne();
  testHardPositionCapacity();
  testQuoteFreshness();
  await testFreshnessAndIdempotency();
  await testDashboardExecutionState();
  testPipelineContracts();
  console.log('research trading loop tests passed');
}

void main();
