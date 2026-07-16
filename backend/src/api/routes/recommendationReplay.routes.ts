import { Router, type RequestHandler } from 'express';
import { body, query } from 'express-validator';
import { RecommendationReplayController } from '../controllers/RecommendationReplayController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';
import {
  REPLAY_MARKET_SCOPES,
  REPLAY_PROFILES,
  isCanonicalUuidV4,
  isReplayScopeCompatible,
  isTradingDay,
  type ReplayMarketScope,
  type ReplayProfile,
} from '../../replay/ReplayContract';
import type { RecommendationReplayPort } from '../controllers/RecommendationReplayController';
import type { ReplayPinsReadPort } from '../../replay/ReplayPinsReadPort';
import type { AuthenticatedRequest } from '../../middlewares/auth';
import {
  PerUserReplayRateLimiter,
  replayOperationalLimits,
  validateReplayOperationalLimits,
  type ReplayOperationalLimits,
} from '../../replay/ReplayOperationalLimits';

export interface RecommendationReplayRouteOptions {
  operational_limits?: ReplayOperationalLimits;
  rate_clock?: () => number;
}

function perUserLimit(limiter: PerUserReplayRateLimiter): RequestHandler {
  return (req, res, next): void => {
    const userId = (req as AuthenticatedRequest).user?.id;
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const decision = limiter.consume(userId);
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retry_after_seconds));
      res.status(429).json({ error: 'Replay rate limit exceeded' });
      return;
    }
    next();
  };
}

function exactBodyFields(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2]
): void {
  if (
    !req.body ||
    typeof req.body !== 'object' ||
    Array.isArray(req.body) ||
    Object.keys(req.body).sort().join(',') !== 'market_scope,profile,trading_day'
  ) {
    res.status(400).json({ error: 'Replay request body must contain exact fields' });
    return;
  }
  next();
}

function exactStatusQuery(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2]
): void {
  if (Object.keys(req.query).sort().join(',') !== 'job_id') {
    res.status(400).json({ error: 'Replay status query must contain exact fields' });
    return;
  }
  next();
}

