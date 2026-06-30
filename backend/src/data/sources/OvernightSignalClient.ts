import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 隔夜信号矩阵数据客户端 — PR-M1 数据层.
 *
 * 通过 AKShare Python helper 一次性拉取 5 个隔夜信号 (A50 期指 / 港股恒指 /
 * 纳指 / 美元指数 / VIX). Python 层每个 source 独立 try/except 链路,
 * fail-OPEN 单 source 抖动不阻塞其他.
 *
 * 对应 Python 命令: `get_overnight_signals` (无参数)
 *
 * AC endpoint substitution 范式 (4 处文档同步标注 — Model column / Python
 * helper docstring / 本 Client jsdoc / SyncService jsdoc 一致):
 *   AKShare 全球指数 / VIX 端点命名漂移频繁, Python 内部按候选端点链尝试,
 *   TS 端透传不关心底层 endpoint.
 *
 * 性能: 5 source × ~3-8s/source (Sina 美股端点最慢) ≈ 15-40s 总时长;
 * OVERNIGHT_SIGNAL_TIMEOUT_MS 默认 60s.
 */
export interface OvernightSignalRow {
  /** 信号类型 (与 model.signal_type 严格对齐) */
  signal_type: 'a50_future' | 'hk_hsi' | 'us_nasdaq' | 'us_dxy' | 'us_vix' | 'china_adr';
  /** Python 实际使用的 AKShare endpoint (e.g. 'index_global_em') */
  source: string;
  /** 最新价 / 收盘价 */
  value: number;
  /** 当日涨跌幅 % (可 null — 如 sina 时序首日没 prev) */
  change_pct: number | null;
  /** 原始 AKShare 行 (jsonable) */
  raw_payload: Record<string, unknown>;
}

export class OvernightSignalClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `OvernightSignalClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取全部 5 个隔夜 source. 返数组长度 0-5, 空数组合法 (全部 source 都 fail)
   * — service 层根据数组长度判断 fail-OPEN.
   */
  async fetchAll(): Promise<OvernightSignalRow[]> {
    try {
      logger.info('Fetching overnight signals (5 sources)');
      const rows = (await this.callPythonScript('get_overnight_signals')) as
        | OvernightSignalRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Overnight signals fetched: ${count}/5 sources`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch overnight signals: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本 (与其他 Client 同款契约 JSON: {success, data}).
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.OVERNIGHT_SIGNAL_TIMEOUT_MS || 60_000);
      const timeout = setTimeout(() => {
        logger.error(`Python script timeout for command: ${command}`);
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 1000);
        reject(new Error(`Python script timeout (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', code => {
        clearTimeout(timeout);
        if (code !== 0) {
          logger.error(`Python script failed with code ${code}: ${stderr}`);
          reject(new Error(`Python script failed: ${stderr}`));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          if (result.success) {
            resolve(result.data);
          } else {
            reject(new Error(result.error || 'Unknown error from Python script'));
          }
        } catch (error) {
          logger.error(`Failed to parse Python output: ${stdout.slice(0, 500)}`);
          reject(new Error(`Invalid JSON from Python script: ${(error as Error).message}`));
        }
      });

      child.on('error', error => {
        clearTimeout(timeout);
        logger.error(`Failed to spawn Python process: ${error.message}`);
        reject(error);
      });
    });
  }
}

export const overnightSignalClient = new OvernightSignalClient();
