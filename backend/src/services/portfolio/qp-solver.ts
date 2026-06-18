/**
 * Quadratic Programming Solver (ADMM-based, OSQP-inspired)
 *
 * 论文 reference:
 *   Stellato, B., Banjac, G., Goulart, P., Bemporad, A., Boyd, S. (2020).
 *   "OSQP: An Operator Splitting Solver for Quadratic Programs."
 *   Mathematical Programming Computation 12(4), 637-672.
 *   https://osqp.org/papers/osqp.pdf
 *
 *   Boyd, S., Parikh, N., Chu, E., Peleato, B., Eckstein, J. (2011).
 *   "Distributed Optimization and Statistical Learning via the Alternating
 *   Direction Method of Multipliers."
 *   Foundations and Trends in Machine Learning 3(1), 1-122.
 *
 * **核心问题**:
 *
 *   v1-v4 PortfolioConstruction 用 projected gradient descent (PGA):
 *     - 只能 box + simplex 约束
 *     - 不能加 sector cap (e.g. "银行 ≤ 30%") inequality constraint
 *     - 不能加 turnover penalty as constraint
 *
 *   QP standard form:
 *     min   0.5 x^T P x + q^T x
 *     s.t.  l ≤ A x ≤ u
 *
 *   - P: N×N positive semi-definite (typically cov)
 *   - q: N-vector (typically -μ for max-return + cov; 0 for min-variance)
 *   - A: M×N constraint matrix
 *   - l, u: M-vectors (-Inf for unconstrained side)
 *
 *   通过设 A = [I; e^T; G] (box + simplex + group), QP 覆盖所有 portfolio constraints.
 *
 * **OSQP ADMM iteration (简化版)**:
 *
 *   ADMM splits QP into 2 subproblems:
 *
 *     min 0.5 x^T P x + q^T x + ρ/2 ||x - z + u/ρ||²        ← x-update (linear solve)
 *     z = clip(A x + u/ρ, l, u)                              ← z-update (box projection)
 *     u = u + ρ (A x - z)                                    ← dual update
 *
 *   重复直到 ||A x - z|| < ε_pri AND ||ρ A^T (z - z_prev)|| < ε_dual
 *
 *   原 OSQP 还有 KKT 矩阵分解 + adaptive rho. 这里实现简化版:
 *     - 用 conjugate gradient 解 x-update (避免显式 KKT 因子分解)
 *     - 固定 rho (caller 可调)
 *     - 简单收敛准则
 *
 * **本实现**:
 *   - solveQP(P, q, A, l, u, options) — 主入口
 *   - solveBoxQP(P, q, lb, ub) — 简化接口 (常用 case)
 *   - solveBoxSimplexQP(P, q, lb, ub) — box + simplex (PortfolioOptimizer 默认场景)
 *   - 用 conjugate gradient subroutine for linear solves
 */

/**
 * Matrix-vector multiply: y = A x
 */
function matVecMul(A: number[][], x: number[]): number[] {
  const m = A.length;
  if (m === 0) return [];
  const n = x.length;
  const y: number[] = new Array(m).fill(0);
  for (let i = 0; i < m; i += 1) {
    let s = 0;
    for (let j = 0; j < n; j += 1) s += A[i][j] * x[j];
    y[i] = s;
  }
  return y;
}

/**
 * Transpose matrix-vector multiply: y = A^T x
 */
function matTransposeVecMul(A: number[][], x: number[]): number[] {
  const m = A.length;
  if (m === 0) return [];
  const n = A[0].length;
  const y: number[] = new Array(n).fill(0);
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < n; j += 1) y[j] += A[i][j] * x[i];
  }
  return y;
}

/**
 * Conjugate Gradient solver for symmetric positive definite (SPD) system Mx = b
 *
 * 解 (P + ρ A^T A) x = b for x-update of ADMM.
 *
 * 这里 P, A^T A 都是 SPD, 加和也 SPD, CG 收敛.
 */
