import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 融资融券账户统计数据客户端 — US-057。
 *
 * 通过 AKShare Python helper 拉取 `stock_margin_account_info()` 的日度时序：
 *   - 单次返回 ~3300 行全历史 (从 2010 至今),所以仅按 [start_date, end_date]
 *     窗口过滤即可,无需逐日拉。
 *   - **重要**: AKShare 无 per-day 接口,只有"一次拉全量再切片"模式 —— 这与
 *     `LimitUpClient.fetchDailyPool(date)` 单日拉取不同。
 *
 * 用途: `MarketSentimentIndexService` 取最近 lookback_days (默认 60) 的
 *   融资买入额 / 融券卖出额 → 净买入 → 横截面 z-score。
 *
 * 单位说明: AKShare 原始单位是"亿元",字段命名沿用 `_yi` 后缀方便审计。
 */
export interface MarginBalanceRow {
  /** ISO 日期 YYYY-MM-DD */
  date: string;
  /** 融资余额 (亿元) */
  rzye_yi: number | null;
  /** 融券余额 (亿元) */
  rqye_yi: number | null;
  /** 融资买入额 (亿元) */
  rzmre_yi: number | null;
  /** 融券卖出额 (亿元) */
  rqmcl_yi: number | null;
  /** 融资净买入 = rzmre - rqmcl (亿元) — Python 已预算 */
  rz_net_buy_yi: number | null;
  /** 原始 AKShare 行 */
  raw_payload: Record<string, unknown>;
}

export class MarginBalanceClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `MarginBalanceClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取融资融券账户日度时序 (单次 API 调用全量)。
   * @param startDate ISO YYYY-MM-DD 或 8 位 (可选; 不传 = 全量)
   * @param endDate   ISO YYYY-MM-DD 或 8 位 (可选; 不传 = 全量)
   */
  async fetchTimeSeries(startDate?: string, endDate?: string): Promise<MarginBalanceRow[]> {
    try {
      const startArg = startDate || '-';
      const endArg = endDate || '-';
      logger.info(`Fetching margin_account_info time series (start=${startArg} end=${endArg})`);
      const rows = (await this.callPythonScript('get_margin_balance', startArg, endArg)) as
        | MarginBalanceRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Margin balance rows: ${count}`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch margin balance time series: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本（与其他 Client 同款 {success,data} 契约）。
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      // 全量拉 3300 行 + filter,~ 5 秒,给 60s buffer
      const timeoutMs = Number(process.env.MARGIN_BALANCE_TIMEOUT_MS || 60_000);
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

export const marginBalanceClient = new MarginBalanceClient();
