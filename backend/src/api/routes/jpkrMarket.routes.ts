import { Router } from 'express';
import { param, query } from 'express-validator';
import { JpKrMarketController } from '../controllers/JpKrMarketController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const controller = new JpKrMarketController();
const authController = new AuthController();

router.get(
  '/:date',
  authController.authenticate,
  param('date').isISO8601({ strict: true }).withMessage('date must be YYYY-MM-DD'),
  query('market').isIn(['JP', 'KR']).withMessage('market must be JP or KR'),
  validateRequest,
  controller.getByDate
);

router.get(
  '/:symbol/detail',
  authController.authenticate,
  param('symbol').isString().notEmpty().withMessage('symbol is required'),
  query('date').isISO8601({ strict: true }).withMessage('date must be YYYY-MM-DD'),
  validateRequest,
  controller.getDetail
);

export default router;