function conjugateGradient(
  matvec: (x: number[]) => number[],
  b: number[],
  options: { max_iter?: number; tol?: number; initial?: number[] } = {}
): number[] {
  const n = b.length;
  const x = options.initial?.slice() ?? new Array(n).fill(0);
  const r = b.map((v, i) => v - matvec(x)[i]);
  const p = r.slice();
  let rs_old = r.reduce((s, v) => s + v * v, 0);
  const max_iter = options.max_iter ?? Math.min(n, 50);
  const tol = options.tol ?? 1e-8;

  for (let iter = 0; iter < max_iter; iter += 1) {
    if (rs_old < tol * tol) break;
    const Ap = matvec(p);
    const pAp = p.reduce((s, v, i) => s + v * Ap[i], 0);
    if (Math.abs(pAp) < 1e-20) break;
    const alpha = rs_old / pAp;
    for (let i = 0; i < n; i += 1) x[i] += alpha * p[i];
    for (let i = 0; i < n; i += 1) r[i] -= alpha * Ap[i];
    const rs_new = r.reduce((s, v) => s + v * v, 0);
    const beta = rs_new / rs_old;
    for (let i = 0; i < n; i += 1) p[i] = r[i] + beta * p[i];
    rs_old = rs_new;
  }
  return x;
}

/**
 * Element-wise clip: max(lb, min(ub, x))
 */
function clip(x: number[], lb: number[], ub: number[]): number[] {
  return x.map((v, i) => Math.max(lb[i], Math.min(ub[i], v)));
}

export interface QPProblem {
  /** N×N positive semi-definite (typically 2 × cov for portfolio) */
  P: number[][];
  /** N-vector */
  q: number[];
  /** M×N constraint matrix (rows: l_m ≤ A_m x ≤ u_m) */
  A: number[][];
  /** M lower bounds (use -Infinity for unbounded below) */
  l: number[];
  /** M upper bounds (use Infinity for unbounded above) */
  u: number[];
}

export interface QPOptions {
  /** ADMM penalty parameter (default 1.0) */
  rho?: number;
  /** Max iterations (default 200) */
  max_iter?: number;
  /** Primal residual tolerance (default 1e-4) */
  eps_primal?: number;
  /** Dual residual tolerance (default 1e-4) */
  eps_dual?: number;
  /** Initial x (default zeros) */
  x0?: number[];
  /** Initial dual y (default zeros) */
  y0?: number[];
}

export interface QPSolution {
  x: number[];
  /** Final objective: 0.5 x^T P x + q^T x */
  objective: number;
  /** Final primal residual: ||A x - z|| */
  primal_residual: number;
  /** Final dual residual: ||ρ A^T (z - z_prev)|| */
  dual_residual: number;
  iterations: number;
  converged: boolean;
}

/**
 * ADMM-based QP solver (simplified OSQP).
 *
 * Algorithm (Boyd 2011 + Stellato 2020):
 *
 *   1. x_{k+1} = (P + ρ A^T A)^{-1} (ρ A^T (z_k - u_k/ρ) - q)    -- linear solve via CG
 *   2. z_{k+1} = clip(A x_{k+1} + u_k/ρ, l, u)                   -- box projection
 *   3. u_{k+1} = u_k + ρ (A x_{k+1} - z_{k+1})                   -- dual update
 *   4. Check residuals: ||A x - z|| < eps_primal, ||ρ A^T (z - z_prev)|| < eps_dual
 */
