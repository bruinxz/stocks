import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 跌停股池数据客户端 — US-057。
 *
 * 通过 AKShare Python helper 拉取 `stock_zt_pool_dtgc_em(date)` 单日跌停股池
 * （东方财富网 - 行情中心 - 涨停板行情 - 跌停股池）。
 *
 * 与 LimitUpClient (US-007) 对应反向 — US-007 入库 LimitUpStock 模型供短线策略
 * 用,但 US-057 只用本接口的 **行数** 作为"跌停数"信号入 MarketSentimentIndex
 * 的 `(涨停数 - 跌停数) × 0.3` 加权项,不入库个股明细。
 *
 * 若未来 US-058+ 有"行业级跌停分析"需求 → 加 LimitDownStock 模型 + sync 服务。
 */
export interface LimitDownStockRow {
  trade_date: string;
  stock_code: string;
  stock_name: string | null;
  pct_change: number | null;
  latest_price: number | null;
  turnover: number | null;
  circ_market_cap: number | null;
  total_market_cap: number | null;
  turnover_ratio: number | null;
  seal_amount: number | null;
  last_seal_time: string | null;
  continuous_days: number | null;
  open_times: number | null;
  industry: string | null;
  raw_payload: Record<string, unknown>;
}

export class LimitDownClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `LimitDownClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取指定日期的跌停股池。
   * @param date ISO 日期 (YYYY-MM-DD) 或 8 位 (YYYYMMDD)
   */
  async fetchDailyPool(date: string): Promise<LimitDownStockRow[]> {
    try {
      logger.info(`Fetching limit-down pool for ${date}`);
      const rows = (await this.callPythonScript('get_limit_down_pool', date)) as
        | LimitDownStockRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Limit-down pool for ${date}: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch limit-down pool for ${date}: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本（与 LimitUpClient 等同款 {success,data} 契约）。
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.LIMIT_DOWN_TIMEOUT_MS || 60_000);
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

export const limitDownClient = new LimitDownClient();
