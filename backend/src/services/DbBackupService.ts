/**
 * DbBackupService — L0-Ops / US-096 [OPS-007] DB 备份 cron
 *
 * 每日 02:00 透过 `scripts/backup-db.sh` 把 PostgreSQL 全量 dump 成
 * `backups/YYYY-MM-DD.sql.gz`, 同时清理 30 天前旧备份. 现有 ops shell
 * (US-071) 已实现 pg_dump + gzip + 原子 rename + retention purge, 本服务
 * 只是"在 SchedulerService 里把它包成可调度 / 可单测 / 可验证的 cron".
 *
 * ============================================================================
 * 设计点
 * ============================================================================
 *
 * 1. **DataSource 注入式** (与 [[CleanupOldDataService]] 同款):
 *    `BackupRunner` 接口抽出 (a) spawn 子进程跑 backup-db.sh, (b) fs 扫备份目录
 *    列文件 + size + mtime. 单测注入 fake runner 完整覆盖 happy / non-zero exit /
 *    spawn throw / fs missing 4 路径, 无需真正 fork pg_dump.
 *
 * 2. **不重复 retention 逻辑** — 备份保留 30 天的责任**完全交给 backup-db.sh**
 *    (它已经实现 `find -mtime +RETENTION_DAYS -delete`). 服务层只在 spawn 退出后
 *    扫 BACKUP_DIR 列出现存文件 (用于 result_summary + ops 可见性 + AC
 *    "备份文件存在且可 restore 验证"). 避免两处写 retention 互相矛盾.
 *
 * 3. **fail-OPEN** — 任一备份失败 (spawn 非 0 exit / fs 扫挂) 都不 throw,
 *    返 `{success:false, error}` 让 SchedulerService 仅 logger.warn + 写
 *    failed_items=1 而不让整个 cron tick 崩.
 *    (运维链路绝不传染主流程).
 *
 * 4. **dry_run=true** — 仅扫现有备份返报告, 不 spawn shell. 供 ops 在跑生产
 *    cron 前预览 "现在 backup 目录里有几个文件 / 占多大空间" 的统计.
 *
 * 5. **超时硬上限** — pg_dump 大库 30 分钟内能跑完 (项目 ~100 万行/年估算),
 *    硬限 30 min (1.8e6 ms); 超时 spawn 自身 kill, 服务返 timeout 失败.
 *
 * 6. **env 透传** — DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD /
 *    BACKUP_DIR / RETENTION_DAYS 全 inherit 自 process.env, **不在本服务里
 *    硬编码默认值** (backup-db.sh 自己有兜底). 这样 ops 改 env 就改备份目标,
 *    无需重启 backend.
 *
 * 7. **AC "可 restore 验证"** — 服务返 `result_summary.latest_backup_file`
 *    指向最新备份的绝对路径 + size_bytes; ops 可手动 `npm run db:restore --
 *    --file=<path> --target-db=stock_backtest_test --yes` 在 staging 灌回验证.
 *    本服务不做 restore 验证 (会跨库写入, 风险大); 只让 restore 入口可寻路.
 *
 * Cron 注册位置 (cronRegistry.ts): `DB_BACKUP`, recommendedCron `'0 2 * * *'`
 * (每日 02:00; 早于 03:15 老的 shell-cron 示例; 与 03:00 CLEANUP_OLD_DATA 错峰).
 */

import { logger } from '../utils/logger';

// ============================================================================
// 常量
// ============================================================================

/** pg_dump 大库硬超时 (毫秒). 30 min 足够覆盖 100 万行级数据库. */
export const DEFAULT_BACKUP_TIMEOUT_MS = 30 * 60_000;

/** backup 保留天数默认值 (与 backup-db.sh 默认一致, 仅用于报告/前端展示). */
export const DEFAULT_RETENTION_DAYS = 30;

/** scripts/backup-db.sh 相对仓库根的路径. */
export const BACKUP_SCRIPT_RELATIVE_PATH = 'scripts/backup-db.sh';

/** backup 目录默认路径 (相对仓库根; 与 backup-db.sh 默认一致). */
export const DEFAULT_BACKUP_DIR_RELATIVE = 'backups';

