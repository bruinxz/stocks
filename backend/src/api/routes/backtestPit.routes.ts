import { Router } from 'express';
import { param, query } from 'express-validator';
import { BacktestPitController } from '../controllers/BacktestPitController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const controller = new BacktestPitController();
const authController = new AuthController();

const STRATEGIES = ['us_preferred', 'multibagger', 'japan_blue_chip', 'korea_semiconductor_chain', 'japan_multibagger', 'korea_multibagger'];

router.get(
  '/:strategy',
  authController.authenticate,
  param('strategy').isIn(STRATEGIES)
    .withMessage(`strategy must be one of: ${STRATEGIES.join(', ')}`),
  query('from').optional().isISO8601({ strict: true }).withMessage('from must be YYYY-MM-DD'),
  query('to').optional().isISO8601({ strict: true }).withMessage('to must be YYYY-MM-DD'),
  query('limit').optional().isInt({ min: 1, max: 365 }).toInt().withMessage('limit must be 1-365'),
  validateRequest,
  controller.listSnapshots
);

router.get(
  '/:strategy/:as_of',
  authController.authenticate,
  param('strategy').isIn(STRATEGIES)
    .withMessage(`strategy must be one of: ${STRATEGIES.join(', ')}`),
  param('as_of').isISO8601({ strict: true }).withMessage('as_of must be YYYY-MM-DD'),
  validateRequest,
  controller.getSnapshot
);

router.get(
  '/:strategy/:as_of/holdings',
  authController.authenticate,
  param('strategy').isIn(STRATEGIES)
    .withMessage(`strategy must be one of: ${STRATEGIES.join(', ')}`),
  param('as_of').isISO8601({ strict: true }).withMessage('as_of must be YYYY-MM-DD'),
  validateRequest,
  controller.getHoldings
);

export default router;
