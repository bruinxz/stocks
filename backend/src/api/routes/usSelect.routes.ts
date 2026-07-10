import { Router } from 'express';
import { param, query } from 'express-validator';
import { UsSelectController } from '../controllers/UsSelectController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const controller = new UsSelectController();
const authController = new AuthController();

router.get(
  '/:date',
  authController.authenticate,
  param('date').isISO8601({ strict: true }).withMessage('date must be YYYY-MM-DD'),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt().withMessage('limit must be 1-100'),
  validateRequest,
  controller.getByDate
);

router.get(
  '/:date/summary',
  authController.authenticate,
  param('date').isISO8601({ strict: true }).withMessage('date must be YYYY-MM-DD'),
  validateRequest,
  controller.getSummary
);

export default router;