/** 合法备份文件名 regex: YYYY-MM-DD.sql.gz. retention purge 也匹配同款. */
export const BACKUP_FILE_NAME_REGEX = /^\d{4}-\d{2}-\d{2}\.sql\.gz$/;

// ============================================================================
// Types
// ============================================================================

/** 单个已存在备份文件的元信息. */
export interface BackupFileInfo {
  name: string; // 例: 2026-06-20.sql.gz
  size_bytes: number;
  mtime_iso: string; // ISO 8601, 来自 fs.statSync mtime
  abs_path: string;
}

/** spawn 子进程跑 backup-db.sh 的退出信息. */
export interface SpawnBackupResult {
  status: number | null; // 0=成功, 其它/null=失败/信号
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsed_ms: number;
  timed_out: boolean;
}

/** 主服务返值. */
export interface DbBackupResult {
  success: boolean;
  dry_run: boolean;
  backup_dir: string;
  retention_days: number;
  /** dry_run=true 不会有这个; 失败也可能没有. */
  spawn?: SpawnBackupResult;
  /** 扫描 BACKUP_DIR 得到的文件列表 (按 mtime desc). */
  files: BackupFileInfo[];
  /** 最新一个 .sql.gz, 失败 / 空目录时为 null. */
  latest_backup_file: BackupFileInfo | null;
  /** 失败原因 (success=false 时必填). */
  error?: string;
}

/**
 * Runner — DI 接口. 抽掉真正 spawn + fs, 单测注入 fake.
 *
 * Production singleton (`createProductionBackupRunner`) 用 child_process /
 * fs / path 调真实环境; 测试用 in-memory fake 完整覆盖.
 */
export interface BackupRunner {
  /** 跑 `bash <scriptPath>`. env 透传, 硬超时. 失败/超时不 throw, 返结构化结果. */
  spawnBackupScript(input: {
    scriptAbsPath: string;
    backupDirAbsPath: string;
    retentionDays: number;
    env: NodeJS.ProcessEnv;
    cwd: string;
    timeoutMs: number;
  }): Promise<SpawnBackupResult>;

  /** 扫 backupDir 找出形如 YYYY-MM-DD.sql.gz 的文件. dir 不存在返 []. */
  listBackupFiles(backupDirAbsPath: string): Promise<BackupFileInfo[]>;

  /** 返回仓库根的绝对路径 (服务用来 resolve scriptPath / backupDir). */
  resolveRepoRoot(): string;
}

export interface RunDbBackupOptions {
  /** dry_run=true 不 spawn shell, 仅扫现有备份. 默认 false. */
  dry_run?: boolean;
  /** 覆盖 BACKUP_DIR (绝对路径; 默认 <repo_root>/backups 或 env.BACKUP_DIR). */
  backupDirOverride?: string;
  /** 覆盖 retention_days (默认 30 或 env.RETENTION_DAYS). */
  retentionDaysOverride?: number;
  /** 覆盖 spawn 硬超时 (毫秒; 默认 30 min). */
  timeoutMsOverride?: number;
}

// ============================================================================
// 纯函数 helpers (全 export 便于单测)
// ============================================================================

/**
 * normalizeRetentionDays — 把 ScheduledTask.parameters 透传过来的 value 转
 * positive int, 非法 / NaN / ≤0 → fallback 默认值. 与 [[CleanupOldDataService]]
 * normalizeThresholdDays 同款.
 */
export function normalizeRetentionDays(
  value: unknown,
  fallback: number = DEFAULT_RETENTION_DAYS
): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.floor(n));
}

/**
 * normalizeTimeoutMs — 与 normalizeRetentionDays 同款, fallback 30 min.
 */
export function normalizeTimeoutMs(
  value: unknown,
  fallback: number = DEFAULT_BACKUP_TIMEOUT_MS
): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1000, Math.floor(n));
}

/**
 * isValidBackupFileName — 文件名是否合法的备份命名 (YYYY-MM-DD.sql.gz).
 * 用于过滤 BACKUP_DIR 里的非备份文件 (.gitkeep / readme 等).
 */
export function isValidBackupFileName(name: string): boolean {
  return BACKUP_FILE_NAME_REGEX.test(name);
}

