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

export default router;
