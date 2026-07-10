import { Router } from 'express';
import { param } from 'express-validator';
import { CatalystController } from '../controllers/CatalystController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const controller = new CatalystController();
const authController = new AuthController();

router.get(
  '/:id',
  authController.authenticate,
  param('id').isUUID(4).withMessage('id must be UUIDv4'),
  validateRequest,
  controller.getById
);

router.get(
  '/:id/candidates',
  authController.authenticate,
  param('id').isUUID(4).withMessage('id must be UUIDv4'),
  validateRequest,
  controller.getCandidates
);

export default router;
