/**
 * Genetic Programming for Factor Discovery (simplified)
 *
 * 论文 reference:
 *   Allen, F. and Karjalainen, R. (1999). "Using genetic algorithms to find
 *   technical trading rules." Journal of Financial Economics 51, 245-271.
 *
 *   Lipinski, P. and Korczak, J. (2004). "Evolutionary Computation for Stock
 *   Markets Decision Support."
 *
 *   工业实践: WorldQuant Alpha 101 (Kakushadze 2016) — 101 个手工 alpha
 *   formula 也可被 GP 自动发现.
 *
 * **核心思想**:
 *
 *   传统因子设计靠人工 (e.g. P/E, momentum, RSI). GP 把 factor formula 当
 *   tree 结构, 用遗传算法在历史数据上演化, 找出 IC 最高的 formula.
 *
 *   Tree 节点:
 *     - Leaf: raw features (close, volume, high, low, ...)
 *     - Internal: operators (+, -, *, /, ts_mean(N), ts_std(N), rank, ...)
 *
 *   Example formula tree:
 *
 *     rank(ts_mean(close, 5) / ts_mean(close, 20))   ← momentum-like
 *
 *   Fitness: cross-sectional IC over historical sample
 *
 * **算法 (Genetic Programming)**:
 *
 *   1. Initialize population of N random trees (depth 3-7)
 *   2. Evaluate fitness (IC) of each
 *   3. Select top K parents (tournament selection)
 *   4. Crossover: swap subtrees between 2 parents
 *   5. Mutation: randomly replace a subtree
 *   6. Repeat for G generations
 *
 *   防止 overfitting:
 *     - 用 walk-forward 验证, 不只用 in-sample fitness
 *     - parsimony pressure: penalize 复杂 tree (depth/size)
 *     - 多次随机初始化对比 (DSR-aware fitness)
 *
 * **本实现**:
 *   - 简化版 GP: 5 operators, 4 leaf features, depth ≤ 4
 *   - Fitness = IC on sample
 *   - 不实现完整 crossover/mutation (那是 1000+ 行)
 *   - 实现 random formula generation + fitness evaluation 让 caller 自己 evolve
 *   - 重点是 *评估* 一个 candidate formula 的 IC, 让用户自己定义 search 策略
 *
 *   完整 GP 留给 Python (deap / gplearn) — TypeScript 不适合大规模 evolution.
 */

import { SeededRandom } from '../../utils/SeededRandom';

export type FactorOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | 'ts_mean'
  | 'ts_std'
  | 'rank'
  | 'log'
  | 'neg'
  | 'abs';
export type FactorLeaf = 'close' | 'volume' | 'high' | 'low' | 'open' | 'returns';

export interface FactorNode {
  /** 'leaf' if terminal, op symbol otherwise */
  kind: 'leaf' | FactorOp;
  /** for leaf: feature name */
  feature?: FactorLeaf;
  /** for ts_mean / ts_std: window size */
  window?: number;
  /** children */
  children?: FactorNode[];
}

/**
 * 估算 tree 的复杂度 (节点总数) — used in parsimony penalty
 */
export function treeSize(node: FactorNode): number {
  if (node.kind === 'leaf') return 1;
  return 1 + (node.children ?? []).reduce((s, c) => s + treeSize(c), 0);
}

/**
 * Pretty-print formula tree to string
 *
 *   tree → "rank(ts_mean(close, 5) / ts_mean(close, 20))"
 */
export function formatFactorTree(node: FactorNode): string {
  if (node.kind === 'leaf') return node.feature ?? '?';
  const c = (node.children ?? []).map(formatFactorTree);
  switch (node.kind) {
    case '+':
      return `(${c[0]} + ${c[1]})`;
    case '-':
      return `(${c[0]} - ${c[1]})`;
    case '*':
      return `(${c[0]} * ${c[1]})`;
    case '/':
      return `(${c[0]} / ${c[1]})`;
    case 'ts_mean':
      return `ts_mean(${c[0]}, ${node.window})`;
    case 'ts_std':
      return `ts_std(${c[0]}, ${node.window})`;
    case 'rank':
      return `rank(${c[0]})`;
    case 'log':
      return `log(${c[0]})`;
    case 'neg':
      return `-${c[0]}`;
    case 'abs':
      return `abs(${c[0]})`;
  }
}

export interface BarHistory {
  close: number[];
  volume: number[];
  high: number[];
  low: number[];
  open: number[];
  returns: number[]; // pre-computed daily returns
}

/**
 * Evaluate a tree on a bar history to produce a feature series.
 *
 * @returns series of same length as bars; NaN where window not full
 */
