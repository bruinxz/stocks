import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 北向资金数据客户端 — 通过 AKShare Python helper 拉取单日北向持股快照。
 *
 * 对应 Python 命令：`get_northbound_holdings <date> [market]`
 * 底层 AKShare 接口：`stock_hsgt_hold_stock_em`
 *
 * 默认 market="北向"（沪股通+深股通合并，AKShare 会用代码前缀区分 SH/SZ）。
 * AKShare 单日返回前 N 大持仓股票，量级在数千行。
 */
export interface NorthboundHoldingRow {
  /** ISO 日期 YYYY-MM-DD */
  trade_date: string;
  /** 6 位代码，例如 600519 / 000001 */
  stock_code: string;
  /** 中文股票简称 */
  stock_name: string | null;
  /** 北向持股数（股），可能 null */
  hold_volume: number | null;
  /** 北向持股市值（元），可能 null */
  hold_amount: number | null;
  /** 占流通股比 (%)，可能 null */
  hold_ratio: number | null;
  /** SH=沪股通；SZ=深股通 */
  market_type: 'SH' | 'SZ';
  /** 原始 AKShare 行（保留全部字段） */
  raw_payload: Record<string, unknown>;
}

export class NorthboundDataClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `NorthboundDataClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取指定日期的北向持股明细。
   * @param date ISO 日期 (YYYY-MM-DD) 或 8 位 (YYYYMMDD)
   * @param market AKShare 通道名："北向" | "沪股通" | "深股通"（默认 "北向"）
   */
  async fetchHoldings(
    date: string,
    market: '北向' | '沪股通' | '深股通' = '北向'
  ): Promise<NorthboundHoldingRow[]> {
    try {
      logger.info(`Fetching northbound holdings for ${date} (channel=${market})`);
      const rows = (await this.callPythonScript('get_northbound_holdings', date, market)) as
        | NorthboundHoldingRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Northbound holdings for ${date}: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch northbound holdings for ${date}: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本（与 AKShareClient 同样的契约 JSON: {success, data}）
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.NORTHBOUND_TIMEOUT_MS || 60_000);
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

export const northboundDataClient = new NorthboundDataClient();
