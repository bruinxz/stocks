import { Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { todayController } from '../controllers/TodayController';

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

export default router;
