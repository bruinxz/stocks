/**
 * Advanced Quant Routes — Sprint 1-3 五大新 service 的 HTTP 路由
 *
 * Mount: /api/advanced-quant
 */
import { Router } from 'express';
import { advancedQuantController } from '../controllers/AdvancedQuantController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

// === Research Integrity (Sprint 1A) ===
router.post('/research-integrity/audit', authController.authenticate, advancedQuantController.runResearchAudit);
router.get('/research-integrity/recent', authController.authenticate, advancedQuantController.listResearchAudits);
router.get(
  '/research-integrity/by-strategy/:strategy_key',
  authController.authenticate,
  advancedQuantController.listResearchAuditsByStrategy
);
router.get(
  '/research-integrity/by-backtest/:source/:backtest_id',
  authController.authenticate,
  advancedQuantController.getLatestResearchAuditForBacktest
);

// === Execution Feasibility (Sprint 1B) ===
router.post(
  '/execution-feasibility/check',
  authController.authenticate,
  advancedQuantController.checkExecutionFeasibility
);
router.post(
  '/execution-feasibility/batch',
  authController.authenticate,
  advancedQuantController.batchExecutionFeasibility
);
router.get(
  '/execution-feasibility/recent',
  authController.authenticate,
  advancedQuantController.listExecutionFeasibility
);

// === Meta-label (Sprint 2A) ===
router.post('/meta-label/decide', authController.authenticate, advancedQuantController.decideMetaLabel);
router.post('/meta-label/train', authController.authenticate, advancedQuantController.trainMetaLabel);
router.get('/meta-label/model', authController.authenticate, advancedQuantController.getMetaLabelModel);
router.get('/meta-label/recent', authController.authenticate, advancedQuantController.listMetaLabelDecisions);

// === Portfolio Construction (Sprint 2B) ===
router.post(
  '/portfolio-construction/construct',
  authController.authenticate,
  advancedQuantController.constructPortfolio
);
router.get(
  '/portfolio-construction/recent',
  authController.authenticate,
  advancedQuantController.listPortfolioConstructions
);

// === Equity Curve Governor (Sprint 3) ===
router.post('/governor/evaluate', authController.authenticate, advancedQuantController.evaluateGovernor);
router.post(
  '/governor/evaluate-all',
  authController.authenticate,
  advancedQuantController.evaluateGovernorAll
);
router.get(
  '/governor/multiplier/:portfolio_id',
  authController.authenticate,
  advancedQuantController.getGovernorMultiplier
);
router.get(
  '/governor/history/:portfolio_id',
  authController.authenticate,
  advancedQuantController.getGovernorHistory
);

// === v2-v5 Method Config (Prod 3) ===
router.get('/method-config', authController.authenticate, advancedQuantController.getMethodConfig);
router.post('/method-config', authController.authenticate, advancedQuantController.setMethodConfig);

// === Sprint 25: Attribution (Brinson + MCR + Crowding + Vol-Target) ===
router.post('/attribution/brinson', authController.authenticate, advancedQuantController.runBrinsonAttribution);
router.post('/attribution/mcr', authController.authenticate, advancedQuantController.runMcr);
router.post('/attribution/crowding', authController.authenticate, advancedQuantController.runCrowdingScore);
router.post('/attribution/vol-target', authController.authenticate, advancedQuantController.runVolTargeting);

// === Sprint 25: Strategy Health (Capacity + Alpha Decay) ===
router.post('/strategy-health/capacity', authController.authenticate, advancedQuantController.estimateCapacity);
router.post('/strategy-health/alpha-decay', authController.authenticate, advancedQuantController.monitorDecay);
router.get('/strategy-health/signal-half-lives', authController.authenticate, advancedQuantController.listSignalHalfLives);

export default router;