export function buildRecommendationReplayRoutes(
  pins: ReplayPinsReadPort,
  replay: RecommendationReplayPort,
  options: RecommendationReplayRouteOptions = {}
): Router {
  const router = Router();
  const controller = new RecommendationReplayController(pins, replay);
  const authenticate = new AuthController().authenticate;
  const limits = validateReplayOperationalLimits(
    options.operational_limits ?? replayOperationalLimits()
  );
  const submitLimit = perUserLimit(
    new PerUserReplayRateLimiter(
      limits.submit_rate_per_minute,
      limits.rate_max_users,
      options.rate_clock
    )
  );
  const statusLimit = perUserLimit(
    new PerUserReplayRateLimiter(
      limits.status_rate_per_minute,
      limits.rate_max_users,
      options.rate_clock
    )
  );

  /**
   * @openapi
   * /api/v1/ai/recommendations/replay:
   *   post:
   *     tags: [AI 分析]
   *     operationId: submitRecommendationReplay
   *     summary: 提交并短暂等待推荐重放任务
   *     description: |
   *       使用交易日、profile 与 market_scope 解析唯一的已持久化 typed-source capture，
   *       再向 durable replay runtime 幂等提交任务。HTTP 连接仅短暂等待；任务仍在排队或
   *       运行时返回 202，终态 completed/failed 返回 200。完整版本、时间与 hash pins
   *       由服务端解析，客户端不得在请求体中提交或覆盖。
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema: { $ref: '#/components/schemas/ReplaySubmitRequest' }
   *     responses:
   *       200:
   *         description: 重放任务已到达 completed 或 failed 终态
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayTerminalJob' }
   *       202:
   *         description: 重放任务已持久化，当前为 queued 或 running
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayPendingJob' }
   *       400:
   *         description: 请求体字段不精确、日期/profile/scope 非法或 profile 与 scope 不兼容
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayBadRequestResponse' }
   *       401:
   *         description: Bearer token 缺失、无效、用户不存在或已停用
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayUnauthorizedResponse' }
   *       404:
   *         description: 对应 typed-source capture 或 replay job 不存在
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   *       409:
   *         description: typed-source capture 不唯一或 replay job 冲突
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   *       413:
   *         description: replay CLI 请求超过输入上限
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   *       429:
   *         description: 当前认证用户的 replay submit 速率超过严格上限
   *         headers:
   *           Retry-After:
   *             schema: { type: integer, minimum: 1, maximum: 60 }
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   *       422:
   *         description: 服务端解析出的完整 replay pins 不满足严格契约
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   *       500:
   *         description: 未分类的内部处理失败
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   *       502:
   *         description: replay CLI 返回超限、畸形或未识别的拒绝响应
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   *       503:
   *         description: 鉴权、capture store、replay runtime 或 replay store 暂不可用
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayUnavailableResponse' }
   *       504:
   *         description: replay CLI 控制操作超时
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   */
  router.post(
    '/replay',
    authenticate,
    submitLimit,
    exactBodyFields,
    body('trading_day')
      .custom(isTradingDay)
      .withMessage('trading_day must be a valid YYYY-MM-DD date'),
    body('profile')
      .isString()
      .isIn(REPLAY_PROFILES)
      .withMessage(`profile must be one of: ${REPLAY_PROFILES.join(', ')}`),
    body('market_scope')
      .isString()
      .isIn(REPLAY_MARKET_SCOPES)
      .withMessage(`market_scope must be one of: ${REPLAY_MARKET_SCOPES.join(', ')}`)
      .bail()
      .custom((marketScope, { req }) => {
        const profile = req.body?.profile as ReplayProfile;
        if (
          REPLAY_PROFILES.includes(profile) &&
          !isReplayScopeCompatible(profile, String(marketScope) as ReplayMarketScope)
        ) {
          throw new Error('market_scope is incompatible with profile');
        }
        return true;
      }),
    validateRequest,
    controller.submit
  );

  /**
   * @openapi
   * /api/v1/ai/recommendations/status:
   *   get:
   *     tags: [AI 分析]
   *     operationId: getRecommendationReplayStatus
   *     summary: 查询 durable 推荐重放任务状态
   *     description: |
   *       按 canonical lowercase UUIDv4 查询持久化任务。该接口可跨 Backend/CLI 进程重启
   *       恢复 queued、running、completed 或 failed 状态；不会创建新的 replay job，但对
   *       非终态任务会在全局容量允许时调度 lease-aware run_one，以恢复中断的 worker。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: job_id
   *         required: true
   *         description: canonical lowercase UUIDv4 replay job id
   *         schema:
   *           type: string
   *           format: uuid
   *           pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   *     responses:
   *       200:
   *         description: 当前持久化 job 状态
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayJob' }
   *       400:
   *         description: query 字段不精确或 job_id 不是 canonical lowercase UUIDv4
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayBadRequestResponse' }
   *       401:
   *         description: Bearer token 缺失、无效、用户不存在或已停用
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayUnauthorizedResponse' }
   *       404:
   *         description: replay job 不存在
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   *       409:
   *         description: replay job 状态冲突
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   *       413:
   *         description: replay CLI 状态请求超过输入上限
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   *       429:
   *         description: 当前认证用户的 replay status 速率超过严格上限
   *         headers:
   *           Retry-After:
   *             schema: { type: integer, minimum: 1, maximum: 60 }
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   *       500:
   *         description: 未分类的内部处理失败
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   *       502:
   *         description: replay CLI 返回超限、畸形或未识别的拒绝响应
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   *       503:
   *         description: 鉴权、replay runtime 或 replay store 暂不可用
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayUnavailableResponse' }
   *       504:
   *         description: replay CLI 状态查询超时
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/ReplayErrorResponse' }
   */
  router.get(
    '/status',
    authenticate,
    statusLimit,
    exactStatusQuery,
    query('job_id').custom(isCanonicalUuidV4).withMessage('job_id must be a canonical UUIDv4'),
    validateRequest,
    controller.status
  );

  return router;
}
