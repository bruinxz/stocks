import { Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { researchTradingLoopController } from '../controllers/ResearchTradingLoopController';

const router = Router();
const authController = new AuthController();

router.get('/dashboard', authController.authenticate, researchTradingLoopController.getDashboard);
router.post('/run', authController.authenticate, researchTradingLoopController.runNow);

export default router;
