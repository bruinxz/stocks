import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger';

type ResolvedRuntimePath = {
  root: string;
  source: string;
};

let cachedUploadsRoot: ResolvedRuntimePath | null = null;

function ensureWritableDirectory(directory: string): boolean {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function discoverSharedUploadsRoot(): string | null {
  let current = path.resolve(process.cwd());
  for (let depth = 0; depth < 6; depth++) {
    const sharedDir = path.join(current, 'shared');
    if (fs.existsSync(sharedDir) && fs.statSync(sharedDir).isDirectory()) {
      return path.join(sharedDir, 'uploads');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function buildUploadsCandidates() {
  const explicit = process.env.UPLOADS_ROOT ? path.resolve(process.env.UPLOADS_ROOT) : null;
  const shared = discoverSharedUploadsRoot();
  const cwdUploads = path.resolve(process.cwd(), 'uploads');
  const legacyUploads = path.resolve(__dirname, '../../uploads');
  const tempUploads = path.join(os.tmpdir(), 'stocks-runtime', 'uploads');

  return [
    explicit ? { root: explicit, source: 'env.UPLOADS_ROOT' } : null,
    shared ? { root: shared, source: 'shared/uploads' } : null,
    { root: cwdUploads, source: 'cwd/uploads' },
    { root: legacyUploads, source: 'legacy/backend/uploads' },
    { root: tempUploads, source: 'os.tmpdir() fallback' },
  ].filter(Boolean) as Array<{ root: string; source: string }>;
}

function resolveUploadsRoot(): ResolvedRuntimePath {
  if (cachedUploadsRoot) return cachedUploadsRoot;

  const errors: string[] = [];
  for (const candidate of buildUploadsCandidates()) {
    if (ensureWritableDirectory(candidate.root)) {
      cachedUploadsRoot = candidate;
      if (candidate.source !== 'legacy/backend/uploads') {
        logger.info(`Uploads runtime root resolved to ${candidate.root} (${candidate.source})`);
      }
      return cachedUploadsRoot;
    }
    errors.push(`${candidate.source}:${candidate.root}`);
  }

  const emergencyRoot = path.join(os.tmpdir(), 'stocks-runtime', 'uploads');
  fs.mkdirSync(emergencyRoot, { recursive: true });
  cachedUploadsRoot = { root: emergencyRoot, source: 'emergency-os.tmpdir()' };
  logger.warn(
    `Failed to use preferred uploads roots (${errors.join(', ')}); falling back to ${emergencyRoot}`
  );
  return cachedUploadsRoot;
}

export function getUploadsRoot() {
  return resolveUploadsRoot().root;
}

export function getUploadsRootMeta() {
  return resolveUploadsRoot();
}

export function getAvatarUploadsDir() {
  return path.join(getUploadsRoot(), 'avatars');
}

export function ensureUploadsRuntime() {
  const resolved = resolveUploadsRoot();
  const avatarDir = path.join(resolved.root, 'avatars');
  if (!ensureWritableDirectory(avatarDir)) {
    throw new Error(`无法创建或写入头像目录: ${avatarDir}`);
  }
  return resolved;
}
