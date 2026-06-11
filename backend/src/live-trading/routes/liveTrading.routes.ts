import { Router } from 'express';
import { AuthController } from '../../api/controllers/AuthController';
import { requireRole } from '../../middlewares/auth';
import { liveTradingController } from '../controllers/LiveTradingController';
import { LIVE_TRADING_RATE_LIMITS } from '../middlewares/liveTradingRateLimit';

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

// 写接口加 rate limit（灰度阶段；阈值见 liveTradingRateLimit.ts）
router.post(
  '/order-drafts',
  LIVE_TRADING_RATE_LIMITS.createDraft1m,
  liveTradingController.createDraft.bind(liveTradingController)
);
router.post(
  '/order-drafts/from-candidate',
  LIVE_TRADING_RATE_LIMITS.createDraft1m,
  liveTradingController.createDraftFromCandidate.bind(liveTradingController)
);
router.post(
  '/order-drafts/shadow-autopilot',
  LIVE_TRADING_RATE_LIMITS.runShadowAutopilot1m,
  liveTradingController.runShadowAutopilot.bind(liveTradingController)
);
router.post(
  '/order-drafts/:id/shadow-execute',
  LIVE_TRADING_RATE_LIMITS.createDraft1m,
  liveTradingController.runDraftShadowExecution.bind(liveTradingController)
);
router.post(
  '/order-drafts/:id/approve',
  // 双层限流：1 分钟尖峰 + 1 小时累计；都过才放行真实下单
  LIVE_TRADING_RATE_LIMITS.approveDraft1m,
  LIVE_TRADING_RATE_LIMITS.approveDraft1h,
  liveTradingController.approveDraft.bind(liveTradingController)
);
router.post(
  '/order-drafts/:id/reject',
  liveTradingController.rejectDraft.bind(liveTradingController)
);
router.post(
  '/accounts/sync-readonly',
  LIVE_TRADING_RATE_LIMITS.syncReadonly1m,
  liveTradingController.syncReadonly.bind(liveTradingController)
);
router.get('/audit-logs', liveTradingController.getAuditLogs.bind(liveTradingController));

// 服务端 kill switch：查询 / 手动触发 / 人工解除
// review P1：触发/解除是进程全局影响（一个用户能熔断/恢复所有人的下单），
// 必须收敛到 admin；普通用户仍可 GET 查询当前状态用于风控展示
router.get('/kill-switch', liveTradingController.getKillSwitch.bind(liveTradingController));
router.post(
  '/kill-switch/trigger',
  requireRole('admin'),
  LIVE_TRADING_RATE_LIMITS.killSwitchTrigger1m,
  liveTradingController.triggerKillSwitch.bind(liveTradingController)
);
router.post(
  '/kill-switch/resolve',
  requireRole('admin'),
  LIVE_TRADING_RATE_LIMITS.killSwitchResolve1m,
  liveTradingController.resolveKillSwitch.bind(liveTradingController)
);

// 用户撤单：服务端不直连券商，写一条 cancel_order command 等 bridge 拉取
router.post(
  '/orders/:id/cancel',
  LIVE_TRADING_RATE_LIMITS.cancelOrder1m,
  liveTradingController.cancelOrder.bind(liveTradingController)
);
// 实盘委托列表（前端撤单 UI 使用）
router.get('/orders', liveTradingController.listLiveOrders.bind(liveTradingController));

export default router;
