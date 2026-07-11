import { Router } from 'express';
import { param, query } from 'express-validator';
import { BacktestPitController } from '../controllers/BacktestPitController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const controller = new BacktestPitController();
const authController = new AuthController();

const STRATEGIES = [
  'us_preferred',
  'multibagger',
  'japan_blue_chip',
  'korea_semiconductor_chain',
  'japan_multibagger',
  'korea_multibagger',
];
const MARKET_SCOPES = ['cn_a', 'us', 'jp', 'kr'];
const STRATEGY_SCOPES: Record<string, string[]> = {
  us_preferred: ['cn_a', 'us'],
  multibagger: ['cn_a', 'us'],
  japan_blue_chip: ['jp'],
  japan_multibagger: ['jp'],
  korea_semiconductor_chain: ['kr'],
  korea_multibagger: ['kr'],
};
const isPitTimestamp = (value: unknown): boolean =>
  typeof value === 'string' && value.includes('T') && /(Z|[+-]\d{2}:\d{2})$/.test(value);
const marketScopeValidation = query('market_scope')
  .exists({ checkFalsy: true })
  .withMessage('market_scope is required')
  .bail()
  .isString()
  .isIn(MARKET_SCOPES)
  .withMessage(`market_scope must be one of: ${MARKET_SCOPES.join(', ')}`)
  .bail()
  .custom((scope, { req }) => {
    if (!STRATEGY_SCOPES[String(req.params?.strategy)]?.includes(String(scope))) {
      throw new Error('market_scope is incompatible with strategy');
    }
    return true;
  });

router.get(
  '/:strategy',
  authController.authenticate,
  param('strategy')
    .isIn(STRATEGIES)
    .withMessage(`strategy must be one of: ${STRATEGIES.join(', ')}`),
  query('from').optional().isISO8601({ strict: true }).withMessage('from must be YYYY-MM-DD'),
  query('to').optional().isISO8601({ strict: true }).withMessage('to must be YYYY-MM-DD'),
  query('limit').optional().isInt({ min: 1, max: 365 }).toInt().withMessage('limit must be 1-365'),
  marketScopeValidation,
  validateRequest,
  controller.listSnapshots
);

router.get(
  '/:strategy/:as_of',
  authController.authenticate,
  param('strategy')
    .isIn(STRATEGIES)
    .withMessage(`strategy must be one of: ${STRATEGIES.join(', ')}`),
  param('as_of')
    .isISO8601({ strict: true, strictSeparator: true })
    .custom(isPitTimestamp)
    .withMessage('as_of must be a timezone-bearing ISO 8601 timestamp'),
  marketScopeValidation,
  validateRequest,
  controller.getSnapshot
);

router.get(
  '/:strategy/:as_of/holdings',
  authController.authenticate,
  param('strategy')
    .isIn(STRATEGIES)
    .withMessage(`strategy must be one of: ${STRATEGIES.join(', ')}`),
  param('as_of')
    .isISO8601({ strict: true, strictSeparator: true })
    .custom(isPitTimestamp)
    .withMessage('as_of must be a timezone-bearing ISO 8601 timestamp'),
  marketScopeValidation,
  validateRequest,
  controller.getHoldings
);

export default router;
