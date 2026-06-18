import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * MarketHotSearchClient — Batch AH (2026-06-18).
 *
 * 调 Python helper `get_baidu_hot_search` 拉百度 A 股搜索热度榜 top N.
 * 实时快照, AKShare 接口无 date 参数, trade_date 由 caller 服务层贴标签.
 */
export interface MarketHotSearchRow {
  rank: number;
  keyword: string;
  search_index: number | null;
  change_rate: number | null;
  raw_payload: Record<string, unknown>;
}

export class MarketHotSearchClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `MarketHotSearchClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  async fetchHotSearch(limit = 50): Promise<MarketHotSearchRow[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    try {
      const rows = (await this.callPythonScript(
        'get_baidu_hot_search',
        String(safeLimit)
      )) as MarketHotSearchRow[] | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`MarketHotSearch fetched: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`MarketHotSearchClient.fetchHotSearch failed: ${(error as Error).message}`);
      throw error;
    }
  }

  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.MARKET_HOT_SEARCH_TIMEOUT_MS || 60_000);
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
          reject(new Error(`Invalid JSON from Python script: ${(error as Error).message}`));
        }
      });

      child.on('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}

export const marketHotSearchClient = new MarketHotSearchClient();
