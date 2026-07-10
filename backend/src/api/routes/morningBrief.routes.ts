import { Router } from 'express';
import { param } from 'express-validator';
import { MorningBriefController } from '../controllers/MorningBriefController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const controller = new MorningBriefController();
const authController = new AuthController();

router.get(
  '/:date',
  authController.authenticate,
  param('date').isISO8601({ strict: true }).withMessage('date must be YYYY-MM-DD'),
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
