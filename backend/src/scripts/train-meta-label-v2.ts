#!/usr/bin/env node
/**
 * MetaLabel V2 训练 CLI — Sprint 43-F
 *
 * 升级 V1 (train-meta-label.ts) 用 Sprint 41-B 三个新 service:
 *   1. TripleBarrierLabeler — 替代二元 label (pnl>0?1:0), 用 triple-barrier 三态
 *   2. IsotonicCalibrator — 训练校准模型 (raw_confidence → true_win_prob)
 *   3. PlaybookGenerator — 抽 playbook feature (trade_type/style/crowded/...)
 *      作为 V2 训练样本的附加特征
 *
 * 模型 schema 与 V1 不同, 写到独立 disk path data/meta-label-v2-model.json,
 * 不动 V1 模型. 生产端可选择性切换 (config flag).
 *
 * Usage:
 *   # 用 V1 模型作 base, 跑 isotonic calibration + EV 统计
 *   npm run train:meta-label-v2 -- --since-days=180
 *
 *   # 自定义
 *   npm run train:meta-label-v2 -- --since-days=365 --upper=0.05 --lower=0.03 --hold=15
 *
 *   # dry-run 只看 calibration quality 不持久化
 *   npm run train:meta-label-v2 -- --since-days=180 --no-persist
 *
 *   # 查看当前 V2 模型
 *   npm run train:meta-label-v2 -- --show
 *
 * 选项:
 *   --since-days=<n>     回看天数 (默认 180)
 *   --upper=<f>          triple-barrier 上轨 (默认 0.05 = +5%)
 *   --lower=<f>          triple-barrier 下轨 (默认 0.03 = -3%)
 *   --hold=<n>           triple-barrier 时间轨自然日 (默认 15)
 *   --no-persist         不持久化
 *   --show               显示 disk 上当前 V2 模型
 *
 * 输出: data/meta-label-v2-model.json
 *   {
 *     version: 'v2-{timestamp}',
 *     base_model_version: 'v1 model version',
 *     calibration: IsotonicCalibrationModel,
 *     barrier_options: TripleBarrierOptions,
 *     label_distribution: {upper, lower, time, no_data},
 *     ev_stats_by_regime: Map<regime, {avg_win, avg_loss, n_samples}>,
 *     trained_samples: number,
 *     trained_at: ISO string,
 *   }
 */
import * as fs from 'fs';
import * as path from 'path';
import { Op } from 'sequelize';
import '../config/database';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { logger } from '../utils/logger';
import {
  tripleBarrierLabeler,
  TRIPLE_BARRIER_LABELS,
  normalizeBarrierOptions,
  TripleBarrierOptions,
} from '../services/meta-v2/TripleBarrierLabeler';
import {
  isotonicCalibrator,
  trainIsotonicCalibration,
  brierScore,
  IsotonicCalibrationModel,
  CalibrationSample,
  V2ModelOnDisk,
} from '../services/meta-v2/IsotonicCalibrator';
import { generatePlaybook } from '../services/playbook/PlaybookGenerator';

interface Opts {
  sinceDays: number;
  upper: number;
  lower: number;
  hold: number;
  persist: boolean;
  show: boolean;
  outputPath: string;
}

function parseArgs(args: string[]): Opts {
  const opts: Opts = {
    sinceDays: 180,
    upper: 0.05,
    lower: 0.03,
    hold: 15,
    persist: true,
    show: false,
    outputPath: path.resolve(__dirname, '../../data/meta-label-v2-model.json'),
  };
  for (const arg of args) {
    if (arg.startsWith('--since-days=')) opts.sinceDays = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--upper=')) opts.upper = parseFloat(arg.split('=')[1]);
    else if (arg.startsWith('--lower=')) opts.lower = parseFloat(arg.split('=')[1]);
    else if (arg.startsWith('--hold=')) opts.hold = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--output=')) opts.outputPath = arg.split('=')[1];
    else if (arg === '--no-persist') opts.persist = false;
    else if (arg === '--show') opts.show = true;
  }
  return opts;
}

