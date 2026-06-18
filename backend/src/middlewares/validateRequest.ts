import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import { logger } from '../utils/logger';

// Batch Z (2026-06-17, m-5 fix): 敏感字段白名单, 写日志前替换为 '<redacted>'.
// 之前 logger.warn(req.body) 把 password / token / secret 全文落 combined.log,
// 配合 log.routes 历史无 admin gate (Batch U 修了) 是密码泄露漏洞.
const SENSITIVE_KEYS = new Set([
  'password',
  'newpassword',
  'oldpassword',
  'old_password',
  'new_password',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'api_key',
  'apikey',
  'webhook_url', // 可能含 token query
  'authorization',
]);

function redactSensitive(obj: any, depth = 0): any {
  if (depth > 5) return '<truncated>';
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => redactSensitive(v, depth + 1));
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '<redacted>';
    } else {
      out[k] = redactSensitive(v, depth + 1);
    }
  }
  return out;
}

export const validateRequest = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Batch Z: errorDetails 里 value 可能也含敏感字段 (字段名 = password 时 value = 明文)
    const errorDetails = errors.array().map(e => ({
      param: e.param || 'unknown',
      msg: e.msg,
      value: SENSITIVE_KEYS.has(String(e.param || '').toLowerCase()) ? '<redacted>' : e.value,
    }));
    logger.warn(`请求验证失败: ${JSON.stringify(errorDetails)}`);
    // Batch Z (m-5 fix): body 写日志前递归 redact 敏感字段.
    logger.warn(`请求body: ${JSON.stringify(redactSensitive(req.body))}`);
    return res.status(400).json({
      success: false,
      message: '请求参数验证失败',
      errors: errors.array(),
    });
  }
  next();
};
