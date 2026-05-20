import fs from 'fs';
import os from 'os';
import path from 'path';

type ResolvedRuntimePath = {
  root: string;
  source: string;
};

let cachedUploadsRoot: ResolvedRuntimePath | null = null;
let cachedLogsRoot: ResolvedRuntimePath | null = null;

export function ensureWritableDirectory(directory: string): boolean {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.W_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function discoverSharedRoot(child: 'uploads' | 'logs'): string | null {
  let current = path.resolve(process.cwd());
  for (let depth = 0; depth < 6; depth++) {
    const sharedDir = path.join(current, 'shared');
    if (fs.existsSync(sharedDir) && fs.statSync(sharedDir).isDirectory()) {
      return path.join(sharedDir, child);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function reportRuntimePath(level: 'info' | 'warn', message: string) {
  // Avoid importing logger here: logger itself depends on runtime path discovery.
  const prefix = `[runtime-paths] ${message}`;
  if (level === 'warn') {
    console.warn(prefix);
  } else {
    console.log(prefix);
  }
}

function buildUploadsCandidates() {
  const explicit = process.env.UPLOADS_ROOT ? path.resolve(process.env.UPLOADS_ROOT) : null;
  const shared = discoverSharedRoot('uploads');
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
        reportRuntimePath(
          'info',
          `Uploads runtime root resolved to ${candidate.root} (${candidate.source})`
        );
      }
      return cachedUploadsRoot;
    }
    errors.push(`${candidate.source}:${candidate.root}`);
  }

  const emergencyRoot = path.join(os.tmpdir(), 'stocks-runtime', 'uploads');
  fs.mkdirSync(emergencyRoot, { recursive: true });
  cachedUploadsRoot = { root: emergencyRoot, source: 'emergency-os.tmpdir()' };
  reportRuntimePath(
    'warn',
    `Failed to use preferred uploads roots (${errors.join(', ')}); falling back to ${emergencyRoot}`
  );
  return cachedUploadsRoot;
}

function buildLogsCandidates() {
  const explicit = process.env.LOGS_ROOT ? path.resolve(process.env.LOGS_ROOT) : null;
  const shared = discoverSharedRoot('logs');
  const cwdLogs = path.resolve(process.cwd(), 'logs');
  const legacyLogs = path.resolve(__dirname, '../../logs');
  const tempLogs = path.join(os.tmpdir(), 'stocks-runtime', 'logs');

  return [
    explicit ? { root: explicit, source: 'env.LOGS_ROOT' } : null,
    shared ? { root: shared, source: 'shared/logs' } : null,
    { root: cwdLogs, source: 'cwd/logs' },
    { root: legacyLogs, source: 'legacy/backend/logs' },
    { root: tempLogs, source: 'os.tmpdir() fallback' },
  ].filter(Boolean) as Array<{ root: string; source: string }>;
}

function resolveLogsRoot(): ResolvedRuntimePath {
  if (cachedLogsRoot) return cachedLogsRoot;

  const errors: string[] = [];
  for (const candidate of buildLogsCandidates()) {
    if (ensureWritableDirectory(candidate.root)) {
      cachedLogsRoot = candidate;
      if (candidate.source !== 'legacy/backend/logs') {
        reportRuntimePath(
          'info',
          `Logs runtime root resolved to ${candidate.root} (${candidate.source})`
        );
      }
      return cachedLogsRoot;
    }
    errors.push(`${candidate.source}:${candidate.root}`);
  }

  const emergencyRoot = path.join(os.tmpdir(), 'stocks-runtime', 'logs');
  fs.mkdirSync(emergencyRoot, { recursive: true });
  cachedLogsRoot = { root: emergencyRoot, source: 'emergency-os.tmpdir()' };
  reportRuntimePath(
    'warn',
    `Failed to use preferred log roots (${errors.join(', ')}); falling back to ${emergencyRoot}`
  );
  return cachedLogsRoot;
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

export function getLogsRoot() {
  return resolveLogsRoot().root;
}

export function getLogsRootMeta() {
  return resolveLogsRoot();
}

export function ensureLogsRuntime() {
  return resolveLogsRoot();
}
