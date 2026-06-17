/**
 * AdvancedQuantController — Sprint 1-3 上一阶段「组合经理 + 风控官 + 执行交易员」
 * 5 个新 service 的 HTTP 控制器集中入口。
 *
 * 路由 namespace: /api/advanced-quant/*
 *
 * Endpoints:
 *
 *   研究严谨性 (Sprint 1A):
 *     POST  /research-integrity/audit
 *     GET   /research-integrity/recent
 *     GET   /research-integrity/by-strategy/:strategy_key
 *     GET   /research-integrity/by-backtest/:source/:backtest_id
 *
 *   执行可行性 (Sprint 1B):
 *     POST  /execution-feasibility/check
 *     POST  /execution-feasibility/batch
 *     GET   /execution-feasibility/recent
 *
 *   Meta-label 决策 (Sprint 2A):
 *     POST  /meta-label/decide
 *     POST  /meta-label/train
 *     GET   /meta-label/model
 *     GET   /meta-label/recent
 *
 *   组合构造 (Sprint 2B):
 *     POST  /portfolio-construction/construct
 *     GET   /portfolio-construction/recent
 *
 *   资金曲线 Governor (Sprint 3):
 *     POST  /governor/evaluate
 *     POST  /governor/evaluate-all
 *     GET   /governor/multiplier/:portfolio_id
 *     GET   /governor/history/:portfolio_id
 */

import { Request, Response } from 'express';
import { researchIntegrityService } from '../../services/research/ResearchIntegrityService';
import { executionFeasibilityService } from '../../services/execution/ExecutionFeasibilityService';
import { metaLabelService } from '../../services/meta/MetaLabelService';
import { portfolioConstructionService } from '../../services/portfolio/PortfolioConstructionService';
import { equityCurveGovernorService } from '../../services/governor/EquityCurveGovernorService';
import { compositeRebalanceService } from '../../portfolio/internal/CompositeRebalanceService';
import { logger } from '../../utils/logger';

export class AdvancedQuantController {
  // ============================================================
  // Research Integrity (Sprint 1A)
  // ============================================================

  async runResearchAudit(req: Request, res: Response) {
    try {
      const body = req.body || {};
      const report = await researchIntegrityService.auditBacktest(
        {
          backtest_id: body.backtest_id ?? null,
          source: body.source || 'standalone',
          strategy_key: body.strategy_key ?? null,
          observed_sharpe: body.observed_sharpe ?? null,
          oos_sharpe: body.oos_sharpe ?? null,
          num_trials: body.num_trials ?? 1,
          sample_length: body.sample_length ?? 0,
          cpcv_paths: body.cpcv_paths,
          skew: body.skew,
          kurt: body.kurt,
          scan_strategy_code: body.scan_strategy_code === true,
          strategy_scan_dirs: body.strategy_scan_dirs,
          universe_snapshots: body.universe_snapshots,
          current_universe: body.current_universe,
        },
        { persist: body.persist !== false }
      );
      res.json({ success: true, data: report });
    } catch (err: any) {
      logger.error('[advanced-quant] runResearchAudit failed:', err);
      res.status(400).json({ success: false, message: err?.message || 'audit failed' });
    }
  }

