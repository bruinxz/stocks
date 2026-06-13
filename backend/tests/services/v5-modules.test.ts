/**
 * v5 联合测试: HMM + QP + Causal + RL + Thompson Sampling
 */
import {
  logGaussianPdf,
  logSumExp,
  hmmForward,
  hmmBackward,
  hmmPosteriorStates,
  hmmViterbi,
  hmmBaumWelch,
  initializeHMMParams,
  decodeRegimeLabels,
} from '../../src/services/research/hmm-regime';
import {
  solveQP,
  solveBoxQP,
  solveBoxSimplexQP,
} from '../../src/services/portfolio/qp-solver';
import {
  quantileBin,
  backdoorAdjustedCorrelation,
  multiConfounderBackdoor,
  grangerCausalityTest,
} from '../../src/services/research/causal-inference';
import {
  stateKey,
  newQTable,
  getQValues,
  epsilonGreedyAction,
  qLearningUpdate,
  executionReward,
  runEpisode,
  bestAction,
  trainQLearning,
  STANDARD_PARTICIPATION_RATES,
  ExecutionState,
  Action,
} from '../../src/services/execution/rl-execution';
import {
  TSRng,
  createPrior,
  updatePosterior,
  samplePosteriorMu,
  softmaxAllocation,
  thompsonSamplingAllocation,
  sampleBeta,
  updateBetaBernoulli,
  betaBernoulliThompsonAllocation,
} from '../../src/services/portfolio/thompson-sampling';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`); }
}
function expectClose(name: string, actual: number, expected: number, eps = 1e-3) {
  assert(name, Number.isFinite(actual) && Math.abs(actual - expected) < eps, `expected≈${expected}, got=${actual}`);
}

function testLogGaussianPdf() {
  console.log('\n## logGaussianPdf');
  expectClose('logN(0|0,1) ≈ -0.9189', logGaussianPdf(0, 0, 1), -0.9189385332046727);
  expectClose('logN(5|5,2)', logGaussianPdf(5, 5, 2), -0.5 * Math.log(2 * Math.PI) - Math.log(2));
  assert('σ=0 → -Inf', logGaussianPdf(0, 0, 0) === -Infinity);
}

function testLogSumExp() {
  console.log('\n## logSumExp');
  expectClose('log(e + e) = 1 + log(2)', logSumExp([1, 1]), 1 + Math.log(2));
  expectClose('log(1 + 0) = 0', logSumExp([0, -Infinity]), 0);
}

function testHmmForwardBackward() {
  console.log('\n## hmmForward + hmmBackward');
  const params = {
    K: 2, pi: [0.5, 0.5], A: [[0.7, 0.3], [0.4, 0.6]], mu: [0, 1], sigma: [0.5, 0.5],
  };
  const obs = [0.1, 0.9, 0.2];
  const fwd = hmmForward(params, obs);
  assert('log_alpha 3 行', fwd.log_alpha.length === 3);
  assert('log_likelihood 有限', Number.isFinite(fwd.log_likelihood));

  const bwd = hmmBackward(params, obs);
  expectClose('log_beta[T-1][0] = 0', bwd[2][0], 0);

  const gamma = hmmPosteriorStates(fwd.log_alpha, bwd);
  for (let t = 0; t < gamma.length; t += 1) {
    expectClose(`γ[${t}] sum = 1`, gamma[t].reduce((s, v) => s + v, 0), 1, 1e-6);
  }
}

function testHmmViterbi() {
  console.log('\n## hmmViterbi');
  const params = {
    K: 2, pi: [0.5, 0.5], A: [[0.9, 0.1], [0.1, 0.9]], mu: [-1, 1], sigma: [0.3, 0.3],
  };
  const obs = [-1, -1, -1, 1, 1, 1];
  const vit = hmmViterbi(params, obs);
  assert('Viterbi 长度 = 6', vit.states.length === 6);
  assert('states[0] = 0', vit.states[0] === 0);
  assert('states[5] = 1', vit.states[5] === 1);
}

function testInitializeHMMParams() {
  console.log('\n## initializeHMMParams');
  const obs = [0.01, -0.02, 0.005, 0.015, -0.005, 0.02, 0.001, -0.01];
  const params = initializeHMMParams(obs, 3);
  assert('K = 3', params.K === 3);
  expectClose('pi sum = 1', params.pi.reduce((s, v) => s + v, 0), 1, 1e-6);
  for (let i = 0; i < 3; i += 1) {
    expectClose(`A[${i}] sum = 1`, params.A[i].reduce((s, v) => s + v, 0), 1, 1e-6);
  }
  assert('μ[0] ≤ μ[1] ≤ μ[2]', params.mu[0] <= params.mu[1] && params.mu[1] <= params.mu[2]);
}

function testHmmBaumWelch() {
  console.log('\n## hmmBaumWelch');
  const obs: number[] = [];
  let s = 42;
  const rng = (): number => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = 0; i < 50; i += 1) obs.push(-0.01 + 0.02 * (rng() - 0.5));
  for (let i = 0; i < 50; i += 1) obs.push(0.01 + 0.02 * (rng() - 0.5));

  const initial = initializeHMMParams(obs, 2);
  const result = hmmBaumWelch(obs, initial, { max_iter: 30, tolerance: 1e-4 });

  assert('iterations > 0', result.iterations > 0);
  const muSorted = [...result.params.mu].sort((a, b) => a - b);
  assert('learned μ[0] ≈ -0.01', Math.abs(muSorted[0] - (-0.01)) < 0.01, `μ[0]=${muSorted[0]}`);
  assert('learned μ[1] ≈ +0.01', Math.abs(muSorted[1] - 0.01) < 0.01, `μ[1]=${muSorted[1]}`);
}

function testDecodeRegimeLabels() {
  console.log('\n## decodeRegimeLabels');
  const params = {
    K: 4, pi: [0.25, 0.25, 0.25, 0.25],
    A: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    mu: [0.02, -0.01, 0.001, -0.02], sigma: [0.01, 0.04, 0.005, 0.02],
  };
  const labels = decodeRegimeLabels(params);
  assert('4 labels', labels.length === 4);
  assert('contains bull', labels.includes('bull'));
  assert('contains bear', labels.includes('bear'));
  assert('contains range', labels.includes('range'));
  assert('contains volatile', labels.includes('volatile'));
}

function testSolveBoxQP() {
  console.log('\n## solveBoxQP');
  const sol = solveBoxQP([[1, 0], [0, 1]], [-1, -1], [0, 0], [1, 1], { max_iter: 500 });
  expectClose('x = 1', sol.x[0], 1, 0.05);
  expectClose('y = 1', sol.x[1], 1, 0.05);
}

function testSolveBoxSimplexQP() {
  console.log('\n## solveBoxSimplexQP');
  const cov = [[1, 0, 0], [0, 4, 0], [0, 0, 9]];
  const sol = solveBoxSimplexQP(cov, [0, 0, 0], [0, 0, 0], [1, 1, 1], 1, { max_iter: 500 });
  expectClose('sum = 1', sol.x.reduce((s, v) => s + v, 0), 1, 0.05);
  assert('w[0] > w[1] > w[2]', sol.x[0] > sol.x[1] && sol.x[1] > sol.x[2], `w=[${sol.x.map(v => v.toFixed(3))}]`);
}

function testSolveQPGeneral() {
  console.log('\n## solveQP general');
  const sol = solveQP({
    P: [[2, 0], [0, 2]],
    q: [0, 0],
    A: [[1, 1]],
    l: [1],
    u: [Number.MAX_VALUE / 1e10],
  }, { max_iter: 500, rho: 1.0 });
  expectClose('x = 0.5', sol.x[0], 0.5, 0.1);
  expectClose('y = 0.5', sol.x[1], 0.5, 0.1);
}

function testQuantileBin() {
  console.log('\n## quantileBin');
  const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const bins = quantileBin(vals, 5);
  assert('5 bins assigned', new Set(bins).size === 5);
  assert('bin 0 for vals[0]', bins[0] === 0);
  assert('bin 4 for vals[9]', bins[9] === 4);
}

function testBackdoorAdjusted() {
  console.log('\n## backdoorAdjustedCorrelation');
  const Z: number[] = [];
  const X: number[] = [];
  const Y: number[] = [];
  let s = 7;
  for (let i = 0; i < 200; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    const z = (s / 233280 - 0.5) * 2;
    s = (s * 9301 + 49297) % 233280;
    const noiseX = (s / 233280 - 0.5) * 0.5;
    s = (s * 9301 + 49297) % 233280;
    const noiseY = (s / 233280 - 0.5) * 0.5;
    Z.push(z); X.push(z + noiseX); Y.push(z + noiseY);
  }
  const r = backdoorAdjustedCorrelation(X, Y, Z, 5);
  assert('naive_corr 高 (Z confounding)', r.naive_corr > 0.5, `naive=${r.naive_corr}`);
  assert('adjusted_corr 显著 < naive', r.adjusted_corr < r.naive_corr * 0.7, `adj=${r.adjusted_corr}`);
  assert('confounding_gap > 0', r.confounding_gap > 0);
}

function testGrangerCausality() {
  console.log('\n## grangerCausalityTest');
  const N = 200;
  const X: number[] = [];
  const Y: number[] = [];
  let s = 11;
  for (let i = 0; i < N; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    X.push((s / 233280 - 0.5) * 2);
  }
  for (let i = 0; i < N; i += 1) {
    s = (s * 9301 + 49297) % 233280;
    const noise = (s / 233280 - 0.5) * 0.2;
    Y.push(i === 0 ? noise : 0.5 * X[i - 1] + noise);
  }
  const r = grangerCausalityTest(X, Y, 1);
  assert('F-stat > 5 (X causes Y)', r.f_statistic > 5, `F=${r.f_statistic}`);
  assert('causality_score > 0.5', r.granger_causality_score > 0.5);

  const r2 = grangerCausalityTest(Y, X, 1);
  assert('Y→X 应该弱', r2.granger_causality_score < r.granger_causality_score);
}

function testStateKey() {
  console.log('\n## stateKey');
  const s: ExecutionState = { time_remaining: 5, inventory_pct: 0.5, spread: 'normal', vol: 'low' };
  const key = stateKey(s);
  assert('key 非空', key.length > 0);
  assert('key 含 normal', key.includes('normal'));
}

function testQLearningUpdate() {
  console.log('\n## qLearningUpdate');
  const q = newQTable();
  const s1: ExecutionState = { time_remaining: 5, inventory_pct: 0.5, spread: 'normal', vol: 'low' };
  const s2: ExecutionState = { time_remaining: 4, inventory_pct: 0.4, spread: 'normal', vol: 'low' };
  qLearningUpdate(q, s1, 0, -1, s2, { alpha: 0.5, gamma: 0.9 });
  expectClose('Q(s1,0) after update = -0.5', getQValues(q, s1)[0], -0.5);
}

function testExecutionReward() {
  console.log('\n## executionReward');
  const r1 = executionReward({
    shares_traded: 1000, impact_bps: 10, is_terminal: false, leftover_inventory_pct: 0,
  });
  expectClose('reward = -1', r1, -1);

  const r2 = executionReward({
    shares_traded: 700, impact_bps: 10, is_terminal: true, leftover_inventory_pct: 0.3,
  });
  expectClose('opp cost 显著', r2, -300.7);
}

function testRunEpisode() {
  console.log('\n## runEpisode');
  const q = newQTable();
  const initial: ExecutionState = { time_remaining: 10, inventory_pct: 1.0, spread: 'normal', vol: 'normal' };
  const sim = (state: ExecutionState, action: Action) => {
    const rate = STANDARD_PARTICIPATION_RATES[action];
    const traded = Math.min(state.inventory_pct, rate * 5);
    const newInv = state.inventory_pct - traded;
    const newTime = state.time_remaining - 1;
    return {
      reward: -traded * 5,
      next_state: newTime > 0 && newInv > 0
        ? { ...state, time_remaining: newTime, inventory_pct: newInv }
        : null,
    };
  };
  const result = runEpisode(initial, q, sim, { epsilon: 0, max_steps: 20 });
  assert('steps > 0', result.steps.length > 0);
  assert('total_reward 有限', Number.isFinite(result.total_reward));
}

function testTSRng() {
  console.log('\n## TSRng');
  const rng = new TSRng(42);
  const a = rng.next();
  const rng2 = new TSRng(42);
  expectClose('同 seed 重现', rng2.next(), a);
  for (let i = 0; i < 10; i += 1) {
    assert(`Gaussian sample ∈ [-5, 5]`, Math.abs(rng.nextGaussian()) < 5);
  }
}

function testUpdatePosterior() {
  console.log('\n## updatePosterior');
  const prior = createPrior('s1', 0, 1, 1);
  expectClose('initial post_mu = 0', prior.posterior_mu, 0);

  const p1 = updatePosterior(prior, 2);
  assert('n_obs = 1', p1.n_obs === 1);
  assert('post_mu > 0 (pulled toward 2)', p1.posterior_mu > 0);

  let p = prior;
  for (let i = 0; i < 10; i += 1) p = updatePosterior(p, 2);
  assert('post_mu 接近 2', Math.abs(p.posterior_mu - 2) < 0.2, `mu=${p.posterior_mu}`);
}

function testThompsonSamplingAllocation() {
  console.log('\n## thompsonSamplingAllocation');
  const priors = [createPrior('s1'), createPrior('s2'), createPrior('s3')];
  let s1 = priors[0];
  for (let i = 0; i < 20; i += 1) s1 = updatePosterior(s1, 1.0);
  let s3 = priors[2];
  for (let i = 0; i < 20; i += 1) s3 = updatePosterior(s3, -1.0);
  const updated = [s1, priors[1], s3];

  const rng = new TSRng(42);
  let s1Wins = 0;
  for (let i = 0; i < 100; i += 1) {
    const r = thompsonSamplingAllocation(updated, { rng, mode: 'argmax' });
    if (r.weights[0] === 1) s1Wins += 1;
  }
  assert('s1 大部分时间被选中', s1Wins > 50, `s1Wins=${s1Wins}/100`);
}

function testBetaBernoulli() {
  console.log('\n## sampleBeta + updateBetaBernoulli');
  const rng = new TSRng(7);
  let total = 0;
  const N = 50;
  for (let i = 0; i < N; i += 1) total += sampleBeta(10, 1, rng);
  const avg = total / N;
  assert('mean(Beta(10,1)) > 0.7', avg > 0.7, `avg=${avg}`);

  let post = { strategy_key: 'X', alpha: 1, beta: 1 };
  post = updateBetaBernoulli(post, true);
  post = updateBetaBernoulli(post, true);
  post = updateBetaBernoulli(post, true);
  post = updateBetaBernoulli(post, false);
  assert('α = 4, β = 2', post.alpha === 4 && post.beta === 2);
}

function testBetaBernoulliAllocation() {
  console.log('\n## betaBernoulliThompsonAllocation');
  const posteriors = [
    { strategy_key: 's1', alpha: 10, beta: 1 },
    { strategy_key: 's2', alpha: 1, beta: 10 },
  ];
  const rng = new TSRng(42);
  let s1Wins = 0;
  for (let i = 0; i < 100; i += 1) {
    const r = betaBernoulliThompsonAllocation(posteriors, { rng, mode: 'argmax' });
    if (r.weights[0] === 1) s1Wins += 1;
  }
  assert('s1 几乎总赢 > 80%', s1Wins > 80, `s1Wins=${s1Wins}/100`);
}

function main() {
  testLogGaussianPdf();
  testLogSumExp();
  testHmmForwardBackward();
  testHmmViterbi();
  testInitializeHMMParams();
  testHmmBaumWelch();
  testDecodeRegimeLabels();
  testSolveBoxQP();
  testSolveBoxSimplexQP();
  testSolveQPGeneral();
  testQuantileBin();
  testBackdoorAdjusted();
  testGrangerCausality();
  testStateKey();
  testQLearningUpdate();
  testExecutionReward();
  testRunEpisode();
  testTSRng();
  testUpdatePosterior();
  testThompsonSamplingAllocation();
  testBetaBernoulli();
  testBetaBernoulliAllocation();

  console.log(`\n========================================`);
  console.log(`v5 tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
