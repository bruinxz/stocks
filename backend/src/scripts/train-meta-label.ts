#!/usr/bin/env node
/**
 * MetaLabel 训练 CLI — Sprint 2A
 *
 * 从 RecommendationTradeOutcome (closed) 加载历史样本，提取特征 + label，
 * 训练 logistic regression 模型，把权重持久化到 disk JSON 让 backend 启动时 load。
 *
 * Usage:
 *   # 用近 180 天 closed outcomes 训练
 *   npm run train:meta-label -- --since-days=180
 *
 *   # 自定义训练参数
 *   npm run train:meta-label -- --since-days=365 --max-iter=500 --learning-rate=0.05
 *
 *   # dry-run 不持久化（只看 in-sample accuracy）
 *   npm run train:meta-label -- --since-days=180 --no-persist
 *
 *   # 查看当前模型
 *   npm run train:meta-label -- --show
 *
 * 选项：
 *   --since-days=<n>       回看天数 (默认 180)
 *   --max-iter=<n>         梯度下降最大迭代次数 (默认 200)
 *   --learning-rate=<n>    学习率 (默认 0.1)
 *   --l2=<n>               L2 正则化强度 (默认 0.01)
 *   --no-persist           不写模型 JSON 到 disk
 *   --show                 显示当前 disk 上的模型 + in-process model
 *
 * 持久化路径：data/meta-label-model.json (默认；可通过 --output= 覆盖)
 * Backend 启动时自动从此路径 load 模型；不存在则走 fallback rule。
 */
import * as fs from 'fs';
import * as path from 'path';
import { Op } from 'sequelize';
import { RecommendationTradeOutcome } from '../models/RecommendationTradeOutcome';
import { AIInvestmentSignal } from '../models/AIInvestmentSignal';
import {
  metaLabelService,
  trainLogisticRegression,
  TrainingRow,
  RawSignalFeatures,
} from '../services/meta/MetaLabelService';
import { logger } from '../utils/logger';

interface CliArgs {
  sinceDays: number;
  maxIter: number;
  learningRate: number;
  l2: number;
  persist: boolean;
  show: boolean;
  outputPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const opts: CliArgs = {
    sinceDays: 180,
    maxIter: 200,
    learningRate: 0.1,
    l2: 0.01,
    persist: true,
    show: false,
    outputPath: path.resolve(__dirname, '../../data/meta-label-model.json'),
  };
  for (const arg of argv) {
    if (arg === '--no-persist') opts.persist = false;
    else if (arg === '--show') opts.show = true;
    else if (arg.startsWith('--since-days=')) opts.sinceDays = parseInt(arg.slice('--since-days='.length), 10);
    else if (arg.startsWith('--max-iter=')) opts.maxIter = parseInt(arg.slice('--max-iter='.length), 10);
    else if (arg.startsWith('--learning-rate=')) opts.learningRate = parseFloat(arg.slice('--learning-rate='.length));
    else if (arg.startsWith('--l2=')) opts.l2 = parseFloat(arg.slice('--l2='.length));
    else if (arg.startsWith('--output=')) opts.outputPath = path.resolve(arg.slice('--output='.length));
  }
  return opts;
}

