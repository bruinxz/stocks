import { Router } from 'express';
import { param, query } from 'express-validator';
import { AuthController } from '../controllers/AuthController';
import { DailyReportProjectionController } from '../controllers/DailyReportProjectionController';
import { validateRequest } from '../../middlewares/validateRequest';
import {
  RECOMMENDATION_MARKET_SCOPES,
  RECOMMENDATION_PROFILES,
  isRecommendationScopeCompatible,
  type RecommendationMarketScope,
  type RecommendationProfile,
} from '../../recommendations/RecommendationSnapshotReadPort';
import { DailyReportProjectionPort } from '../../projections/DailyReportProjectionService';

const authController = new AuthController();

const requiredProfile = query('profile')
  .exists({ checkFalsy: true })
  .withMessage('profile is required')
  .bail()
  .isString()
  .isIn(RECOMMENDATION_PROFILES)
  .withMessage(`profile must be one of: ${RECOMMENDATION_PROFILES.join(', ')}`);

const optionalProfile = query('profile')
  .optional()
  .isString()
  .isIn(RECOMMENDATION_PROFILES)
  .withMessage(`profile must be one of: ${RECOMMENDATION_PROFILES.join(', ')}`);

const requiredMarketScope = query('market_scope')
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

const optionalMarketScope = query('market_scope')
  .optional()
  .isString()
  .isIn(RECOMMENDATION_MARKET_SCOPES)
  .withMessage(`market_scope must be one of: ${RECOMMENDATION_MARKET_SCOPES.join(', ')}`)
  .bail()
  .custom((scope, { req }) => {
    const profile = req.query?.profile;
    if (
      profile !== undefined &&
      RECOMMENDATION_PROFILES.includes(String(profile) as RecommendationProfile) &&
      !isRecommendationScopeCompatible(
        String(profile) as RecommendationProfile,
        String(scope) as RecommendationMarketScope
      )
    ) {
      throw new Error('market_scope is incompatible with profile');
    }
    return true;
  });

export function buildDailyReportProjectionRoutes(projections: DailyReportProjectionPort): Router {
  const router = Router();
  const controller = new DailyReportProjectionController(projections);

  router.get(
    '/latest',
    authController.authenticate,
    requiredProfile,
    requiredMarketScope,
    validateRequest,
    controller.getLatest
  );

  router.get(
    '/history',
    authController.authenticate,
    optionalProfile,
    optionalMarketScope,
    query('query').optional().isString().isLength({ max: 200 }).withMessage('query is too long'),
    query('from_day')
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage('from_day must be YYYY-MM-DD')
      .bail()
      .isISO8601({ strict: true })
      .withMessage('from_day must be YYYY-MM-DD'),
    query('to_day')
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage('to_day must be YYYY-MM-DD')
      .bail()
      .isISO8601({ strict: true })
      .withMessage('to_day must be YYYY-MM-DD')
      .bail()
      .custom((toDay, { req }) => {
        const fromDay = req.query?.from_day;
        if (fromDay !== undefined && String(fromDay) > String(toDay)) {
          throw new Error('from_day must be <= to_day');
        }
        return true;
      }),
    validateRequest,
    controller.getHistory
  );

  router.get(
    '/:date',
    authController.authenticate,
    param('date')
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage('date must be YYYY-MM-DD')
      .bail()
      .isISO8601({ strict: true })
      .withMessage('date must be YYYY-MM-DD'),
    requiredProfile,
    requiredMarketScope,
    validateRequest,
    controller.getByDate
  );

  return router;
}

export default buildDailyReportProjectionRoutes;
