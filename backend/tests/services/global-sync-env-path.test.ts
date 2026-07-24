import assert from 'assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { resolveBackendEnvFile } from '../../src/utils/backendEnvFile';

const temp = mkdtempSync(path.join(os.tmpdir(), 'stocks-env-resolution-'));

try {
  const primary = path.join(temp, 'primary');
  const worktree = path.join(temp, 'worktree');
  const primaryEnv = path.join(primary, 'backend', '.env');
  mkdirSync(path.dirname(primaryEnv), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(primaryEnv, 'DB_NAME=test\n', 'utf8');
  writeFileSync(
    path.join(worktree, '.git'),
    `gitdir: ${path.join(primary, '.git', 'worktrees', 'profit-loop')}\n`,
    'utf8'
  );

  const missingWorktreeEnv = path.join(worktree, 'backend', '.env');
  assert.equal(
    resolveBackendEnvFile({
      requested: missingWorktreeEnv,
      repo_root: worktree,
      cwd: path.join(worktree, 'backend'),
      node_env: 'development',
    }),
    primaryEnv,
    'development worktree must reuse the primary checkout environment file'
  );

  const explicitEnv = path.join(temp, 'explicit.env');
  writeFileSync(explicitEnv, 'DB_NAME=explicit\n', 'utf8');
  assert.equal(
    resolveBackendEnvFile({
      requested: explicitEnv,
      repo_root: worktree,
      node_env: 'development',
    }),
    explicitEnv,
    'an existing explicit environment file must take priority'
  );

  assert.equal(
    resolveBackendEnvFile({
      requested: missingWorktreeEnv,
      repo_root: worktree,
      cwd: path.join(worktree, 'backend'),
      node_env: 'production',
    }),
    missingWorktreeEnv,
    'production must not silently borrow a development checkout environment file'
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('global sync environment path tests passed');