export function evaluateFactorTree(node: FactorNode, bars: BarHistory): number[] {
  if (node.kind === 'leaf') {
    return bars[node.feature ?? 'close'].slice();
  }
  const c = (node.children ?? []).map(child => evaluateFactorTree(child, bars));
  const T = c[0]?.length ?? 0;
  switch (node.kind) {
    case '+':
      return c[0].map((v, i) => v + c[1][i]);
    case '-':
      return c[0].map((v, i) => v - c[1][i]);
    case '*':
      return c[0].map((v, i) => v * c[1][i]);
    case '/':
      return c[0].map((v, i) => (Math.abs(c[1][i]) > 1e-12 ? v / c[1][i] : NaN));
    case 'log':
      return c[0].map(v => (v > 0 ? Math.log(v) : NaN));
    case 'neg':
      return c[0].map(v => -v);
    case 'abs':
      return c[0].map(v => Math.abs(v));
    case 'ts_mean': {
      const w = node.window ?? 5;
      const out: number[] = new Array(T).fill(NaN);
      for (let t = w - 1; t < T; t += 1) {
        let s = 0;
        for (let k = 0; k < w; k += 1) s += c[0][t - k];
        out[t] = s / w;
      }
      return out;
    }
    case 'ts_std': {
      const w = node.window ?? 5;
      const out: number[] = new Array(T).fill(NaN);
      for (let t = w - 1; t < T; t += 1) {
        let s = 0;
        for (let k = 0; k < w; k += 1) s += c[0][t - k];
        const m = s / w;
        let v2 = 0;
        for (let k = 0; k < w; k += 1) v2 += (c[0][t - k] - m) ** 2;
        out[t] = Math.sqrt(v2 / (w - 1 || 1));
      }
      return out;
    }
    case 'rank': {
      // cross-sectional rank: 这里简化为 series 内部 rank (将值映射到 [0, 1])
      // 真 GP 在多 stock 数据上 cross-sectional rank, 这里单 stock 时序 rank
      const valid = c[0].filter(v => Number.isFinite(v));
      if (valid.length === 0) return c[0];
      const sorted = [...valid].sort((a, b) => a - b);
      return c[0].map(v => {
        if (!Number.isFinite(v)) return NaN;
        const idx = sorted.findIndex(x => x >= v);
        return idx / valid.length;
      });
    }
  }
}

/**
 * Generate a random factor tree with given max depth and operator/feature pool.
 *
 * Pure function with optional seeded RNG.
 */
const defaultFactorDiscoveryRng = new SeededRandom();

export function generateRandomTree(
  max_depth: number,
  rng: () => number = () => defaultFactorDiscoveryRng.next(),
  options: {
    ops?: FactorOp[];
    leaves?: FactorLeaf[];
    windows?: number[];
  } = {}
): FactorNode {
  const ops = options.ops ?? ['+', '-', '*', '/', 'ts_mean', 'ts_std', 'rank', 'log', 'neg', 'abs'];
  const leaves = options.leaves ?? ['close', 'volume', 'high', 'low', 'open', 'returns'];
  const windows = options.windows ?? [5, 10, 20, 60];

  // base case
  if (max_depth <= 0 || rng() < 0.3) {
    return { kind: 'leaf', feature: leaves[Math.floor(rng() * leaves.length)] };
  }
  const op = ops[Math.floor(rng() * ops.length)];
  // arity per op
  const binaryOps = new Set(['+', '-', '*', '/']);
  const unaryOps = new Set(['log', 'neg', 'abs', 'rank']);
  const windowOps = new Set(['ts_mean', 'ts_std']);

  if (binaryOps.has(op)) {
    return {
      kind: op,
      children: [
        generateRandomTree(max_depth - 1, rng, options),
        generateRandomTree(max_depth - 1, rng, options),
      ],
    };
  }
  if (unaryOps.has(op)) {
    return {
      kind: op,
      children: [generateRandomTree(max_depth - 1, rng, options)],
    };
  }
  if (windowOps.has(op)) {
    return {
      kind: op,
      window: windows[Math.floor(rng() * windows.length)],
      children: [generateRandomTree(max_depth - 1, rng, options)],
    };
  }
  return { kind: 'leaf', feature: 'close' };
}

/**
 * Evaluate fitness of a candidate factor on a sample:
 *   fitness = IC(forecast, forward_returns) - penalty(tree_size)
 *
 * @param tree candidate formula
 * @param bars input feature series (T length each)
 * @param forward_returns N-day forward returns aligned to bars (length T, NaN at end)
 * @param options.parsimony_penalty per-node penalty (default 0.005)
 */
