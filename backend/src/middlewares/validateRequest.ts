import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import { logger } from '../utils/logger';

export const validateRequest = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorDetails = errors
      .array()
      .map(e => ({ param: e.param || 'unknown', msg: e.msg, value: e.value }));
    logger.warn(`请求验证失败: ${JSON.stringify(errorDetails)}`);
    logger.warn(`请求body: ${JSON.stringify(req.body)}`);
    return res.status(400).json({
      success: false,
      message: '请求参数验证失败',
      errors: errors.array(),
    });
  }
  next();
};