export function solveQP(problem: QPProblem, options: QPOptions = {}): QPSolution {
  const rho = options.rho ?? 1.0;
  const max_iter = options.max_iter ?? 200;
  const eps_primal = options.eps_primal ?? 1e-4;
  const eps_dual = options.eps_dual ?? 1e-4;

  const N = problem.P.length;
  const M = problem.A.length;
  if (problem.q.length !== N) throw new Error('solveQP: q length mismatch');
  if (M > 0 && problem.A[0].length !== N) throw new Error('solveQP: A cols mismatch');
  if (problem.l.length !== M || problem.u.length !== M)
    throw new Error('solveQP: l/u length mismatch');

  let x = options.x0?.slice() ?? new Array(N).fill(0);
  let z = matVecMul(problem.A, x);
  const y = options.y0?.slice() ?? new Array(M).fill(0);

  // matvec for (P + ρ A^T A) v
  const Pmat = problem.P;
  const Amat = problem.A;
  const matvec_PrhoAtA = (v: number[]): number[] => {
    const Pv = matVecMul(Pmat, v);
    const Av = matVecMul(Amat, v);
    const AtAv = matTransposeVecMul(Amat, Av);
    return Pv.map((pv, i) => pv + rho * AtAv[i]);
  };

  let z_prev = z.slice();
  let primal_res = Infinity;
  let dual_res = Infinity;
  let iter = 0;
  let converged = false;

  for (iter = 0; iter < max_iter; iter += 1) {
    // x-update: solve (P + ρ A^T A) x = -q + ρ A^T (z - y/ρ)
    const z_minus_y_rho = z.map((v, i) => v - y[i] / rho);
    const Atrhs = matTransposeVecMul(Amat, z_minus_y_rho);
    const rhs = problem.q.map((qi, i) => -qi + rho * Atrhs[i]);
    x = conjugateGradient(matvec_PrhoAtA, rhs, {
      initial: x,
      max_iter: Math.min(N, 100),
      tol: 1e-10,
    });

    // z-update: z = clip(A x + y/ρ, l, u)
    const Ax = matVecMul(Amat, x);
    z_prev = z.slice();
    z = clip(
      Ax.map((v, i) => v + y[i] / rho),
      problem.l,
      problem.u
    );

    // y-update: y = y + ρ (A x - z)
    for (let i = 0; i < M; i += 1) y[i] += rho * (Ax[i] - z[i]);

    // residuals
    primal_res = Math.sqrt(Ax.reduce((s, v, i) => s + (v - z[i]) ** 2, 0));
    const z_diff = z.map((v, i) => v - z_prev[i]);
    const rhoAtz_diff = matTransposeVecMul(Amat, z_diff).map(v => rho * v);
    dual_res = Math.sqrt(rhoAtz_diff.reduce((s, v) => s + v * v, 0));

    if (primal_res < eps_primal && dual_res < eps_dual) {
      converged = true;
      break;
    }
  }

  // objective
  const Px = matVecMul(Pmat, x);
  const obj =
    0.5 * x.reduce((s, v, i) => s + v * Px[i], 0) + problem.q.reduce((s, v, i) => s + v * x[i], 0);

  return {
    x,
    objective: obj,
    primal_residual: primal_res,
    dual_residual: dual_res,
    iterations: iter + 1,
    converged,
  };
}

/**
 * Simplified interface: Box QP (only box constraints lb ≤ x ≤ ub)
 *
 *   min 0.5 x^T P x + q^T x
 *   s.t. lb ≤ x ≤ ub
 */
export function solveBoxQP(
  P: number[][],
  q: number[],
  lb: number[],
  ub: number[],
  options: QPOptions = {}
): QPSolution {
  const N = P.length;
  // A = I (identity)
  const A: number[][] = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => (i === j ? 1 : 0))
  );
  return solveQP({ P, q, A, l: lb, u: ub }, options);
}

/**
 * Box + Simplex QP:
 *
 *   min 0.5 x^T P x + q^T x
 *   s.t. lb ≤ x ≤ ub
 *        sum(x) = total  (default 1)
 */
export function solveBoxSimplexQP(
  P: number[][],
  q: number[],
  lb: number[],
  ub: number[],
  total = 1,
  options: QPOptions = {}
): QPSolution {
  const N = P.length;
  // A = [I; e^T] → (N+1) × N
  const A: number[][] = [];
  for (let i = 0; i < N; i += 1) {
    const row = new Array(N).fill(0);
    row[i] = 1;
    A.push(row);
  }
  A.push(new Array(N).fill(1)); // e^T
  const l = [...lb, total];
  const u = [...ub, total];
  return solveQP({ P, q, A, l, u }, options);
}