/**
 * sortBackupFilesByMtimeDesc — 按 mtime_iso 倒序 (最新在前); 相同时间用
 * name desc tie-break (保稳定).
 */
export function sortBackupFilesByMtimeDesc(files: BackupFileInfo[]): BackupFileInfo[] {
  return [...files].sort((a, b) => {
    if (a.mtime_iso !== b.mtime_iso) return a.mtime_iso < b.mtime_iso ? 1 : -1;
    return a.name < b.name ? 1 : -1;
  });
}

/**
 * pickLatestBackup — 给定 files 列表返最新一条 (按 mtime desc 排序后第一条).
 * 空列表返 null.
 */
export function pickLatestBackup(files: BackupFileInfo[]): BackupFileInfo | null {
  if (!files || files.length === 0) return null;
  const sorted = sortBackupFilesByMtimeDesc(files);
  return sorted[0];
}

/**
 * buildBackupEnv — 把 retention 透到 shell 子进程 (它读 env RETENTION_DAYS).
 * 不覆盖 DB_* (调用方继承 process.env 即可).
 */
export function buildBackupEnv(
  baseEnv: NodeJS.ProcessEnv,
  backupDirAbs: string,
  retentionDays: number
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    BACKUP_DIR: backupDirAbs,
    RETENTION_DAYS: String(retentionDays),
  };
}

// ============================================================================
// Service 主入口
// ============================================================================

/**
 * runDbBackup — 主函数. spawn backup-db.sh + 扫现有备份 + 返结构化结果.
 *
 * 永不 throw; 失败返 `success=false` + `error` 字段.
 */
export async function runDbBackup(
  runner: BackupRunner,
  options: RunDbBackupOptions = {}
): Promise<DbBackupResult> {
  const dryRun = Boolean(options.dry_run);
  const retentionDays = normalizeRetentionDays(
    options.retentionDaysOverride !== undefined
      ? options.retentionDaysOverride
      : process.env.RETENTION_DAYS
  );
  const timeoutMs = normalizeTimeoutMs(options.timeoutMsOverride);

  let repoRoot: string;
  let backupDir: string;
  let scriptAbsPath: string;
  try {
    repoRoot = runner.resolveRepoRoot();
    backupDir = options.backupDirOverride
      ? options.backupDirOverride
      : process.env.BACKUP_DIR
      ? process.env.BACKUP_DIR
      : `${repoRoot}/${DEFAULT_BACKUP_DIR_RELATIVE}`;
    scriptAbsPath = `${repoRoot}/${BACKUP_SCRIPT_RELATIVE_PATH}`;
  } catch (err: any) {
    return {
      success: false,
      dry_run: dryRun,
      backup_dir: '',
      retention_days: retentionDays,
      files: [],
      latest_backup_file: null,
      error: `resolve_repo_root_failed: ${err?.message || String(err)}`,
    };
  }

  // dry_run: 只扫现有备份, 不 spawn
  if (dryRun) {
    let files: BackupFileInfo[] = [];
    try {
      files = await runner.listBackupFiles(backupDir);
    } catch (err: any) {
      logger.warn(`[DbBackup] list dry_run failed: ${err?.message || String(err)}`);
    }
    const sorted = sortBackupFilesByMtimeDesc(files);
    return {
      success: true,
      dry_run: true,
      backup_dir: backupDir,
      retention_days: retentionDays,
      files: sorted,
      latest_backup_file: pickLatestBackup(sorted),
    };
  }

  // 真正跑: spawn 失败/超时不 throw, 走 success=false 路径
  let spawn: SpawnBackupResult;
  try {
    spawn = await runner.spawnBackupScript({
      scriptAbsPath,
      backupDirAbsPath: backupDir,
      retentionDays,
      env: buildBackupEnv(process.env, backupDir, retentionDays),
      cwd: repoRoot,
      timeoutMs,
    });
  } catch (err: any) {
    logger.warn(`[DbBackup] spawn threw: ${err?.message || String(err)}`);
    return {
      success: false,
      dry_run: false,
      backup_dir: backupDir,
      retention_days: retentionDays,
      files: [],
      latest_backup_file: null,
      error: `spawn_threw: ${err?.message || String(err)}`,
    };
  }

  // 不管 spawn 成败都扫一遍目录 (失败时有助 ops 看"现存最旧备份是什么时候")
  let files: BackupFileInfo[] = [];
  try {
    files = await runner.listBackupFiles(backupDir);
  } catch (err: any) {
    logger.warn(`[DbBackup] list post-spawn failed: ${err?.message || String(err)}`);
  }
  const sorted = sortBackupFilesByMtimeDesc(files);
  const latest = pickLatestBackup(sorted);

  const ok = spawn.status === 0 && !spawn.timed_out;
  const result: DbBackupResult = {
    success: ok,
    dry_run: false,
    backup_dir: backupDir,
    retention_days: retentionDays,
    spawn,
    files: sorted,
    latest_backup_file: latest,
  };
  if (!ok) {
    result.error = spawn.timed_out
      ? `backup_timed_out_after_${timeoutMs}ms`
      : `backup_script_exit_${spawn.status ?? 'null'}: ${(spawn.stderr || '').substring(0, 300)}`;
  }
  return result;
}

