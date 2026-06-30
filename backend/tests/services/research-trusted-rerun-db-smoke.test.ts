/**
 * DB smoke for phase-1 trusted rerun closure.
 *
 * This is intentionally opt-in because it writes to the shared dev database and
 * needs a local Redis instance. Run with:
 *
 *   RUN_DB_SMOKE=1 REDIS_DB=9 npx ts-node --transpile-only tests/services/research-trusted-rerun-db-smoke.test.ts
 */

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function nextDay(date: Date) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function generateWeekdays(start: string, end: string) {
  const dates: string[] = [];
  let cursor = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= endDate) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(dateOnly(cursor));
    cursor = nextDay(cursor);
  }
  return dates;
}

function buildSmokeBars(stock_id: number) {
  const dates = generateWeekdays('2024-11-01', '2025-04-30');
  let prevClose = 10;
  return dates.map((day, index) => {
    const trendStep = Math.max(0, index - 30);
    const close =
      index < 30
        ? 10 - index * 0.01
        : index < 78
        ? 9.7 + trendStep * 0.08
        : 13.5 - Math.max(0, index - 78) * 0.015;
    const open = prevClose * 1.002;
    const high = Math.max(open, close) * 1.01;
    const low = Math.min(open, close) * 0.99;
    const volume = 2_000_000 + index * 1000;
    const change_percent = index === 0 ? 0 : ((close - prevClose) / prevClose) * 100;
    prevClose = close;
    return {
      stock_id,
      time: new Date(`${day}T00:00:00.000Z`),
      open: Number(open.toFixed(4)),
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
      volume,
      turnover: Number((close * volume).toFixed(4)),
      adj_close: Number(close.toFixed(4)),
      turnover_rate: 2,
      change_percent: Number(change_percent.toFixed(4)),
      amplitude: 2,
      is_trading_day: true,
      is_suspended: false,
    };
  });
}

