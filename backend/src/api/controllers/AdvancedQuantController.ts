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
}

export const advancedQuantController = new AdvancedQuantController();