  async listResearchAudits(req: Request, res: Response) {
    try {
      const limit = parseInt(String(req.query.limit || '30'), 10);
      const rows = await researchIntegrityService.listRecentAudits(limit);
      res.json({ success: true, data: rows });
    } catch (err: any) {
      logger.error('[advanced-quant] listResearchAudits failed:', err);
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  async listResearchAuditsByStrategy(req: Request, res: Response) {
    try {
      const strategy_key = req.params.strategy_key;
      const limit = parseInt(String(req.query.limit || '30'), 10);
      const rows = await researchIntegrityService.listAuditsByStrategy(strategy_key, limit);
      res.json({ success: true, data: rows });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  async getLatestResearchAuditForBacktest(req: Request, res: Response) {
    try {
      const source = req.params.source;
      const backtest_id = parseInt(req.params.backtest_id, 10);
      if (!Number.isFinite(backtest_id)) {
        return res.status(400).json({ success: false, message: 'backtest_id 必须是 number' });
      }
      const row = await researchIntegrityService.getLatestAuditForBacktest(backtest_id, source);
      if (!row) return res.json({ success: true, data: null });
      res.json({ success: true, data: row });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  // ============================================================
  // Execution Feasibility (Sprint 1B)
  // ============================================================

  async checkExecutionFeasibility(req: Request, res: Response) {
    try {
      const body = req.body || {};
      if (!body.symbol || !body.side || body.target_qty === undefined || !body.as_of_date) {
        return res.status(400).json({
          success: false,
          message: '缺少必填字段: symbol / side / target_qty / as_of_date',
        });
      }
      const report = await executionFeasibilityService.computeFeasibility(
        {
          user_id: (req as any).user?.id,
          symbol: body.symbol,
          side: body.side,
          target_qty: Number(body.target_qty),
          target_price: body.target_price !== undefined ? Number(body.target_price) : null,
          as_of_date: body.as_of_date,
          market_snapshot: body.market_snapshot,
          holding_buy_date: body.holding_buy_date,
          market_segment: body.market_segment,
        },
        { persist: body.persist === true }
      );
      res.json({ success: true, data: report });
    } catch (err: any) {
      logger.error('[advanced-quant] checkExecutionFeasibility failed:', err);
      res.status(400).json({ success: false, message: err?.message });
    }
  }

  async batchExecutionFeasibility(req: Request, res: Response) {
    try {
      const body = req.body || {};
      const inputs = Array.isArray(body.candidates) ? body.candidates : [];
      if (inputs.length === 0) {
        return res.status(400).json({ success: false, message: '请传入 candidates 数组' });
      }
      const user_id = (req as any).user?.id;
      const reports = await executionFeasibilityService.computeBatch(
        inputs.map((c: any) => ({
          user_id,
          symbol: c.symbol,
          side: c.side,
          target_qty: Number(c.target_qty),
          target_price: c.target_price !== undefined ? Number(c.target_price) : null,
          as_of_date: c.as_of_date,
          market_snapshot: c.market_snapshot,
          holding_buy_date: c.holding_buy_date,
          market_segment: c.market_segment,
        })),
        { persist: body.persist === true }
      );
      res.json({
        success: true,
        data: {
          reports,
          summary: {
            total: reports.length,
            fillable: reports.filter(r => r.decision === 'fillable').length,
            risky: reports.filter(r => r.decision === 'risky').length,
            blocked: reports.filter(r => r.decision === 'blocked').length,
          },
        },
      });
    } catch (err: any) {
      logger.error('[advanced-quant] batchExecutionFeasibility failed:', err);
      res.status(400).json({ success: false, message: err?.message });
    }
  }

  async listExecutionFeasibility(req: Request, res: Response) {
    try {
      const limit = parseInt(String(req.query.limit || '50'), 10);
      const rows = await executionFeasibilityService.listRecent(limit, {
        user_id: (req as any).user?.id,
        decision: req.query.decision as string,
      });
      res.json({ success: true, data: rows });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  // ============================================================
  // Meta-label (Sprint 2A)
  // ============================================================

  async decideMetaLabel(req: Request, res: Response) {
    try {
      const body = req.body || {};
      if (!body.symbol || !body.as_of_date || !body.features) {
        return res
          .status(400)
          .json({ success: false, message: '缺少必填字段: symbol / as_of_date / features' });
      }
      const result = await metaLabelService.shouldBet(
        {
          signal_id: body.signal_id ?? null,
          signal_source: body.signal_source ?? null,
          symbol: body.symbol,
          strategy_key: body.strategy_key ?? null,
          as_of_date: body.as_of_date,
          features: body.features,
        },
        { threshold: body.threshold, persist: body.persist === true }
      );
      res.json({ success: true, data: result });
    } catch (err: any) {
      logger.error('[advanced-quant] decideMetaLabel failed:', err);
      res.status(400).json({ success: false, message: err?.message });
    }
  }

  async trainMetaLabel(req: Request, res: Response) {
    try {
      const body = req.body || {};
      const rows = body.rows;
      if (!Array.isArray(rows) || rows.length < 30) {
        return res.status(400).json({
          success: false,
          message: '训练数据 rows 必须是数组且 ≥ 30 行',
        });
      }
      const model = await metaLabelService.train(rows);
      res.json({ success: true, data: model });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err?.message });
    }
  }

  async getMetaLabelModel(req: Request, res: Response) {
    try {
      const model = metaLabelService.getModel();
      res.json({ success: true, data: model });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  async listMetaLabelDecisions(req: Request, res: Response) {
    try {
      const limit = parseInt(String(req.query.limit || '50'), 10);
      const rows = await metaLabelService.listRecent(limit, {
        decision: req.query.decision as string,
        strategy_key: req.query.strategy_key as string,
      });
      res.json({ success: true, data: rows });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  // ============================================================
  // Portfolio Construction (Sprint 2B)
  // ============================================================

  async constructPortfolio(req: Request, res: Response) {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.candidates) || body.candidates.length === 0) {
        return res.status(400).json({ success: false, message: '请传入 candidates 数组' });
      }
      if (!body.as_of_date) {
        return res.status(400).json({ success: false, message: '缺少 as_of_date' });
      }
      const result = await portfolioConstructionService.construct(
        {
          user_id: (req as any).user?.id,
          as_of_date: body.as_of_date,
          candidates: body.candidates,
          cov_matrix: body.cov_matrix,
          expected_returns: body.expected_returns,
        },
        {
          method: body.method,
          max_weight: body.max_weight,
          min_weight: body.min_weight,
          max_industry_weight: body.max_industry_weight,
          total_allocation: body.total_allocation,
          risk_aversion: body.risk_aversion,
          persist: body.persist === true,
        }
      );
      res.json({ success: true, data: result });
    } catch (err: any) {
      logger.error('[advanced-quant] constructPortfolio failed:', err);
      res.status(400).json({ success: false, message: err?.message });
    }
  }

  async listPortfolioConstructions(req: Request, res: Response) {
    try {
      const limit = parseInt(String(req.query.limit || '30'), 10);
      const rows = await portfolioConstructionService.listRecent(limit, (req as any).user?.id);
      res.json({ success: true, data: rows });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  // ============================================================
  // Equity Curve Governor (Sprint 3)
  // ============================================================

  async evaluateGovernor(req: Request, res: Response) {
    try {
      const body = req.body || {};
      const user_id = (req as any).user?.id;
      const portfolio_id = body.portfolio_id ? parseInt(body.portfolio_id, 10) : null;
      if (!portfolio_id) {
        return res.status(400).json({ success: false, message: '缺少 portfolio_id' });
      }
      const result = await equityCurveGovernorService.evaluatePortfolio(
        { portfolio_id, user_id: user_id || 0 },
        {
          as_of_date: body.as_of_date,
          persist: body.persist !== false,
        }
      );
      res.json({ success: true, data: result });
    } catch (err: any) {
      logger.error('[advanced-quant] evaluateGovernor failed:', err);
      res.status(400).json({ success: false, message: err?.message });
    }
  }

  async evaluateGovernorAll(req: Request, res: Response) {
    try {
      const body = req.body || {};
      const results = await equityCurveGovernorService.evaluateAll({
        as_of_date: body.as_of_date,
        persist: body.persist !== false,
      });
      res.json({
        success: true,
        data: {
          evaluated: results.length,
          by_tier: results.reduce((acc, r) => {
            acc[r.tier] = (acc[r.tier] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
          results,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  async getGovernorMultiplier(req: Request, res: Response) {
    try {
      const portfolio_id = parseInt(req.params.portfolio_id, 10);
      if (!Number.isFinite(portfolio_id)) {
        return res.status(400).json({ success: false, message: 'portfolio_id 必须是 number' });
      }
      const mult = await equityCurveGovernorService.getCurrentMultiplier(portfolio_id);
      res.json({ success: true, data: { portfolio_id, multiplier: mult } });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  async getGovernorHistory(req: Request, res: Response) {
    try {
      const portfolio_id = parseInt(req.params.portfolio_id, 10);
      const days = parseInt(String(req.query.days || '90'), 10);
      if (!Number.isFinite(portfolio_id)) {
        return res.status(400).json({ success: false, message: 'portfolio_id 必须是 number' });
      }
      const rows = await equityCurveGovernorService.getHistory(portfolio_id, days);
      res.json({ success: true, data: rows });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  // ============================================================
  // v2-v5 Method Config (Final Production Switch)
  // ============================================================

  /**
   * GET /api/advanced-quant/method-config
   *
   * 返回当前激活的 advanced 方法配置 (HMM regime / Thompson Kelly / HRP cov 等).
   * Ops 可调用此 endpoint 看哪些 v2-v5 模块在用.
   */
  async getMethodConfig(_req: Request, res: Response) {
    try {
      const config = {
        v5: {
          hmm_regime_detection: {
            enabled: process.env.HMM_REGIME_ENABLED === 'true',
            env_var: 'HMM_REGIME_ENABLED',
            description: 'HMM-based regime detection (替代 4-regime hard rules)',
            paper: 'Hamilton 1989',
          },
          thompson_kelly: {
            enabled: process.env.TS_KELLY_ENABLED === 'true',
            env_var: 'TS_KELLY_ENABLED',
            description: 'Thompson Sampling 给 Kelly fraction 加 90% lower confidence',
            paper: 'Thompson 1933 / Chapelle-Li 2011',
          },
        },
        v4: {
          almgren_chriss_execution: {
            enabled_by: 'caller passes use_almgren_chriss=true to ExecutionFeasibility',
            description: 'Linear impact model: h(v) = ε + η·v + γ·v',
            paper: 'Almgren-Chriss 2000',
          },
          tca_implementation_shortfall: {
            available: true,
            description: 'IS = trading_cost + opportunity_cost + fixed_cost + delay_cost',
            paper: 'Perold 1988',
          },
        },
        v3: {
          metalabel_online_learning: {
            available: true,
            description: 'SGD incremental update for MetaLabel model',
            paper: 'Robbins-Monro 1951, Bottou 2010',
          },
          fractional_diff: {
            available: true,
            description: 'Fractional differentiation features (stationary + memory)',
            paper: 'De Prado AFML Ch.5',
          },
        },
        v2: {
          hrp_portfolio: {
            enabled_by: 'caller passes method=hrp to PortfolioConstruction',
            description: 'Hierarchical Risk Parity (no cov inverse needed)',
            paper: 'López de Prado 2016',
          },
          ledoit_wolf_shrinkage: {
            enabled_by: 'caller passes cov_estimator=ledoit_wolf',
            description: 'Shrinkage covariance (small-sample stable)',
            paper: 'Ledoit-Wolf 2004',
          },
          carver_buffer: {
            enabled_by: 'caller passes use_carver_continuous=true to Governor',
            description: '5 档 → 连续 multiplier + buffer zone 防频繁切换',
            paper: 'Carver 2015',
          },
        },
        v6: {
          pca_fama_french: { available: true, paper: 'Fama-French 1993' },
          garch_egarch_har: {
            available: true,
            paper: 'Bollerslev 1986 / Nelson 1991 / Corsi 2009',
          },
          nelson_siegel_vasicek: { available: true, paper: 'Nelson-Siegel 1987 / Vasicek 1977' },
          bouchaud_square_root_impact: { available: true, paper: 'Bouchaud 2009' },
          bayesian_model_averaging: { available: true, paper: 'Raftery 1995' },
        },
      };
      res.json({ success: true, data: config });
    } catch (err: any) {
      logger.error('[advanced-quant] getMethodConfig failed:', err);
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  /**
   * POST /api/advanced-quant/method-config
   *
   * 设置环境变量级别的 method 开关 (HMM_REGIME_ENABLED / TS_KELLY_ENABLED).
   * 注意: 重启后失效 (env 写入 process.env, 不持久化). 持久化需修 .env 文件.
   */
  async setMethodConfig(req: Request, res: Response) {
    try {
      const { hmm_regime_enabled, ts_kelly_enabled } = req.body || {};
      const changes: Record<string, string> = {};
      if (typeof hmm_regime_enabled === 'boolean') {
        process.env.HMM_REGIME_ENABLED = hmm_regime_enabled ? 'true' : 'false';
        changes.HMM_REGIME_ENABLED = process.env.HMM_REGIME_ENABLED;
      }
      if (typeof ts_kelly_enabled === 'boolean') {
        process.env.TS_KELLY_ENABLED = ts_kelly_enabled ? 'true' : 'false';
        changes.TS_KELLY_ENABLED = process.env.TS_KELLY_ENABLED;
      }
      res.json({
        success: true,
        data: {
          changes,
          message: '环境变量已更新 (内存级别). 重启后失效, 持久化需修改 .env 文件.',
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  // ========================================================================
  // Sprint 25: Brinson Attribution / MCR / Crowding / Vol-Target
  // ========================================================================

  /**
   * POST /api/advanced-quant/attribution/brinson
   *
   * Brinson 行业归因 — 分解组合 vs 基准的 active return.
   * Body: { industries[], portfolio_weights[], benchmark_weights[], stock_returns[] }
   */
  async runBrinsonAttribution(req: Request, res: Response) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { brinsonAttribution } = require('../../services/portfolio/brinson-mcr-style-crowding');
      const result = brinsonAttribution(req.body);
      res.json({ success: true, data: result });
    } catch (err: any) {
      logger.error('[advanced-quant] brinsonAttribution failed:', err);
      res.status(400).json({ success: false, message: err?.message });
    }
  }

  /**
   * POST /api/advanced-quant/attribution/mcr
   *
   * Marginal Contribution to Risk — 每股对组合波动率的边际贡献.
   * Body: { weights[], cov[][], symbols[]?, top_n?: number }
   */
  async runMcr(req: Request, res: Response) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {
        marginalContributionToRisk,
        topRiskContributors,
      } = require('../../services/portfolio/brinson-mcr-style-crowding');
      const { weights, cov, symbols, top_n = 5 } = req.body || {};
      if (!Array.isArray(weights) || !Array.isArray(cov)) {
        return res.status(400).json({ success: false, message: 'weights[] 和 cov[][] 必须提供' });
      }
      const mcr = marginalContributionToRisk(weights, cov);
      const top = Array.isArray(symbols) ? topRiskContributors(weights, cov, symbols, top_n) : null;
      res.json({
        success: true,
        data: { mcr, top_contributors: top?.top_contributors, top_hedgers: top?.top_hedgers },
      });
    } catch (err: any) {
      logger.error('[advanced-quant] MCR failed:', err);
      res.status(400).json({ success: false, message: err?.message });
    }
  }

  /**
   * POST /api/advanced-quant/attribution/crowding
   *
   * Crowding Score — 信号是否被市场广泛持有 (alpha decay 前兆).
   * Body: { signal[], market_consensus[], fund_concentration_change, margin_balance_change }
   */
  async runCrowdingScore(req: Request, res: Response) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { crowdingScore } = require('../../services/portfolio/brinson-mcr-style-crowding');
      const result = crowdingScore(req.body);
      res.json({ success: true, data: result });
    } catch (err: any) {
      logger.error('[advanced-quant] crowdingScore failed:', err);
      res.status(400).json({ success: false, message: err?.message });
    }
  }

  /**
   * POST /api/advanced-quant/attribution/vol-target
   *
   * 波动率目标缩放 — 根据组合波动率与目标的差距, 调整 leverage.
   * Body: { weights[], cov[][], vol_target_annual, max_leverage, prev_leverage?, buffer_pct? }
   */
  async runVolTargeting(req: Request, res: Response) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {
        portfolioVolTargeting,
      } = require('../../services/portfolio/brinson-mcr-style-crowding');
      const result = portfolioVolTargeting(req.body);
      res.json({ success: true, data: result });
    } catch (err: any) {
      logger.error('[advanced-quant] volTargeting failed:', err);
      res.status(400).json({ success: false, message: err?.message });
    }
  }

  // ========================================================================
  // Sprint 25: Strategy Capacity & Alpha Decay (Sprint 23 接入)
  // ========================================================================

  /**
   * POST /api/advanced-quant/strategy-health/capacity
   *
   * 策略容量分析 — 给定持仓股的 ADV, 算 bottleneck capacity.
   * Body: { stock_adv_values[], positions_per_stock_pct, n_holding_days,
   *         participation_rate, n_trades_per_year }
   */
  async estimateCapacity(req: Request, res: Response) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { estimateStrategyCapacity } = require('../../services/research/ashare-pit-capacity');
      const result = estimateStrategyCapacity(req.body);
      res.json({ success: true, data: result });
    } catch (err: any) {
      logger.error('[advanced-quant] estimateCapacity failed:', err);
      res.status(400).json({ success: false, message: err?.message });
    }
  }

  /**
   * POST /api/advanced-quant/strategy-health/alpha-decay
   *
   * Alpha 衰减监控 — observed half-life vs expected.
   * Body: { signal_name, observed_ic_series: [{days_after_signal, ic}, ...] }
   */
  async monitorDecay(req: Request, res: Response) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {
        monitorAlphaDecay,
        SIGNAL_HALF_LIVES,
      } = require('../../services/research/ashare-pit-capacity');
      const result = monitorAlphaDecay(req.body);
      res.json({
        success: true,
        data: { ...result, known_signals: Object.keys(SIGNAL_HALF_LIVES) },
      });
    } catch (err: any) {
      logger.error('[advanced-quant] monitorDecay failed:', err);
      res.status(400).json({ success: false, message: err?.message });
    }
  }

  /**
   * GET /api/advanced-quant/strategy-health/signal-half-lives
   *
   * 查 SIGNAL_HALF_LIVES 表 — 已知信号的预期 alpha 半衰期 (天).
   */
  async listSignalHalfLives(_req: Request, res: Response) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {
        SIGNAL_HALF_LIVES,
        recommendHoldingPeriod,
      } = require('../../services/research/ashare-pit-capacity');
      const entries = Object.entries(SIGNAL_HALF_LIVES).map(([signal, half_life]) => ({
        signal_name: signal,
        expected_half_life_days: half_life,
        recommended_holding_period: recommendHoldingPeriod
          ? recommendHoldingPeriod(signal as any)
          : null,
      }));
      res.json({ success: true, data: { signals: entries } });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  // ============================================================
  // Sprint 43-C: Composite Rebalance admin endpoints
  // 让运维手动触发一次 composite 调仓 (dry_run 可选) 并审计 plan,
  // 不依赖 cron seed 默认配置. 出问题可一键 pause cron task.
  // ============================================================

  /**
   * POST /api/advanced-quant/composite-rebalance/run
   *
   * Body: {
   *   portfolio_id: number (必需),
   *   strategy_key: 'multi_factor_alpha' | 'ensemble_strategy' (必需),
   *   target_portfolio: string[] (必需 — 目标股票列表),
   *   trade_date?: string (默认今日),
   *   dry_run?: boolean (默认 true),
   *   persist?: boolean (默认 false)
   * }
   */
  async runCompositeRebalance(req: Request, res: Response) {
    try {
      const body = req.body || {};
      const portfolio_id = parseInt(body.portfolio_id, 10);
      const strategy_key = String(body.strategy_key || '').trim();
      const target_portfolio = Array.isArray(body.target_portfolio) ? body.target_portfolio : [];
      if (!Number.isFinite(portfolio_id) || portfolio_id <= 0) {
        return res.status(400).json({ success: false, message: '缺少有效 portfolio_id' });
      }
      if (!strategy_key) {
        return res.status(400).json({ success: false, message: '缺少 strategy_key' });
      }
      if (!target_portfolio.length) {
        return res.status(400).json({ success: false, message: '缺少 target_portfolio' });
      }
      // Batch H (2026-06-17, C12): owner gate — 之前 portfolio_id 直传, 任意 user
      // 可对任意 portfolio_id 跑 rebalance + 真下单. 现在限定 portfolio.user_id 必须
      // 等于 req.user.id (admin 可代他人执行).
      /* eslint-disable @typescript-eslint/no-var-requires */
      const { PaperTradingPortfolio } = require('../../models/PaperTradingPortfolio');
      /* eslint-enable @typescript-eslint/no-var-requires */
      const reqUser = (req as any).user;
      const ownerCheck = await PaperTradingPortfolio.findByPk(portfolio_id);
      if (!ownerCheck) {
        return res.status(404).json({ success: false, message: '未找到 portfolio' });
      }
      if (ownerCheck.user_id !== reqUser?.id && reqUser?.role !== 'admin') {
        logger.warn(
          `[composite-rebalance] user=${reqUser?.id} 尝试 rebalance portfolio=${portfolio_id} (owner=${ownerCheck.user_id}), 拒绝`
        );
        return res.status(403).json({ success: false, message: '无权对该 portfolio 执行 rebalance' });
      }
      const trade_date = body.trade_date || new Date().toISOString().slice(0, 10);
      const result = await compositeRebalanceService.rebalance({
        portfolio_id,
        strategy_key: strategy_key as any, // service 内部会校验 strategy_key 合法
        target_portfolio,
        trade_date,
        options: {
          dryRun: body.dry_run !== false, // 默认 true (admin 接口安全保守)
          persist: body.persist === true,
        } as any,
      });
      res.json({ success: true, data: result });
    } catch (err: any) {
      logger.error('[advanced-quant] runCompositeRebalance failed:', err);
      res.status(400).json({ success: false, message: err?.message });
    }
  }

  /**
   * POST /api/advanced-quant/composite-rebalance/pause
   *
   * Body: { paused: boolean }
   * 把 ScheduledTask WHERE type='COMPOSITE_REBALANCE' is_active 字段切换.
   * paused=true → 禁用所有 composite cron; paused=false → 重新启用.
   * 用作"一键回退" — 真下单出问题时立即停所有 cron.
   */
  async pauseCompositeRebalance(req: Request, res: Response) {
    try {
      // Batch H (2026-06-17, C12): pause 影响所有 cron, 必须 admin.
      const reqUser = (req as any).user;
      if (reqUser?.role !== 'admin') {
        return res
          .status(403)
          .json({ success: false, message: '仅 admin 可一键暂停 composite-rebalance cron' });
      }
      const body = req.body || {};
      const paused = body.paused === true;
      /* eslint-disable @typescript-eslint/no-var-requires */
      const { ScheduledTask } = require('../../models/ScheduledTask');
      /* eslint-enable @typescript-eslint/no-var-requires */
      const [affectedCount] = await ScheduledTask.update(
        { is_active: !paused },
        { where: { type: 'COMPOSITE_REBALANCE' } }
      );
      logger.info(
        `[composite-rebalance] ${paused ? 'PAUSED' : 'RESUMED'} ${affectedCount} cron task(s)`
      );
      res.json({
        success: true,
        data: {
          paused,
          affected_count: affectedCount,
          message: paused
            ? `已暂停 ${affectedCount} 个 COMPOSITE_REBALANCE cron 任务`
            : `已启用 ${affectedCount} 个 COMPOSITE_REBALANCE cron 任务`,
        },
      });
    } catch (err: any) {
      logger.error('[advanced-quant] pauseCompositeRebalance failed:', err);
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  /**
   * GET /api/advanced-quant/composite-rebalance/status
   *
   * 查看当前 composite cron 状态 (active / paused) + 上次执行时间.
   */
  async getCompositeRebalanceStatus(_req: Request, res: Response) {
    try {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const { ScheduledTask } = require('../../models/ScheduledTask');
      const { ScheduledTaskExecutionLog } = require('../../models/ScheduledTaskExecutionLog');
      /* eslint-enable @typescript-eslint/no-var-requires */
      const tasks = await ScheduledTask.findAll({
        where: { type: 'COMPOSITE_REBALANCE' },
        attributes: ['id', 'name', 'cron_expression', 'is_active', 'parameters', 'updated_at'],
        raw: true,
      });
      const lastLog = await ScheduledTaskExecutionLog.findOne({
        where: { task_type: 'COMPOSITE_REBALANCE' },
        order: [['created_at', 'DESC']],
        attributes: ['created_at', 'success_count', 'failed_count', 'result_summary'],
        raw: true,
      });
      res.json({
        success: true,
        data: {
          tasks,
          last_execution: lastLog,
        },
      });
    } catch (err: any) {
      logger.error('[advanced-quant] getCompositeRebalanceStatus failed:', err);
      res.status(500).json({ success: false, message: err?.message });
    }
  }

  /**
   * Sprint 44-C: GET /api/advanced-quant/tca/strategies
   *
   * 列出 strategy_tca_multipliers 表的最近一次报告 per-strategy.
   * 给 dashboard 显示 "哪些策略实盘成本高被降权".
   *
   * Query: { limit?: number (默认 50) }
   */
  async listTcaStrategies(req: Request, res: Response) {
    try {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const { StrategyTcaMultiplier } = require('../../models/StrategyTcaMultiplier');
      const { QueryTypes } = require('sequelize');
      const sequelize = require('../../config/database').default;
      /* eslint-enable @typescript-eslint/no-var-requires */
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10), 1), 500);
      // 取每个 strategy_key 的最新 report_date 一条
      const rows = await sequelize.query(
        `SELECT t.* FROM strategy_tca_multipliers t
         INNER JOIN (
           SELECT strategy_key, MAX(report_date) AS max_date
           FROM strategy_tca_multipliers
           GROUP BY strategy_key
         ) latest
         ON t.strategy_key = latest.strategy_key AND t.report_date = latest.max_date
         ORDER BY t.recommended_weight_multiplier ASC, t.strategy_key ASC
         LIMIT :limit`,
        {
          replacements: { limit },
          type: QueryTypes.SELECT,
        }
      );
      res.json({ success: true, data: rows });
    } catch (err: any) {
      logger.error('[advanced-quant] listTcaStrategies failed:', err);
      res.status(500).json({ success: false, message: err?.message });
    }
  }
}

export const advancedQuantController = new AdvancedQuantController();
