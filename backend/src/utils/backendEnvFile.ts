import { existsSync, readFileSync } from 'fs';
import path from 'path';

export interface BackendEnvFileOptions {
  requested?: string | null;
  repo_root: string;
  cwd?: string;
  node_env?: string;
  process_env_file?: string | null;
}

function worktreePrimaryEnv(repo_root: string): string | null {
  try {
    const dotGit = path.join(repo_root, '.git');
    const content = readFileSync(dotGit, 'utf8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/i);
    if (!match) return null;
    const gitDir = path.resolve(repo_root, match[1].trim());
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const markerIndex = gitDir.indexOf(marker);
    if (markerIndex < 0) return null;
    return path.join(gitDir.slice(0, markerIndex), 'backend', '.env');
  } catch {
    return null;
  }
}

export function resolveBackendEnvFile(options: BackendEnvFileOptions): string {
  const repoRoot = path.resolve(options.repo_root);
  const cwd = path.resolve(options.cwd || process.cwd());
  const requested = String(options.requested || '').trim();
  const processEnvFile = String(options.process_env_file || '').trim();
  const candidates = [
    requested,
    processEnvFile,
    path.join(repoRoot, 'backend', '.env'),
    path.join(cwd, '.env'),
  ];
  if (String(options.node_env || '').toLowerCase() !== 'production') {
    const primaryEnv = worktreePrimaryEnv(repoRoot);
    if (primaryEnv) candidates.push(primaryEnv);
  }
  const existing = candidates.find(candidate => candidate && existsSync(candidate));
  return existing || requested || processEnvFile || path.join(repoRoot, 'backend', '.env');
}