// ============================================================================
// Production runner — lazy-require child_process / fs / path
// ============================================================================

/**
 * createProductionBackupRunner — production singleton 工厂. 测试不调它,
 * SchedulerService 调一次缓存复用.
 *
 * lazy-require 模式: 单测脱 DB / 脱 fs (走 fake runner) 时, 这些 require 不触发.
 */
export function createProductionBackupRunner(): BackupRunner {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const child = require('child_process');
  const fs = require('fs');
  const path = require('path');
  /* eslint-enable @typescript-eslint/no-var-requires */

  return {
    resolveRepoRoot(): string {
      // backend/src/services/DbBackupService.ts → repo_root 上 3 层
      // dev: src/services/, prod: dist/services/, 都是 ../../.. 到 backend 上一层
      return path.resolve(__dirname, '..', '..', '..');
    },

    async listBackupFiles(backupDirAbs: string): Promise<BackupFileInfo[]> {
      if (!fs.existsSync(backupDirAbs)) return [];
      const out: BackupFileInfo[] = [];
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(backupDirAbs);
      } catch {
        return [];
      }
      for (const name of entries) {
        if (!isValidBackupFileName(name)) continue;
        const abs = path.join(backupDirAbs, name);
        try {
          const st = fs.statSync(abs);
          if (!st.isFile()) continue;
          out.push({
            name,
            size_bytes: Number(st.size) || 0,
            mtime_iso: new Date(st.mtime).toISOString(),
            abs_path: abs,
          });
        } catch {
          // 单个文件 stat 挂 (race / permission) 不传染
          continue;
        }
      }
      return out;
    },

    spawnBackupScript({ scriptAbsPath, backupDirAbsPath, retentionDays, env, cwd, timeoutMs }) {
      return new Promise(resolve => {
        const t0 = Date.now();
        const childProc = child.spawn('bash', [scriptAbsPath], {
          cwd,
          env: { ...env, BACKUP_DIR: backupDirAbsPath, RETENTION_DAYS: String(retentionDays) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const cap = 256 * 1024; // stdout/stderr 各 cap 256KB
        childProc.stdout.on('data', (chunk: Buffer) => {
          if (stdout.length < cap) stdout += chunk.toString('utf-8');
        });
        childProc.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < cap) stderr += chunk.toString('utf-8');
        });
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            childProc.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, timeoutMs);
        childProc.on('error', (err: Error) => {
          clearTimeout(timer);
          resolve({
            status: null,
            signal: null,
            stdout,
            stderr: stderr + `\n[spawn-error] ${err?.message || String(err)}`,
            elapsed_ms: Date.now() - t0,
            timed_out: timedOut,
          });
        });
        childProc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
          clearTimeout(timer);
          resolve({
            status: code,
            signal,
            stdout,
            stderr,
            elapsed_ms: Date.now() - t0,
            timed_out: timedOut,
          });
        });
      });
    },
  };
}

let _prodRunner: BackupRunner | null = null;
/** Singleton (lazy). SchedulerService 复用. */
export function getProductionBackupRunner(): BackupRunner {
  if (!_prodRunner) _prodRunner = createProductionBackupRunner();
  return _prodRunner;
}
