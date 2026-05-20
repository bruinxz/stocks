import multer from 'multer';
import path from 'path';
import { ensureUploadsRuntime, getAvatarUploadsDir } from '../utils/runtimePaths';

// 优先使用 shared/uploads 或显式 UPLOADS_ROOT，避免发布切换到只读 release 目录导致启动失败。
ensureUploadsRuntime();
const avatarUploadsDir = getAvatarUploadsDir();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, avatarUploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  },
});

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('只允许上传 JPEG, PNG, GIF 或 WEBP 格式的图片'));
  }
};

export const uploadAvatarMiddleware = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: fileFilter,
});
