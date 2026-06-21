/**
 * uploadFeedback middleware — Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环.
 *
 * multer disk storage 把图片落到 `<uploadsRoot>/feedback/<userId>/<ts>-<rand><ext>`.
 * destination 函数从 req.user.id 取目录 (要求 route 已挂 authController.authenticate).
 *
 * 参数:
 *   - 单文件 ≤ 5 MB; 最多 9 张; 仅 JPEG / PNG / GIF / WEBP
 *   - field name = 'images' (前端 antd Upload `name="images"` + multiple)
 */

import multer from 'multer';
import path from 'path';
import fs from 'fs';
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
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
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

export const uploadFeedbackImagesMiddleware = multer({
  storage: feedbackStorage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB / 张
    files: 9, // 一次最多 9 张
  },
  fileFilter: feedbackFileFilter,
});
