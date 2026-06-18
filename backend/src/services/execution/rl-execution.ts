/**
 * Q-Learning for Execution Scheduling
 *
 * 论文 reference:
 *   Hendricks, D. and Wilcox, D. (2014). "A reinforcement learning extension
 *   to the Almgren-Chriss framework for optimal trade execution."
 *   IEEE Computational Intelligence for Financial Engineering (CIFEr).
 *
 *   Nevmyvaka, Y., Feng, Y., Kearns, M. (2006). "Reinforcement Learning for
 *   Optimal Trade Execution."
 *   Proceedings of the 23rd International Conference on Machine Learning.
 *
 *   Watkins, C. J. C. H. and Dayan, P. (1992). "Q-learning."
 *   Machine Learning 8(3-4), 279-292.
 *
 * **核心问题**:
 *
 *   Almgren-Chriss 给出 closed-form optimal trajectory (sinh/cosh schedule),
 *   但假设 linear impact + Gaussian residual. 真实市场:
 *     - impact 非 linear (power-law sublinear)
 *     - intra-day spread 时变 (开盘 / 收盘 wide)
 *     - 大单 splitting strategy 可受市场状态 (vol regime) 影响
 *
 *   RL 解法: 把 child order placement 当 MDP, 用 Q-learning 学最优 policy.
 *
 * **MDP 表示**:
 *
 *   State s_t = (
 *     time_remaining,           ∈ {0, 1, ..., T} (e.g. 10 child orders)
 *     inventory_remaining,      ∈ {0, 0.1, ..., 1.0} normalized
 *     spread_bucket,            ∈ {tight, normal, wide}
 *     vol_bucket,               ∈ {low, normal, high}
 *   )
 *
 *   Action a_t = participation_rate ∈ {0.5%, 1%, 2%, 5%, 10%}
 *
 *   Reward r_t = -impact_cost(a_t)
 *               - opportunity_cost(unfilled at end)
 *               + execution_quality(arrival price vs avg fill price)
 *
 *   Goal: maximize Σ r_t (minimize total cost)
 *
 * **Q-learning update (Watkins 1992)**:
 *
 *     Q(s, a) ← Q(s, a) + α [r + γ max_a' Q(s', a') - Q(s, a)]
 *
 *   - α: learning rate (0.1 default)
 *   - γ: discount factor (0.95 default)
 *   - ε-greedy exploration
 *
 * **本实现**:
 *   - Discrete state space (small enough for tabular Q)
 *   - 5 actions (participation rates)
 *   - Q-table: state_key → action → value
 *   - 离线训练 + 在线 inference (没做 Deep Q-Network, 因为 tabular 够用)
 */

export type SpreadBucket = 'tight' | 'normal' | 'wide';
export type VolBucket = 'low' | 'normal' | 'high';

export interface ExecutionState {
  /** Time steps remaining (0 = must finish now) */
  time_remaining: number;
  /** Inventory still to execute, normalized [0, 1] */
  inventory_pct: number;
  /** Current spread bucket */
  spread: SpreadBucket;
  /** Current volatility bucket */
  vol: VolBucket;
}

/** Standard participation rates as discrete actions */
export const STANDARD_PARTICIPATION_RATES = [0.005, 0.01, 0.02, 0.05, 0.1] as const;
export type Action = number; // index 0..4 into STANDARD_PARTICIPATION_RATES

/**
 * Discretize inventory_pct ∈ [0, 1] into 11 bins (0, 0.1, 0.2, ..., 1.0)
 */
function inventoryBin(p: number): number {
  return Math.max(0, Math.min(10, Math.round(p * 10)));
}

/**
 * State → integer key (for hash table)
 */
export function stateKey(s: ExecutionState): string {
  const t = Math.max(0, Math.min(20, Math.round(s.time_remaining)));
  const inv = inventoryBin(s.inventory_pct);
  return `${t}_${inv}_${s.spread}_${s.vol}`;
}

export interface QTable {
  /** Map from state key to array of action values (length = STANDARD_PARTICIPATION_RATES.length) */
  table: Map<string, number[]>;
}

export function newQTable(): QTable {
  return { table: new Map() };
}

/**
 * Get Q values for a state, initializing to zeros if not seen.
 */
export function getQValues(qtable: QTable, state: ExecutionState): number[] {
  const key = stateKey(state);
  if (!qtable.table.has(key)) {
    qtable.table.set(key, new Array(STANDARD_PARTICIPATION_RATES.length).fill(0));
  }
  return qtable.table.get(key)!;
}

/**
 * ε-greedy action selection.
 *
 *   With prob ε: random action
 *   Else: argmax_a Q(s, a)
 */
export function epsilonGreedyAction(
  qtable: QTable,
  state: ExecutionState,
  epsilon: number,
  rng: () => number = Math.random
): Action {
  if (rng() < epsilon) {
    return Math.floor(rng() * STANDARD_PARTICIPATION_RATES.length);
  }
  const qs = getQValues(qtable, state);
  let bestA = 0;
  let bestV = qs[0];
  for (let a = 1; a < qs.length; a += 1) {
    if (qs[a] > bestV) {
      bestV = qs[a];
      bestA = a;
    }
  }
  return bestA;
}

/**
 * Q-learning update (Watkins 1992):
 *
 *   Q(s, a) ← Q(s, a) + α [r + γ max_a' Q(s', a') - Q(s, a)]
 *
 * If s' is terminal (time_remaining = 0), use just r as target.
 */
