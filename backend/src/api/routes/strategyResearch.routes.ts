import { Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { strategyResearchController } from '../controllers/StrategyResearchController';

const router = Router();
const authController = new AuthController();

router.get(
  '/center',
  authController.authenticate,
  strategyResearchController.getCenter.bind(strategyResearchController)
);
router.get(
  '/opening-preflight',
  authController.authenticate,
  strategyResearchController.getOpeningPreflight.bind(strategyResearchController)
);

export default router;
