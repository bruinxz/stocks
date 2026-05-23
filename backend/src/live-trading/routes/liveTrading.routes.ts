import { Router } from 'express';
import { AuthController } from '../../api/controllers/AuthController';
import { liveTradingController } from '../controllers/LiveTradingController';

const router = Router();
const authController = new AuthController();

router.use(authController.authenticate);

router.get('/readiness', liveTradingController.getReadiness.bind(liveTradingController));
router.get('/safety', liveTradingController.getSafety.bind(liveTradingController));
router.get('/overview', liveTradingController.getOverview.bind(liveTradingController));
router.get('/reconciliation', liveTradingController.getReconciliation.bind(liveTradingController));
router.get('/quotes', liveTradingController.getQuotes.bind(liveTradingController));
router.get('/order-drafts', liveTradingController.listDrafts.bind(liveTradingController));
router.get('/order-draft-candidates', liveTradingController.getDraftCandidates.bind(liveTradingController));
router.get('/shadow-outcomes', liveTradingController.getShadowOutcomes.bind(liveTradingController));
router.get('/shadow-trend', liveTradingController.getShadowTrend.bind(liveTradingController));
router.get('/shadow-budget-attribution', liveTradingController.getShadowBudgetAttribution.bind(liveTradingController));
router.post('/order-drafts', liveTradingController.createDraft.bind(liveTradingController));
router.post('/order-drafts/from-candidate', liveTradingController.createDraftFromCandidate.bind(liveTradingController));
router.post('/order-drafts/shadow-autopilot', liveTradingController.runShadowAutopilot.bind(liveTradingController));
router.post('/order-drafts/:id/shadow-execute', liveTradingController.runDraftShadowExecution.bind(liveTradingController));
router.post('/order-drafts/:id/approve', liveTradingController.approveDraft.bind(liveTradingController));
router.post('/order-drafts/:id/reject', liveTradingController.rejectDraft.bind(liveTradingController));
router.post('/accounts/sync-readonly', liveTradingController.syncReadonly.bind(liveTradingController));
router.get('/audit-logs', liveTradingController.getAuditLogs.bind(liveTradingController));

export default router;
