import { Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { todayController } from '../controllers/TodayController';
import { v3RecommendationController } from '../controllers/V3RecommendationController';

const router = Router();
const authController = new AuthController();

router.get(
  '/command-center',
  authController.authenticate,
  todayController.getCommandCenter.bind(todayController)
);
router.get(
  '/opening-readiness',
  authController.authenticate,
  todayController.getOpeningReadiness.bind(todayController)
);

// US-018 — Today Workspace 聚合接口
router.get(
  '/signals',
  authController.authenticate,
  todayController.getTodaySignals.bind(todayController)
);
router.post(
  '/apply-signals',
  authController.authenticate,
  todayController.applyTodaySignals.bind(todayController)
);

// US-040 — 今日大盘判断卡片 (regime + 仓位建议 + 昨夜外盘)
router.get(
  '/market-judgment',
  authController.authenticate,
  todayController.getMarketJudgment.bind(todayController)
);

// US-041 — 集合竞价异动卡片 (9:25 后展示一字/高开/低开)
router.get(
  '/call-auction',
  authController.authenticate,
  todayController.getCallAuctionAnomalies.bind(todayController)
);

// CA-1 — 抖音风 v3 推荐卡片 (4 维评分 + 漏斗 stats)
router.get(
  '/v3-recommendations',
  authController.authenticate,
  v3RecommendationController.getRecommendations.bind(v3RecommendationController)
);
router.get(
  '/v3-funnel',
  authController.authenticate,
  v3RecommendationController.getFunnelStats.bind(v3RecommendationController)
);

export default router;
