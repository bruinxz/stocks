import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * MarketNewsClient — Batch AG (2026-06-18).
 *
 * 通过 Python helper 调 AKShare 多个 endpoint 汇总 "今日全市场要闻":
 *   - stock_info_global_cls (财联社电报, 7x24h 实时)
 *   - stock_info_global_em (东财全球新闻)
 *   - stock_info_global_sina (新浪全球新闻)
 *
 * Python 端做 fallback + 去重 + 排序, TS 端只接收最终 list.
 *
 * 实时快照特性: 无日期参数, 接口返回 "当下时刻 / 近 N 小时" 全市场要闻.
 * 调用方在盘后定时拉取, MarketNewsSyncService 按 publish_time 去重入库.
 */
export interface MarketNewsRow {
  title: string;
  content: string | null;
  publish_time: string | null; // 'YYYY-MM-DD HH:mm:ss'
  source: string; // 'cls' / 'em' / 'sina' / 'baidu'
  category: string | null;
  url: string | null;
  raw_payload: Record<string, unknown>;
}

export class MarketNewsClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `MarketNewsClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取市场新闻 — 多源 fallback + 去重 + DESC.
   * @param limit 返回行数上限 (默认 80, 上限 200)
   */
  async fetchNews(limit = 80): Promise<MarketNewsRow[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    try {
      logger.info(`MarketNewsClient fetchNews limit=${safeLimit}`);
      const rows = (await this.callPythonScript('get_market_news', String(safeLimit))) as
        | MarketNewsRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`MarketNews fetched: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`MarketNewsClient.fetchNews failed: ${(error as Error).message}`);
      throw error;
    }
  }

  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.MARKET_NEWS_TIMEOUT_MS || 120_000);
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
          logger.error(`Failed to parse Python output: ${stdout}`);
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

export const marketNewsClient = new MarketNewsClient();
