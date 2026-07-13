import { Router } from 'express';
import { param, query } from 'express-validator';
import { RecommendationSnapshotController } from '../controllers/RecommendationSnapshotController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';
import {
  RECOMMENDATION_MARKET_SCOPES,
  RECOMMENDATION_PROFILES,
  RecommendationSnapshotReadPort,
  isRecommendationScopeCompatible,
  type RecommendationMarketScope,
  type RecommendationProfile,
  unavailableRecommendationSnapshotReadPort,
} from '../../recommendations/RecommendationSnapshotReadPort';

const authController = new AuthController();

const profileValidation = query('profile')
  .exists({ checkFalsy: true })
  .withMessage('profile is required')
  .bail()
  .isString()
  .isIn(RECOMMENDATION_PROFILES)
  .withMessage(`profile must be one of: ${RECOMMENDATION_PROFILES.join(', ')}`);

const marketScopeValidation = query('market_scope')
  .exists({ checkFalsy: true })
  .withMessage('market_scope is required')
  .bail()
  .isString()
  .isIn(RECOMMENDATION_MARKET_SCOPES)
  .withMessage(`market_scope must be one of: ${RECOMMENDATION_MARKET_SCOPES.join(', ')}`)
  .bail()
  .custom((scope, { req }) => {
    const profile = String(req.query?.profile) as RecommendationProfile;
    if (
      RECOMMENDATION_PROFILES.includes(profile) &&
      !isRecommendationScopeCompatible(profile, String(scope) as RecommendationMarketScope)
    ) {
      throw new Error('market_scope is incompatible with profile');
    }
    return true;
  });

export function buildRecommendationSnapshotRoutes(
  readPort: RecommendationSnapshotReadPort = unavailableRecommendationSnapshotReadPort
): Router {
  const router = Router();
  const controller = new RecommendationSnapshotController(readPort);

  router.get(
    '/latest',
    authController.authenticate,
    profileValidation,
    marketScopeValidation,
    validateRequest,
    controller.getLatest
  );

  router.get(
    '/by-date/:date',
    authController.authenticate,
    param('date')
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage('date must be YYYY-MM-DD')
      .bail()
      .isISO8601({ strict: true })
      .withMessage('date must be YYYY-MM-DD'),
    profileValidation,
    marketScopeValidation,
    query('page').optional().isInt({ min: 1 }).toInt().withMessage('page must be >= 1'),
    query('page_size')
      .optional()
      .isInt({ min: 1, max: 100 })
      .toInt()
      .withMessage('page_size must be 1-100'),
    validateRequest,
    (req, res, next) => {
      if (req.query.page == null) req.query.page = '1';
      if (req.query.page_size == null) req.query.page_size = '20';
      Promise.resolve(controller.getByDate(req, res)).catch(next);
    }
  );

  router.get(
    '/:snapshot_id/diff/:other_snapshot_id',
    authController.authenticate,
    param('snapshot_id').isUUID(4).withMessage('snapshot_id must be a UUIDv4'),
    param('other_snapshot_id').isUUID(4).withMessage('other_snapshot_id must be a UUIDv4'),
    validateRequest,
    (req, res, next) => {
      req.query.base_snapshot_id = req.params.snapshot_id;
      req.query.target_snapshot_id = req.params.other_snapshot_id;
      Promise.resolve(controller.getDiff(req, res)).catch(next);
    }
  );

  router.get(
    '/:snapshot_id',
    authController.authenticate,
    param('snapshot_id').isUUID(4).withMessage('snapshot_id must be a UUIDv4'),
    validateRequest,
    controller.getDetail
  );

  return router;
}

export default buildRecommendationSnapshotRoutes();