export function qLearningUpdate(
  qtable: QTable,
  state: ExecutionState,
  action: Action,
  reward: number,
  next_state: ExecutionState | null,
  options: { alpha?: number; gamma?: number } = {}
): void {
  const alpha = options.alpha ?? 0.1;
  const gamma = options.gamma ?? 0.95;

  const qs = getQValues(qtable, state);
  let target = reward;
  if (next_state !== null) {
    const nextQs = getQValues(qtable, next_state);
    let maxNext = -Infinity;
    for (const v of nextQs) if (v > maxNext) maxNext = v;
    target += gamma * maxNext;
  }
  qs[action] = qs[action] + alpha * (target - qs[action]);
}

/**
 * Reward function for execution.
 *
 *   r = -impact_cost - opportunity_penalty(if terminal and inventory > 0)
 *
 * @param participation_rate from STANDARD_PARTICIPATION_RATES
 * @param shares_traded actual filled shares
 * @param impact_bps from Almgren-Chriss (precomputed)
 * @param is_terminal end of horizon
 * @param leftover_inventory_pct unfilled inventory at end
 */
export function executionReward(input: {
  shares_traded: number;
  impact_bps: number;
  is_terminal: boolean;
  leftover_inventory_pct: number;
  decision_price?: number; // for opp cost
  current_price?: number; // for opp cost
}): number {
  const impact_cost = input.shares_traded * input.impact_bps * 1e-4;
  let opp_cost = 0;
  if (input.is_terminal && input.leftover_inventory_pct > 0) {
    // 假设每股 leftover penalty = decision_price × |drift| × 10 bps (rough)
    if (input.decision_price !== undefined && input.current_price !== undefined) {
      opp_cost =
        Math.abs(input.current_price - input.decision_price) * input.leftover_inventory_pct;
    } else {
      // default penalty
      opp_cost = input.leftover_inventory_pct * 1000; // 1000 bps penalty
    }
  }
  return -(impact_cost + opp_cost);
}

/**
 * Simple episode runner (for training simulation).
 *
 * Given a market simulator (cb), step through T time steps:
 *
 *   - state s_t
 *   - action a_t (from policy)
 *   - simulator returns (reward, next_state)
 *   - Q update
 *
 * @returns total reward + final inventory
 */
export interface EpisodeStep {
  state: ExecutionState;
  action: Action;
  reward: number;
  next_state: ExecutionState | null;
}

export function runEpisode(
  initial_state: ExecutionState,
  qtable: QTable,
  simulator: (
    state: ExecutionState,
    action: Action
  ) => { reward: number; next_state: ExecutionState | null },
  options: {
    epsilon?: number;
    alpha?: number;
    gamma?: number;
    rng?: () => number;
    max_steps?: number;
  } = {}
): { total_reward: number; steps: EpisodeStep[]; final_state: ExecutionState | null } {
  const epsilon = options.epsilon ?? 0.1;
  const max_steps = options.max_steps ?? 30;
  let state: ExecutionState | null = initial_state;
  let total_reward = 0;
  const steps: EpisodeStep[] = [];

  for (let step = 0; step < max_steps; step += 1) {
    if (state === null) break;
    const action = epsilonGreedyAction(qtable, state, epsilon, options.rng);
    const { reward, next_state } = simulator(state, action);
    total_reward += reward;
    steps.push({ state, action, reward, next_state });
    qLearningUpdate(qtable, state, action, reward, next_state, options);
    state = next_state;
    if (state === null || state.time_remaining <= 0 || state.inventory_pct <= 0) break;
  }

  return { total_reward, steps, final_state: state };
}

/**
 * Inference: get best action from trained Q-table (no exploration).
 */
export function bestAction(
  qtable: QTable,
  state: ExecutionState
): { action: Action; participation_rate: number; q_value: number } {
  const qs = getQValues(qtable, state);
  let bestA = 0;
  let bestV = qs[0];
  for (let a = 1; a < qs.length; a += 1) {
    if (qs[a] > bestV) {
      bestV = qs[a];
      bestA = a;
    }
  }
  return {
    action: bestA,
    participation_rate: STANDARD_PARTICIPATION_RATES[bestA],
    q_value: bestV,
  };
}

/**
 * Train Q-learning on a corpus of episodes (e.g. historical execution data).
 *
 * @param episodes list of (initial_state, simulator) pairs
 * @param n_iterations how many passes over the corpus
 */
export function trainQLearning(
  episodes: Array<{
    initial_state: ExecutionState;
    simulator: (
      state: ExecutionState,
      action: Action
    ) => { reward: number; next_state: ExecutionState | null };
  }>,
  options: {
    n_iterations?: number;
    epsilon_initial?: number;
    epsilon_decay?: number;
    alpha?: number;
    gamma?: number;
    seed?: number;
  } = {}
): { qtable: QTable; avg_rewards: number[] } {
  const n_iter = options.n_iterations ?? 100;
  const eps0 = options.epsilon_initial ?? 0.5;
  const decay = options.epsilon_decay ?? 0.95;
  const seed = options.seed ?? 42;
  // Park-Miller LCG
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  const rng = (): number => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };

  const qtable = newQTable();
  const avg_rewards: number[] = [];

  for (let iter = 0; iter < n_iter; iter += 1) {
    const epsilon = eps0 * Math.pow(decay, iter);
    let totalRew = 0;
    let totalCount = 0;
    for (const ep of episodes) {
      const r = runEpisode(ep.initial_state, qtable, ep.simulator, {
        epsilon,
        alpha: options.alpha,
        gamma: options.gamma,
        rng,
      });
      totalRew += r.total_reward;
      totalCount += 1;
    }
    avg_rewards.push(totalCount > 0 ? totalRew / totalCount : 0);
  }

  return { qtable, avg_rewards };
}
