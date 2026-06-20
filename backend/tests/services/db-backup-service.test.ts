/**
 * DbBackupService 单元测试 (US-096 / OPS-007)
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/db-backup-service.test.ts
 *
 * 覆盖维度:
 *   [1] 常量 freeze + 边界 (DEFAULT_BACKUP_TIMEOUT_MS / DEFAULT_RETENTION_DAYS /
 *       BACKUP_FILE_NAME_REGEX / BACKUP_SCRIPT_RELATIVE_PATH /
 *       DEFAULT_BACKUP_DIR_RELATIVE)
 *   [2] normalizeRetentionDays (default / numeric string / float / negative /
 *       0 / NaN / Infinity / null / undefined / '')
 *   [3] normalizeTimeoutMs 同款 + min 1000
 *   [4] isValidBackupFileName (YYYY-MM-DD.sql.gz / .gitkeep / 含路径 / 小写月)
 *   [5] sortBackupFilesByMtimeDesc 稳定排序 + name tie-break
 *   [6] pickLatestBackup (空 / 单条 / 多条)
 *   [7] buildBackupEnv 不丢 baseEnv + 强写 RETENTION / BACKUP_DIR
 *   [8] runDbBackup e2e (走 fake BackupRunner):
 *        (a) dry_run=true → 不 spawn, 仅扫文件返报告
 *        (b) 真跑成功 (spawn status=0) → success=true + latest_backup_file
 *        (c) 真跑失败 (spawn status=1) → success=false + error + spawn 仍带 stderr
 *        (d) 真跑超时 (timed_out=true) → success=false + error 含 timed_out
 *        (e) spawn 自身 throw → success=false + error: spawn_threw
 *        (f) listBackupFiles throw → success=true (主备份不传染), files=[]
 *        (g) resolveRepoRoot throw → success=false + error: resolve_repo_root_failed
 *        (h) parameters 透传 (retentionDaysOverride / timeoutMsOverride / backupDirOverride)
 *   [9] PRODUCTION runner smoke — 工厂返对象, 调 listBackupFiles 不存在路径返 []
 *   [10] META-GUARD: cron registry 含 DB_BACKUP + SchedulerService 含 dispatch 分支
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  BACKUP_FILE_NAME_REGEX,
  BACKUP_SCRIPT_RELATIVE_PATH,
  BackupFileInfo,
  BackupRunner,
  DEFAULT_BACKUP_DIR_RELATIVE,
  DEFAULT_BACKUP_TIMEOUT_MS,
  DEFAULT_RETENTION_DAYS,
  RunDbBackupOptions,
  SpawnBackupResult,
  buildBackupEnv,
  createProductionBackupRunner,
  getProductionBackupRunner,
  isValidBackupFileName,
  normalizeRetentionDays,
  normalizeTimeoutMs,
  pickLatestBackup,
  runDbBackup,
  sortBackupFilesByMtimeDesc,
} from '../../src/services/DbBackupService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ============================================================================
// Fake BackupRunner
// ============================================================================
interface FakeRunnerState {
  spawnCalls: Array<{
    scriptAbsPath: string;
    backupDirAbsPath: string;
    retentionDays: number;
    timeoutMs: number;
  }>;
  listCalls: string[];
  spawnResult: SpawnBackupResult;
  spawnShouldThrow: Error | null;
  listResult: BackupFileInfo[];
  listShouldThrow: Error | null;
  repoRoot: string;
  repoRootShouldThrow: Error | null;
}

function makeFakeRunner(overrides: Partial<FakeRunnerState> = {}): {
  runner: BackupRunner;
  state: FakeRunnerState;
} {
  const state: FakeRunnerState = {
    spawnCalls: [],
    listCalls: [],
    spawnResult: {
      status: 0,
      signal: null,
      stdout: '[backup-db] ok',
      stderr: '',
      elapsed_ms: 1234,
      timed_out: false,
    },
    spawnShouldThrow: null,
    listResult: [],
    listShouldThrow: null,
    repoRoot: '/fake/repo',
    repoRootShouldThrow: null,
    ...overrides,
  };
  const runner: BackupRunner = {
    resolveRepoRoot(): string {
      if (state.repoRootShouldThrow) throw state.repoRootShouldThrow;
      return state.repoRoot;
    },
    async spawnBackupScript(input) {
      state.spawnCalls.push({
        scriptAbsPath: input.scriptAbsPath,
        backupDirAbsPath: input.backupDirAbsPath,
        retentionDays: input.retentionDays,
        timeoutMs: input.timeoutMs,
      });
      if (state.spawnShouldThrow) throw state.spawnShouldThrow;
      return state.spawnResult;
    },
    async listBackupFiles(backupDirAbs: string): Promise<BackupFileInfo[]> {
      state.listCalls.push(backupDirAbs);
      if (state.listShouldThrow) throw state.listShouldThrow;
      return state.listResult;
    },
  };
  return { runner, state };
}

// ============================================================================
// [1] 常量
// ============================================================================
console.log('\n[1] 常量边界...');
assert('DEFAULT_BACKUP_TIMEOUT_MS = 30min', DEFAULT_BACKUP_TIMEOUT_MS === 30 * 60_000);
assert('DEFAULT_RETENTION_DAYS = 30', DEFAULT_RETENTION_DAYS === 30);
assert(
  'BACKUP_SCRIPT_RELATIVE_PATH = scripts/backup-db.sh',
  BACKUP_SCRIPT_RELATIVE_PATH === 'scripts/backup-db.sh'
);
assert(
  'DEFAULT_BACKUP_DIR_RELATIVE = backups',
  DEFAULT_BACKUP_DIR_RELATIVE === 'backups'
);
assert(
  'BACKUP_FILE_NAME_REGEX 匹配 2026-06-20.sql.gz',
  BACKUP_FILE_NAME_REGEX.test('2026-06-20.sql.gz')
);
assert(
  'BACKUP_FILE_NAME_REGEX 不匹配 readme.md',
  !BACKUP_FILE_NAME_REGEX.test('readme.md')
);
assert(
  'BACKUP_FILE_NAME_REGEX 不匹配 backup-2026-06-20.sql.gz (前缀)',
  !BACKUP_FILE_NAME_REGEX.test('backup-2026-06-20.sql.gz')
);
assert(
  'BACKUP_FILE_NAME_REGEX 不匹配 2026-06-20.sql (无 .gz)',
  !BACKUP_FILE_NAME_REGEX.test('2026-06-20.sql')
);

// ============================================================================
// [2] normalizeRetentionDays
// ============================================================================
console.log('\n[2] normalizeRetentionDays...');
assertEqual('default undef', normalizeRetentionDays(undefined), 30);
assertEqual('default null', normalizeRetentionDays(null), 30);
assertEqual('default empty string', normalizeRetentionDays(''), 30);
assertEqual('explicit fallback', normalizeRetentionDays(undefined, 60), 60);
assertEqual('numeric 60', normalizeRetentionDays(60), 60);
assertEqual('string number "45"', normalizeRetentionDays('45'), 45);
assertEqual('float floor', normalizeRetentionDays(7.9), 7);
assertEqual('negative → fallback', normalizeRetentionDays(-5), 30);
assertEqual('zero → fallback', normalizeRetentionDays(0), 30);
assertEqual('NaN string → fallback', normalizeRetentionDays('abc'), 30);
assertEqual('Infinity → fallback', normalizeRetentionDays(Infinity), 30);
assertEqual('1 min', normalizeRetentionDays(1), 1);
assertEqual('0.5 → 1 (Math.max 1)', normalizeRetentionDays(0.5), 1);

// ============================================================================
// [3] normalizeTimeoutMs
// ============================================================================
console.log('\n[3] normalizeTimeoutMs...');
assertEqual('default', normalizeTimeoutMs(undefined), DEFAULT_BACKUP_TIMEOUT_MS);
assertEqual('numeric', normalizeTimeoutMs(5000), 5000);
assertEqual('< 1000 floor', normalizeTimeoutMs(500), 1000);
assertEqual('negative → fallback', normalizeTimeoutMs(-1), DEFAULT_BACKUP_TIMEOUT_MS);
assertEqual('NaN string → fallback', normalizeTimeoutMs('abc'), DEFAULT_BACKUP_TIMEOUT_MS);
assertEqual('float floor', normalizeTimeoutMs(2500.7), 2500);

// ============================================================================
// [4] isValidBackupFileName
// ============================================================================
console.log('\n[4] isValidBackupFileName...');
assert('ok 2026-06-20.sql.gz', isValidBackupFileName('2026-06-20.sql.gz'));
assert('ok 1999-01-01.sql.gz', isValidBackupFileName('1999-01-01.sql.gz'));
assert('reject .gitkeep', !isValidBackupFileName('.gitkeep'));
assert(
  'reject 含路径 2026-06-20.sql.gz/sub',
  !isValidBackupFileName('2026-06-20.sql.gz/sub')
);
assert('reject 小写月 abc-06-20.sql.gz', !isValidBackupFileName('abc-06-20.sql.gz'));
assert('reject 多余空格', !isValidBackupFileName(' 2026-06-20.sql.gz'));
assert('reject README', !isValidBackupFileName('README'));

// ============================================================================
// [5] sortBackupFilesByMtimeDesc
// ============================================================================
console.log('\n[5] sortBackupFilesByMtimeDesc...');
const f1: BackupFileInfo = {
  name: '2026-06-18.sql.gz',
  size_bytes: 100,
  mtime_iso: '2026-06-18T02:00:00.000Z',
  abs_path: '/x/2026-06-18.sql.gz',
};
const f2: BackupFileInfo = {
  name: '2026-06-20.sql.gz',
  size_bytes: 200,
  mtime_iso: '2026-06-20T02:00:00.000Z',
  abs_path: '/x/2026-06-20.sql.gz',
};
const f3: BackupFileInfo = {
  name: '2026-06-19.sql.gz',
  size_bytes: 150,
  mtime_iso: '2026-06-19T02:00:00.000Z',
  abs_path: '/x/2026-06-19.sql.gz',
};
const sorted = sortBackupFilesByMtimeDesc([f1, f2, f3]);
assertEqual('sort desc by mtime', sorted.map(f => f.name), [
  '2026-06-20.sql.gz',
  '2026-06-19.sql.gz',
  '2026-06-18.sql.gz',
]);
// Same mtime → name desc tie-break
const sameA: BackupFileInfo = { ...f1, name: 'a.sql.gz' };
const sameB: BackupFileInfo = { ...f1, name: 'b.sql.gz' };
const tied = sortBackupFilesByMtimeDesc([sameA, sameB]);
assertEqual('tie name desc', tied.map(f => f.name), ['b.sql.gz', 'a.sql.gz']);
// 输入不被 mutate
const inputArr = [f1, f2];
sortBackupFilesByMtimeDesc(inputArr);
assertEqual('input immutable', inputArr, [f1, f2]);

// ============================================================================
// [6] pickLatestBackup
// ============================================================================
console.log('\n[6] pickLatestBackup...');
assertEqual('empty → null', pickLatestBackup([]), null);
assertEqual('single', pickLatestBackup([f1]), f1);
assertEqual('multi → latest', pickLatestBackup([f1, f2, f3]), f2);
assertEqual('null arg → null', pickLatestBackup(null as any), null);

// ============================================================================
// [7] buildBackupEnv
// ============================================================================
console.log('\n[7] buildBackupEnv...');
const builtEnv = buildBackupEnv(
  { DB_HOST: 'h', DB_PASSWORD: 'p', UNRELATED: 'u' },
  '/tmp/backups',
  45
);
assertEqual('inherit DB_HOST', builtEnv.DB_HOST, 'h');
assertEqual('inherit DB_PASSWORD', builtEnv.DB_PASSWORD, 'p');
assertEqual('inherit UNRELATED', builtEnv.UNRELATED, 'u');
assertEqual('inject BACKUP_DIR', builtEnv.BACKUP_DIR, '/tmp/backups');
assertEqual('inject RETENTION_DAYS string', builtEnv.RETENTION_DAYS, '45');

// ============================================================================
// [8] runDbBackup e2e
// ============================================================================
console.log('\n[8] runDbBackup e2e...');

async function runTests(): Promise<void> {
  // (a) dry_run=true
  {
    const { runner, state } = makeFakeRunner({ listResult: [f1, f2, f3] });
    const r = await runDbBackup(runner, { dry_run: true });
    assert('(a) success', r.success);
    assert('(a) dry_run=true', r.dry_run === true);
    assert('(a) 不 spawn', state.spawnCalls.length === 0);
    assert('(a) listBackupFiles 1 次', state.listCalls.length === 1);
    assertEqual('(a) latest = f2', r.latest_backup_file?.name, '2026-06-20.sql.gz');
    assertEqual('(a) files 3', r.files.length, 3);
    assert(
      '(a) backup_dir 走 repo_root/backups',
      r.backup_dir === '/fake/repo/backups' || r.backup_dir === process.env.BACKUP_DIR
    );
  }

  // (b) 真跑成功
  {
    const { runner, state } = makeFakeRunner({ listResult: [f2] });
    const r = await runDbBackup(runner);
    assert('(b) success=true', r.success);
    assert('(b) dry_run=false', r.dry_run === false);
    assert('(b) spawn 1 次', state.spawnCalls.length === 1);
    assertEqual('(b) scriptAbsPath',
      state.spawnCalls[0].scriptAbsPath,
      '/fake/repo/scripts/backup-db.sh'
    );
    assertEqual('(b) retention 30 default', state.spawnCalls[0].retentionDays, 30);
    assertEqual('(b) timeout 30min default',
      state.spawnCalls[0].timeoutMs,
      DEFAULT_BACKUP_TIMEOUT_MS
    );
    assertEqual('(b) latest', r.latest_backup_file?.name, '2026-06-20.sql.gz');
    assert('(b) no error', !r.error);
    assertEqual('(b) spawn.status=0', r.spawn?.status, 0);
  }

  // (c) 真跑失败 (status=1)
  {
    const { runner } = makeFakeRunner({
      listResult: [],
      spawnResult: {
        status: 1,
        signal: null,
        stdout: '',
        stderr: 'pg_dump: connection refused',
        elapsed_ms: 200,
        timed_out: false,
      },
    });
    const r = await runDbBackup(runner);
    assert('(c) success=false', !r.success);
    assert('(c) error 含 backup_script_exit_1', !!r.error && r.error.includes('backup_script_exit_1'));
    assert('(c) error 含 stderr', !!r.error && r.error.includes('connection refused'));
    assertEqual('(c) latest = null (空目录)', r.latest_backup_file, null);
  }

  // (d) 超时
  {
    const { runner } = makeFakeRunner({
      listResult: [],
      spawnResult: {
        status: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: '',
        elapsed_ms: 5000,
        timed_out: true,
      },
    });
    const r = await runDbBackup(runner, { timeoutMsOverride: 5000 });
    assert('(d) success=false', !r.success);
    assert('(d) error 含 timed_out', !!r.error && r.error.includes('timed_out'));
    assert('(d) error 含 5000ms', !!r.error && r.error.includes('5000'));
  }

  // (e) spawn throw
  {
    const { runner } = makeFakeRunner({ spawnShouldThrow: new Error('ENOENT') });
    const r = await runDbBackup(runner);
    assert('(e) success=false', !r.success);
    assert('(e) error: spawn_threw', !!r.error && r.error.startsWith('spawn_threw'));
    assert('(e) error 含 ENOENT', !!r.error && r.error.includes('ENOENT'));
  }

  // (f) listBackupFiles throw (post-spawn) → 主备份成功仍返 success=true
  {
    const { runner } = makeFakeRunner({
      listShouldThrow: new Error('EPERM'),
    });
    const r = await runDbBackup(runner);
    assert('(f) spawn success → 整体 success', r.success);
    assertEqual('(f) files 空', r.files, []);
    assertEqual('(f) latest = null', r.latest_backup_file, null);
  }

  // (g) resolveRepoRoot throw
  {
    const { runner } = makeFakeRunner({
      repoRootShouldThrow: new Error('cannot resolve'),
    });
    const r = await runDbBackup(runner);
    assert('(g) success=false', !r.success);
    assert('(g) error: resolve_repo_root_failed',
      !!r.error && r.error.startsWith('resolve_repo_root_failed')
    );
  }

  // (h) parameters 透传
  {
    const { runner, state } = makeFakeRunner({});
    const opts: RunDbBackupOptions = {
      dry_run: false,
      retentionDaysOverride: 7,
      timeoutMsOverride: 60_000,
      backupDirOverride: '/custom/backups',
    };
    const r = await runDbBackup(runner, opts);
    assert('(h) success', r.success);
    assertEqual('(h) retention 透传 7', r.retention_days, 7);
    assertEqual('(h) backup_dir 透传',
      r.backup_dir,
      '/custom/backups'
    );
    assertEqual('(h) spawn 收到 backupDir',
      state.spawnCalls[0].backupDirAbsPath,
      '/custom/backups'
    );
    assertEqual('(h) spawn 收到 retention 7', state.spawnCalls[0].retentionDays, 7);
    assertEqual('(h) spawn 收到 timeout 60000', state.spawnCalls[0].timeoutMs, 60_000);
  }
}

// ============================================================================
// [9] PRODUCTION runner smoke
// ============================================================================
async function smoke(): Promise<void> {
  console.log('\n[9] PRODUCTION runner smoke...');
  const r = createProductionBackupRunner();
  assert('prod runner is object', typeof r === 'object' && r !== null);
  assert('has resolveRepoRoot', typeof r.resolveRepoRoot === 'function');
  assert('has listBackupFiles', typeof r.listBackupFiles === 'function');
  assert('has spawnBackupScript', typeof r.spawnBackupScript === 'function');
  // resolveRepoRoot 不挂
  const root = r.resolveRepoRoot();
  assert('repo root non-empty', typeof root === 'string' && root.length > 0);
  // listBackupFiles 不存在路径返 []
  const empty = await r.listBackupFiles('/this/path/does/not/exist/__xyz__');
  assertEqual('list non-existent → []', empty, []);
  // singleton 复用
  const a = getProductionBackupRunner();
  const b = getProductionBackupRunner();
  assert('singleton 复用', a === b);
}

// ============================================================================
// [10] META-GUARD: cron registry + scheduler dispatch
// ============================================================================
function metaGuard(): void {
  console.log('\n[10] META-GUARD: cron registry + scheduler dispatch...');

  const registryPath = path.resolve(__dirname, '../../src/constants/cronRegistry.ts');
  const registrySrc = fs.readFileSync(registryPath, 'utf-8');
  assert(
    'cronRegistry.ts 含 DB_BACKUP 字符串',
    registrySrc.includes("type: 'DB_BACKUP'")
  );
  assert(
    'cronRegistry.ts 含 US-096 OPS-007 注释',
    registrySrc.includes('US-096 OPS-007')
  );
  assert(
    'cronRegistry.ts 含 0 2 * * * recommended',
    /recommendedCron:\s*'0\s+2\s+\*\s+\*\s+\*'/.test(registrySrc)
  );

  const schedPath = path.resolve(__dirname, '../../src/services/SchedulerService.ts');
  const schedSrc = fs.readFileSync(schedPath, 'utf-8');
  assert(
    'SchedulerService.ts 含 task.type === DB_BACKUP 分支',
    schedSrc.includes("task.type === 'DB_BACKUP'")
  );
  assert(
    'SchedulerService.ts 含 runDbBackup require',
    schedSrc.includes('runDbBackup') && schedSrc.includes('DbBackupService')
  );
  assert(
    'SchedulerService.ts 透传 dry_run',
    schedSrc.includes("scenario: 'db_backup'")
  );
  // import 的 const 引用名一致
  assert(
    'SchedulerService.ts 用 getProductionBackupRunner',
    schedSrc.includes('getProductionBackupRunner')
  );

  // cron-registry.test.ts 已存在并守 cron registry ↔ scheduler 一致性,
  // 所以 DB_BACKUP 入 registry + scheduler 加分支 必然被那条测试也覆盖.
}

(async () => {
  await runTests();
  await smoke();
  metaGuard();

  console.log(`\n[DbBackupService] passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
})().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
