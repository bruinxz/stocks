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

export default router;