async function loadTrainingRows(sinceDays: number): Promise<TrainingRow[]> {
  const cutoff = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);
  logger.info(`[train-meta-label] loading closed outcomes since ${cutoff.toISOString().slice(0, 10)}`);

  const outcomes: any[] = await RecommendationTradeOutcome.findAll({
    where: {
      trade_status: 'closed',
      exit_date: { [Op.gte]: cutoff },
    },
    order: [['exit_date', 'ASC']],
    limit: 5000,
  });

  logger.info(`[train-meta-label] found ${outcomes.length} closed outcomes`);

  // 拉 signal 详情补 features
  const signalIds = outcomes.map((o: any) => o.signal_id).filter((id: any) => Number.isFinite(Number(id)));
  const signalsMap = new Map<number, any>();
  if (signalIds.length > 0) {
    const signals = await AIInvestmentSignal.findAll({
      where: { id: { [Op.in]: signalIds } },
    });
    for (const s of signals) {
      signalsMap.set(s.id, s);
    }
  }

  const rows: TrainingRow[] = [];
  for (const o of outcomes) {
    const sig = signalsMap.get(o.signal_id);
    const pnl = Number(o.total_pnl_pct ?? o.realized_pnl_pct ?? NaN);
    if (!Number.isFinite(pnl)) continue;
    const label: 0 | 1 = pnl > 0 ? 1 : 0;
    const meta = sig?.metadata || o.metadata || {};
    const signalScore = Number(sig?.confidence_score ?? meta?.final_score ?? meta?.signal_score ?? 75);
    const features: RawSignalFeatures = {
      signal_score: Number.isFinite(signalScore) ? signalScore : 75,
      signal_source: String(sig?.source_type || meta?.signal_source || 'unknown'),
      regime: String(meta?.market_regime || meta?.regime || 'range'),
      market_breadth_score: Number(meta?.market_breadth_score ?? 0),
      strategy_recent_winrate_30d: Number(meta?.strategy_recent_winrate ?? 0.5),
      strategy_recent_payoff_30d: Number(meta?.strategy_recent_payoff ?? 1.0),
      market_vol_atr: Number(meta?.market_vol_atr ?? 4),
    };
    rows.push({ features, label });
  }
  logger.info(
    `[train-meta-label] built ${rows.length} training rows (positive=${rows.filter(r => r.label === 1).length}, negative=${rows.filter(r => r.label === 0).length})`
  );
  return rows;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.show) {
    if (fs.existsSync(opts.outputPath)) {
      const onDisk = JSON.parse(fs.readFileSync(opts.outputPath, 'utf8'));
      console.log('=== Disk model ===');
      console.log(`version: ${onDisk.version}`);
      console.log(`trained_at: ${onDisk.trained_at}`);
      console.log(`trained_samples: ${onDisk.trained_samples}`);
      console.log(`insample_accuracy: ${onDisk.insample_accuracy}`);
      console.log(`baseline_accuracy: ${onDisk.baseline_accuracy}`);
      console.log(`bias: ${onDisk.bias}`);
      console.log('weights:');
      for (const [k, v] of Object.entries(onDisk.weights || {})) {
        console.log(`  ${k}: ${(v as number).toFixed(4)}`);
      }
    } else {
      console.log(`No disk model at ${opts.outputPath}`);
    }
    const inMem = metaLabelService.getModel();
    console.log('\n=== In-process model ===');
    console.log(inMem ? `${inMem.version} (acc=${inMem.insample_accuracy})` : '(none, will use fallback rule)');
    process.exit(0);
  }

  console.log('=== MetaLabel Training ===');
  console.log(`since_days: ${opts.sinceDays}`);
  console.log(`max_iter: ${opts.maxIter}`);
  console.log(`learning_rate: ${opts.learningRate}`);
  console.log(`l2: ${opts.l2}`);
  console.log(`persist: ${opts.persist}`);
  console.log(`output: ${opts.outputPath}`);
  console.log();

  const rows = await loadTrainingRows(opts.sinceDays);
  if (rows.length < 30) {
    console.error(`❌ 训练样本不足 (${rows.length} < 30)，至少需要 30 行才能训练。`);
    process.exit(2);
  }

  const model = trainLogisticRegression(rows, {
    max_iter: opts.maxIter,
    learning_rate: opts.learningRate,
    l2: opts.l2,
  });

  console.log('=== Trained Model ===');
  console.log(`version: ${model.version}`);
  console.log(`trained_at: ${model.trained_at}`);
  console.log(`trained_samples: ${model.trained_samples}`);
  console.log(`insample_accuracy: ${model.insample_accuracy.toFixed(4)}`);
  console.log(`baseline_accuracy: ${model.baseline_accuracy.toFixed(4)}`);
  console.log(`improvement: ${((model.insample_accuracy - model.baseline_accuracy) * 100).toFixed(2)}%`);
  console.log(`bias: ${model.bias.toFixed(4)}`);
  console.log('Top features by |weight|:');
  const sortedWeights = Object.entries(model.weights)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 8);
  for (const [k, v] of sortedWeights) {
    console.log(`  ${k}: ${v.toFixed(4)}`);
  }

  if (opts.persist) {
    const dir = path.dirname(opts.outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(opts.outputPath, JSON.stringify(model, null, 2));
    console.log(`\n✅ 模型已保存到 ${opts.outputPath}`);
    metaLabelService.setModel(model);
    console.log(`✅ 当前进程内 metaLabelService 已激活新模型`);
  } else {
    console.log('\n[dry-run] 未持久化模型');
  }

  process.exit(0);
}

main().catch(err => {
  logger.error('[train-meta-label] failed:', err);
  process.exit(1);
});