// Sprint 44-A: V2ModelOnDisk type 移到 IsotonicCalibrator.ts 共享

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.show) {
    if (fs.existsSync(opts.outputPath)) {
      const onDisk: V2ModelOnDisk = JSON.parse(fs.readFileSync(opts.outputPath, 'utf8'));
      console.log('--- V2 model on disk ---');
      console.log(`version: ${onDisk.version}`);
      console.log(`base_model_version: ${onDisk.base_model_version}`);
      console.log(`trained_samples: ${onDisk.trained_samples}`);
      console.log(`in_sample_brier: ${onDisk.in_sample_brier?.toFixed(4)}`);
      console.log(`barrier_options:`, onDisk.barrier_options);
      console.log(`label_distribution:`, onDisk.label_distribution);
      console.log(`ev_stats_by_regime:`, onDisk.ev_stats_by_regime);
      console.log(`calibration anchors: ${onDisk.calibration.points.length}`);
    } else {
      console.log(`no V2 model on disk at ${opts.outputPath}`);
    }
    process.exit(0);
  }

  // 批5: 旧 V1 logistic MetaLabel 已退役 (运行期 confidence 改用 Wilson 下界,
  //   见 ConfidenceCalibrationService §5.1). 本 V2 训练只保留两件运行期仍需的产物:
  //   (1) isotonic 校准曲线 — 现以"信号存量分"为 raw 输入 (更诚实, 无需 v1 模型);
  //   (2) ev_stats_by_regime — EVDecisionService 的 avg_win/avg_loss 主源。

  // 1. 加载 closed outcomes
  const cutoff = new Date(Date.now() - opts.sinceDays * 24 * 3600 * 1000);
  console.log(`[v2-train] loading closed outcomes since ${cutoff.toISOString().slice(0, 10)}`);
  const outcomes = (await RecommendationTradeOutcome.findAll({
    where: {
      trade_status: 'closed',
      exit_date: { [Op.gte]: cutoff },
    },
    order: [['exit_date', 'ASC']],
    limit: 5000,
    raw: true,
  })) as any[];
  console.log(`[v2-train] loaded ${outcomes.length} closed outcomes`);
  if (outcomes.length === 0) {
    console.error('❌ 无 closed outcomes 可训练');
    process.exit(1);
  }

  // 2. 对每条 outcome 跑 TripleBarrierLabeler + 预测原 confidence
  const barrierOpts = normalizeBarrierOptions({
    profit_take_pct: opts.upper,
    stop_loss_pct: opts.lower,
    max_holding_days: opts.hold,
  });
  console.log(`[v2-train] barrier_options:`, barrierOpts);

  const calibrationSamples: CalibrationSample[] = [];
  const labelDist = { upper: 0, lower: 0, time: 0, no_data: 0 };
  const regimeStats: Map<string, { wins: number[]; losses: number[]; total: number }> = new Map();

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (!o.symbol || !o.entry_date || !o.entry_price || o.entry_price <= 0) continue;

    // a. triple-barrier label
    const tb = await tripleBarrierLabeler.label({
      symbol: o.symbol,
      entry_price: Number(o.entry_price),
      entry_date: String(o.entry_date).slice(0, 10),
      options: barrierOpts,
    });
    if (tb.label === null) {
      labelDist.no_data++;
      continue;
    }
    if (tb.label === TRIPLE_BARRIER_LABELS.UPPER_HIT) labelDist.upper++;
    else if (tb.label === TRIPLE_BARRIER_LABELS.LOWER_HIT) labelDist.lower++;
    else labelDist.time++;

    // b. raw confidence = 信号存量分归一化到 [0,1] (退役 v1 logistic 后的诚实口径)
    const meta = o.metadata || {};
    const rawScore = Number(meta?.signal_score ?? meta?.final_score ?? 75);
    const rawConfidence = Math.max(0, Math.min(1, rawScore / 100));

    // c. 收集 calibration sample (binary outcome: UPPER=1, others=0)
    const binaryOutcome: 0 | 1 = tb.label === TRIPLE_BARRIER_LABELS.UPPER_HIT ? 1 : 0;
    calibrationSamples.push({
      raw_confidence: rawConfidence,
      outcome: binaryOutcome,
    });

    // d. 累积 per-regime EV stats
    const regime = String(meta?.market_regime || meta?.regime || 'range');
    const stats = regimeStats.get(regime) || { wins: [], losses: [], total: 0 };
    stats.total++;
    const pnlPct = Number(tb.pnl_pct);
    if (Number.isFinite(pnlPct)) {
      if (pnlPct > 0) stats.wins.push(pnlPct);
      else stats.losses.push(Math.abs(pnlPct));
    }
    regimeStats.set(regime, stats);

    if (i % 200 === 0 && i > 0) {
      console.log(`  ... processed ${i}/${outcomes.length}`);
    }
  }

  console.log(`[v2-train] label_distribution:`, labelDist);
  console.log(`[v2-train] usable calibration samples: ${calibrationSamples.length}`);

  if (calibrationSamples.length < 20) {
    console.error(
      `❌ usable samples 太少 (${calibrationSamples.length}), 至少需要 20 才能训练 isotonic`
    );
    process.exit(1);
  }

  // 3. 训练 isotonic calibration
  const calibration = trainIsotonicCalibration(calibrationSamples);
  const inSampleBrier = brierScore(calibration, calibrationSamples);
  console.log(
    `[v2-train] isotonic 训练完成: ${
      calibration.points.length
    } anchors, base_win_rate=${calibration.base_win_rate.toFixed(
      3
    )}, in_sample_brier=${inSampleBrier.toFixed(4)}`
  );

  // 4. per-regime EV stats
  const evStatsByRegime: Record<
    string,
    { avg_win_pct: number; avg_loss_pct: number; n_samples: number; win_rate: number }
  > = {};
  for (const [regime, stats] of regimeStats) {
    const avgWin =
      stats.wins.length > 0 ? stats.wins.reduce((a, b) => a + b, 0) / stats.wins.length : 0.05;
    const avgLoss =
      stats.losses.length > 0
        ? stats.losses.reduce((a, b) => a + b, 0) / stats.losses.length
        : 0.03;
    evStatsByRegime[regime] = {
      avg_win_pct: avgWin,
      avg_loss_pct: avgLoss,
      n_samples: stats.total,
      win_rate: stats.total > 0 ? stats.wins.length / stats.total : 0,
    };
  }
  console.log('[v2-train] ev_stats_by_regime:', evStatsByRegime);

  // 5. 持久化
  const v2Model: V2ModelOnDisk = {
    version: `v2-${Date.now()}`,
    base_model_version: 'v1-retired-batch5',
    calibration,
    barrier_options: barrierOpts,
    label_distribution: labelDist,
    ev_stats_by_regime: evStatsByRegime,
    trained_samples: calibrationSamples.length,
    in_sample_brier: inSampleBrier,
    trained_at: new Date().toISOString(),
  };

  if (opts.persist) {
    const outputDir = path.dirname(opts.outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(opts.outputPath, JSON.stringify(v2Model, null, 2));
    console.log(`✅ V2 model 持久化到 ${opts.outputPath}`);
    // Sprint 44-A: 用 reloadFromDisk 一次性把 V2 model (含 ev_stats_by_regime) 灌进 in-process
    // singleton, 让 EVDecisionService 立即能拿到 V2 stats. setModel(calibration) 只更新
    // calibration 部分, V2 模型完整字段拿不到, 所以走 reloadFromDisk.
    const reloaded = isotonicCalibrator.reloadFromDisk(opts.outputPath);
    if (reloaded) {
      console.log(`✅ in-process isotonicCalibrator 已加载新校准模型 (含 ev_stats_by_regime)`);
    } else {
      // 兜底: 至少把 calibration 部分塞进去
      isotonicCalibrator.setModel(calibration);
      console.log(`✅ in-process isotonicCalibrator 已加载新校准模型 (calibration only)`);
    }
  } else {
    console.log(`(--no-persist mode) V2 model 未写盘, in_sample_brier=${inSampleBrier.toFixed(4)}`);
  }

  // 6. Sanity: 跑一个 demo playbook 看 mapping 是否对齐
  const demoPlaybook = generatePlaybook({
    strategy_key: 'multi_factor_alpha',
    symbol: '600519',
    signal_score: 80,
    market_regime: 'bull',
  });
  console.log('[v2-train] demo playbook for multi_factor_alpha:', demoPlaybook);

  process.exit(0);
}

main().catch(err => {
  console.error('❌ train-meta-label-v2 failed:', err);
  process.exit(1);
});
