/**
 * uploadFeedback middleware — Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环.
 *
 * multer disk storage 把图片落到 `<uploadsRoot>/feedback/<userId>/<ts>-<rand><ext>`.
 * destination 函数从 req.user.id 取目录 (要求 route 已挂 authController.authenticate).
 *
 * 参数 (Batch AR 2026-06-21 收紧):
 *   - 单文件 ≤ 1.5 MB; 最多 3 张; 仅 JPEG / PNG / GIF / WEBP
 *   - 之前是 9 × 5 MB = 45 MB, 远超 nginx client_max_body_size 5m, 99% 触 413.
 *     现在 3 × 1.5 MB + multipart overhead < 5 MB, 在 nginx 限制内.
 *   - field name = 'images' (前端 antd Upload `name="images"` + multiple)
 *
 * 错误处理:
 *   - multer 抛 LIMIT_FILE_SIZE / LIMIT_FILE_COUNT → globalErrorHandler 兜底,
 *     但 UserFeedbackController 的 createMyFeedback 现在用 wrapMulter, 把错误码翻成 400 + 中文.
 */

import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { ensureUploadsRuntime, getUploadsRoot } from '../utils/runtimePaths';

ensureUploadsRuntime();
const uploadsRoot = getUploadsRoot();

const feedbackStorage = multer.diskStorage({
  destination: function (req, _file, cb) {
    const user = (req as any).user;
    const userId = user && user.id ? String(user.id) : 'anon';
    const dir = path.join(uploadsRoot, 'feedback', userId);
    try {
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (err: any) {
      cb(err, dir);
    }
  },
  filename: function (_req, file, cb) {
    const ext = path.extname(file.originalname || '') || '.bin';
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    cb(null, unique);
  },
});

const feedbackFileFilter: multer.Options['fileFilter'] = (
  _req,
  file,
  cb: multer.FileFilterCallback
) => {
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('只允许上传 JPEG / PNG / GIF / WEBP 图片'));
  }
};

export const FEEDBACK_MAX_FILE_BYTES = 1.5 * 1024 * 1024;
export const FEEDBACK_MAX_FILE_COUNT = 3;

export const uploadFeedbackImagesMiddleware = multer({
  storage: feedbackStorage,
  limits: {
    fileSize: FEEDBACK_MAX_FILE_BYTES, // 1.5 MB / 张
    files: FEEDBACK_MAX_FILE_COUNT, // 一次最多 3 张
  },
  fileFilter: feedbackFileFilter,
});

/**
 * Express handler that wraps the multer middleware so that LIMIT_FILE_SIZE /
 * LIMIT_FILE_COUNT errors translate to 400 with a Chinese message rather than
 * bubbling up as a 500 (or, in the nginx case, silent 413). Use this in routes
 * instead of mounting uploadFeedbackImagesMiddleware.array(...) directly.
 */
export function uploadFeedbackImages(field: string) {
  const inner = uploadFeedbackImagesMiddleware.array(field, FEEDBACK_MAX_FILE_COUNT);
  return (req: any, res: any, next: any) => {
    inner(req, res, (err: any) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res
            .status(400)
            .json({ message: `单张图片不能超过 ${FEEDBACK_MAX_FILE_BYTES / 1024 / 1024} MB` });
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ message: `最多上传 ${FEEDBACK_MAX_FILE_COUNT} 张图片` });
        }
        return res.status(400).json({ message: `图片上传失败: ${err.message}` });
      }
      if (err && err.message) {
        return res.status(400).json({ message: err.message });
      }
      return next(err);
    });
  };
}