async function main() {
  if (process.env.RUN_DB_SMOKE !== '1') {
    console.log('\n## Trusted rerun DB smoke');
    console.log('  skip RUN_DB_SMOKE is not set to 1');
    return;
  }

  const { Op, QueryTypes } = await import('sequelize');
  const { default: sequelize } = await import('../../src/config/database');
  const { Stock } = await import('../../src/models/Stock');
  const { DailyBar } = await import('../../src/models/DailyBar');
  const { QuantBacktestTask } = await import('../../src/models/QuantBacktestTask');
  const { QuantBacktestResult } = await import('../../src/models/QuantBacktestResult');
  const { QuantBacktestTrade } = await import('../../src/models/QuantBacktestTrade');
  const { QuantResearchArtifact } = await import('../../src/models/QuantResearchArtifact');
  const { QuantResearchExperiment } = await import('../../src/models/QuantResearchExperiment');
  const { QuantStrategyExperiment } = await import('../../src/models/QuantStrategyExperiment');
  const { ResearchIntegrityAudit } = await import('../../src/models/ResearchIntegrityAudit');
  const { BenchmarkAttributionResult } = await import(
    '../../src/models/BenchmarkAttributionResult'
  );
  const { IndustryAttributionResult } = await import('../../src/models/IndustryAttributionResult');
  const { benchmarkIndexService } = await import('../../src/services/BenchmarkIndexService');
  const { quantBacktestService } = await import(
    '../../src/quant/backtest/internal/QuantBacktestService'
  );
  const { quantBacktestQueue } = await import('../../src/jobs/quantBacktestQueue');

  const runId = `trusted_rerun_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const symbol = `sh.609${String(Date.now() % 1000).padStart(3, '0')}`;
  const taskPrefix = `Codex trusted rerun DB smoke ${runId}`;
  const stockName = `Codex可信重跑Smoke${runId.slice(-6)}`;
  const createdTaskIds: number[] = [];
  const createdExperimentIds: number[] = [];
  const queueJobIds: Array<string | number> = [];
  let stockId: number | null = null;
  const originalBenchmarkReturn =
    benchmarkIndexService.getBenchmarkReturnForStock.bind(benchmarkIndexService);
  (benchmarkIndexService as any).getBenchmarkReturnForStock = async () => ({
    benchmark_code: 'sh.000300',
    benchmark_name: '沪深300',
    benchmark_entry_date: '2025-01-02',
    benchmark_exit_date: '2025-04-30',
    benchmark_entry_price: 100,
    benchmark_exit_price: 100,
    benchmark_return_pct: 0,
  });

  async function cleanup() {
    try {
      (benchmarkIndexService as any).getBenchmarkReturnForStock = originalBenchmarkReturn;
      // QuantBacktestService fires benchmark / industry attribution with setImmediate.
      // Give those hooks a short window to finish so this smoke leaves no residue.
      await new Promise(resolve => setTimeout(resolve, 1200));

      for (const jobId of queueJobIds) {
        const job = await quantBacktestQueue.getJob(jobId).catch(() => null);
        if (job) await job.remove().catch(() => undefined);
      }

      const taskIds = [...new Set(createdTaskIds.filter(id => Number(id) > 0))];
      const resultRows = taskIds.length
        ? await QuantBacktestResult.findAll({
            attributes: ['id'],
            where: { task_id: { [Op.in]: taskIds } },
          })
        : [];
      const resultIds = resultRows.map(row => Number(row.id)).filter(Boolean);
      const tasks = createdTaskIds.length
        ? await QuantBacktestTask.findAll({ where: { id: { [Op.in]: taskIds } } })
        : [];
      for (const task of tasks) {
        if (task.experiment_id) createdExperimentIds.push(Number(task.experiment_id));
      }
      const uniqueExperimentIds = [...new Set(createdExperimentIds.filter(Boolean))];

      if (resultIds.length) {
        await BenchmarkAttributionResult.destroy({ where: { run_id: { [Op.in]: resultIds } } });
        await IndustryAttributionResult.destroy({ where: { run_id: { [Op.in]: resultIds } } });
        await ResearchIntegrityAudit.destroy({ where: { backtest_id: { [Op.in]: resultIds } } });
      }
      if (taskIds.length || resultIds.length) {
        const strategyExperimentOr: any[] = [{ symbols: { [Op.contains]: [symbol] } }];
        if (taskIds.length) strategyExperimentOr.push({ task_id: { [Op.in]: taskIds } });
        if (resultIds.length) strategyExperimentOr.push({ result_id: { [Op.in]: resultIds } });
        await QuantStrategyExperiment.destroy({ where: { [Op.or]: strategyExperimentOr } });
      }
      if (taskIds.length) {
        await QuantResearchArtifact.destroy({ where: { task_id: { [Op.in]: taskIds } } });
        await QuantBacktestTrade.destroy({ where: { task_id: { [Op.in]: taskIds } } });
        await QuantBacktestResult.destroy({ where: { task_id: { [Op.in]: taskIds } } });
        await QuantBacktestTask.destroy({ where: { id: { [Op.in]: taskIds } } });
      }
      if (uniqueExperimentIds.length) {
        await QuantResearchArtifact.destroy({
          where: { experiment_id: { [Op.in]: uniqueExperimentIds } },
        });
        await QuantResearchExperiment.destroy({ where: { id: { [Op.in]: uniqueExperimentIds } } });
      }
      if (stockId) {
        await DailyBar.destroy({ where: { stock_id: stockId } });
        await Stock.destroy({ where: { id: stockId, name: stockName } });
      }
    } finally {
      await quantBacktestQueue.close().catch(() => undefined);
      await sequelize.close().catch(() => undefined);
    }
  }

  console.log('\n## Trusted rerun DB smoke');

  try {
    await sequelize.authenticate();
    const [dbRow] = (await sequelize.query(
      'select current_database() as db, current_user as user',
      {
        type: QueryTypes.SELECT,
      }
    )) as Array<{ db: string; user: string }>;
    assert('connected to dev database', dbRow?.db === 'stock_backtest_dev');
    assert('using isolated Redis DB for smoke', String(process.env.REDIS_DB || '') === '9');

    const existing = await Stock.findOne({ where: { symbol } });
    assert('temporary symbol does not collide with existing stock', !existing, symbol);
    if (existing) throw new Error(`temporary symbol collision: ${symbol}`);

    const stock = await Stock.create({
      symbol,
      name: stockName,
      market: 'SH',
      industry: 'Smoke测试',
      listing_date: '2024-01-01',
      is_listed: true,
      type: 'stock',
      data_status: 'complete',
      price: 13.1,
      change_percent: 0.5,
    } as any);
    stockId = stock.id;
    await DailyBar.bulkCreate(buildSmokeBars(stock.id) as any[]);

    const runResult = await quantBacktestService.createBacktestTask(
      {
        task_name: taskPrefix,
        easy_mode: true,
        create_research_experiment: true,
        universe: 'custom',
        symbols: [symbol],
        strategy_keys: ['ma_trend'],
        start_date: '2025-01-02',
        end_date: '2025-04-30',
        initial_capital: 200000,
        position_pct: 20,
        max_positions: 1,
        min_score: 68,
        candidate_limit: 1,
        benchmark_symbol: 'sh.000300',
        params_by_strategy: {
          ma_trend: {
            short_period: 3,
            long_period: 8,
            volume_period: 5,
          },
        },
        execution_timing: 'same_close',
        enable_t_plus_one: false,
        block_limit_up: false,
        block_limit_down: false,
        block_suspended: false,
        data_policy_json: { point_in_time: false },
        constraint_policy_json: {
          enable_t_plus_one: false,
          block_limit_up: false,
          block_limit_down: false,
          block_suspended: false,
        },
      } as any,
      undefined,
      false
    );

    const originalTaskId = Number(runResult?.task?.task?.id || 0);
    createdTaskIds.push(originalTaskId);
    assert('original backtest task completed', runResult?.task?.task?.status === 'COMPLETED');
    assert(
      'original backtest produced a strategy result',
      (runResult?.task?.results || []).length > 0
    );

    const originalTask = await QuantBacktestTask.findByPk(originalTaskId);
    if (originalTask?.experiment_id) createdExperimentIds.push(Number(originalTask.experiment_id));
    assert(
      'backend forced trusted execution timing',
      originalTask?.parameters?.execution_timing === 'next_open'
    );
    assert(
      'backend forced PIT data policy',
      originalTask?.data_policy_json?.point_in_time === true
    );
    assert(
      'backend forced A-share constraints',
      originalTask?.constraint_policy_json?.enable_t_plus_one === true &&
        originalTask?.constraint_policy_json?.block_limit_up === true &&
        originalTask?.constraint_policy_json?.block_limit_down === true
    );

    const queuedArtifact = await QuantResearchArtifact.findOne({
      where: { task_id: originalTaskId, artifact_type: 'audited_return_replay' },
      order: [['created_at', 'DESC']],
    });
    const queuedPayload = queuedArtifact?.payload_json || {};
    const trustedRerunTaskId = Number(queuedPayload.trusted_rerun_task_id || 0);
    if (queuedPayload.trusted_rerun_queue_job_id) {
      queueJobIds.push(queuedPayload.trusted_rerun_queue_job_id);
    }
    createdTaskIds.push(trustedRerunTaskId);
    assert(
      'original artifact records queued trusted rerun',
      queuedPayload.replay_method === 'trusted_backtest_task_queued'
    );
    assert(
      'trusted rerun task id is present',
      trustedRerunTaskId > 0,
      `task=${trustedRerunTaskId}`
    );

    const trustedRerunTask = await QuantBacktestTask.findByPk(trustedRerunTaskId);
    assert('trusted rerun task exists', Boolean(trustedRerunTask));
    assert(
      'trusted rerun task is marked as non-recursive',
      trustedRerunTask?.parameters?.trusted_rerun === true &&
        trustedRerunTask?.parameters?.trusted_rerun_of_task_id === originalTaskId &&
        trustedRerunTask?.parameters?.auto_trusted_rerun === false
    );

    await quantBacktestService.processBacktestTask(
      trustedRerunTaskId,
      trustedRerunTask?.parameters as any,
      {}
    );

    const completedRerunTask = await QuantBacktestTask.findByPk(trustedRerunTaskId);
    assert('trusted rerun task completed', completedRerunTask?.status === 'COMPLETED');

    const actualArtifact = await QuantResearchArtifact.findOne({
      where: { task_id: originalTaskId, artifact_type: 'audited_return_replay' },
      order: [['created_at', 'DESC']],
    });
    const actualPayload = actualArtifact?.payload_json || {};
    assert(
      'original artifact is replaced by actual trusted rerun result',
      actualPayload.replay_method === 'trusted_backtest_task_actual'
    );
    assert(
      'actual artifact points to rerun result',
      Number(actualPayload.trusted_rerun_task_id || 0) === trustedRerunTaskId &&
        Number(actualPayload.trusted_rerun_result_id || 0) > 0
    );
    assert(
      'actual audited return comes from rerun result',
      Number.isFinite(Number(actualPayload.audited_return_pct)) &&
        Number(actualPayload.audited_return_pct) === Number(actualPayload.executable_return_pct)
    );
  } catch (error: any) {
    failed += 1;
    console.error(`  FAIL smoke crashed (${error?.message || error})`);
  } finally {
    await cleanup();
  }
}

main()
  .then(() => {
    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