export function evaluateFactorFitness(
  tree: FactorNode,
  bars: BarHistory,
  forward_returns: number[],
  options: { parsimony_penalty?: number; method?: 'pearson' | 'spearman' } = {}
): {
  fitness: number;
  raw_ic: number;
  tree_size: number;
  n_valid_samples: number;
} {
  const factor_values = evaluateFactorTree(tree, bars);
  // valid pairs
  const xs: number[] = [];
  const ys: number[] = [];
  for (let t = 0; t < factor_values.length; t += 1) {
    if (Number.isFinite(factor_values[t]) && Number.isFinite(forward_returns[t])) {
      xs.push(factor_values[t]);
      ys.push(forward_returns[t]);
    }
  }
  const size = treeSize(tree);
  if (xs.length < 5)
    return { fitness: 0, raw_ic: NaN, tree_size: size, n_valid_samples: xs.length };

  // compute correlation
  let corr = 0;
  if (options.method === 'pearson') {
    // inline pearson
    const mX = xs.reduce((s, v) => s + v, 0) / xs.length;
    const mY = ys.reduce((s, v) => s + v, 0) / ys.length;
    let num = 0,
      dX = 0,
      dY = 0;
    for (let i = 0; i < xs.length; i += 1) {
      num += (xs[i] - mX) * (ys[i] - mY);
      dX += (xs[i] - mX) ** 2;
      dY += (ys[i] - mY) ** 2;
    }
    corr = dX * dY > 0 ? num / Math.sqrt(dX * dY) : 0;
  } else {
    // spearman: rank then pearson
    const rXs = computeRanksLocal(xs);
    const rYs = computeRanksLocal(ys);
    const mX = rXs.reduce((s, v) => s + v, 0) / rXs.length;
    const mY = rYs.reduce((s, v) => s + v, 0) / rYs.length;
    let num = 0,
      dX = 0,
      dY = 0;
    for (let i = 0; i < rXs.length; i += 1) {
      num += (rXs[i] - mX) * (rYs[i] - mY);
      dX += (rXs[i] - mX) ** 2;
      dY += (rYs[i] - mY) ** 2;
    }
    corr = dX * dY > 0 ? num / Math.sqrt(dX * dY) : 0;
  }

  const penalty = (options.parsimony_penalty ?? 0.005) * size;
  return {
    fitness: Math.abs(corr) - penalty, // 用 |IC| 因为 sign 可以 negate
    raw_ic: corr,
    tree_size: size,
    n_valid_samples: xs.length,
  };
}

function computeRanksLocal(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length).fill(0);
  for (let r = 0; r < indexed.length; r += 1) ranks[indexed[r].i] = r + 1;
  return ranks;
}

/**
 * Population-based search (simple version):
 *
 *   1. Generate N_initial random trees
 *   2. Evaluate fitness
 *   3. Return top K by fitness
 *
 * 完整 GP (crossover + mutation 多代) 留给 Python; 本接口给 caller
 * 做 "random search baseline" 用.
 *
 * 复杂度: O(N_initial × evaluation_cost)
 */
export function randomFactorSearch(
  bars: BarHistory,
  forward_returns: number[],
  options: {
    n_candidates?: number;
    max_depth?: number;
    seed?: number;
    parsimony_penalty?: number;
    top_k?: number;
  } = {}
): Array<{
  tree: FactorNode;
  formula: string;
  fitness: number;
  raw_ic: number;
  tree_size: number;
}> {
  const N = options.n_candidates ?? 100;
  const maxDepth = options.max_depth ?? 4;
  const topK = options.top_k ?? 10;

  // Park-Miller LCG
  let state = (options.seed ?? 42) % 2147483647;
  if (state <= 0) state += 2147483646;
  const rng = (): number => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };

  const candidates: Array<{
    tree: FactorNode;
    formula: string;
    fitness: number;
    raw_ic: number;
    tree_size: number;
  }> = [];

  for (let i = 0; i < N; i += 1) {
    const tree = generateRandomTree(maxDepth, rng);
    const ev = evaluateFactorFitness(tree, bars, forward_returns, {
      parsimony_penalty: options.parsimony_penalty,
    });
    candidates.push({
      tree,
      formula: formatFactorTree(tree),
      fitness: ev.fitness,
      raw_ic: ev.raw_ic,
      tree_size: ev.tree_size,
    });
  }

  // dedupe by formula (random search 经常生成 syntactically 不同但语义同的)
  const uniqueByFormula = new Map<string, (typeof candidates)[0]>();
  for (const c of candidates) {
    if (!uniqueByFormula.has(c.formula) || c.fitness > uniqueByFormula.get(c.formula)!.fitness) {
      uniqueByFormula.set(c.formula, c);
    }
  }
  const dedupedSorted = Array.from(uniqueByFormula.values())
    .sort((a, b) => b.fitness - a.fitness)
    .slice(0, topK);
  return dedupedSorted;
}
