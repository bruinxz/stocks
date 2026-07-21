import { Router } from 'express';
import { param } from 'express-validator';
import { UsTechMarketController } from '../controllers/UsTechMarketController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const controller = new UsTechMarketController();
const authController = new AuthController();

router.get(
  '/:date',
  authController.authenticate,
  param('date').isISO8601({ strict: true }).withMessage('date must be YYYY-MM-DD'),
  validateRequest,
  controller.getByDate
);

export default router;
