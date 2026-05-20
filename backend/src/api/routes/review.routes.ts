import { Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { reviewController } from '../controllers/ReviewController';

const router = Router();
const authController = new AuthController();

router.get(
  '/performance-center',
  authController.authenticate,
  reviewController.getPerformanceCenter.bind(reviewController)
);

export default router;
