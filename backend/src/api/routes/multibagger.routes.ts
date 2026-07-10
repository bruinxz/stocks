import { Router } from 'express';
import { param, query } from 'express-validator';
import { MultibaggerController } from '../controllers/MultibaggerController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const controller = new MultibaggerController();
const authController = new AuthController();

const STAGES = ['seed', 'early', 'growth', 'break_below', 'deep'];
const CONCLUSIONS = ['MULTIBAGGER_2X', 'MULTIBAGGER_5X', 'MULTIBAGGER_10X', 'SKIP'];
const MARKETS = ['A', 'US', 'JP', 'KR'];

router.get(
  '/candidates',
  authController.authenticate,
  query('stage').optional().isString().withMessage('stage must be a comma-separated string'),
  query('conclusion').optional().isString().withMessage('conclusion must be a comma-separated string'),
  query('market').optional().isIn(MARKETS).withMessage(`market must be one of: ${MARKETS.join(', ')}`),
  validateRequest,
  controller.getCandidates
);

router.get(
  '/:symbol/detail',
  authController.authenticate,
  param('symbol').isString().notEmpty().withMessage('symbol is required'),
  validateRequest,
  controller.getDetail
);

export default router;
