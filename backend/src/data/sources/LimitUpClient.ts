import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 涨停板数据客户端 — 通过 AKShare Python helper 拉取单日涨停股池
 * (`stock_zt_pool_em` + `stock_zt_pool_strong_em` 合并后的行)。
 *
 * Python 端会做以下处理：
 *  - 两个接口都拉，按 stock_code 合并；strong-pool 提供"入选理由"
 *  - 计算 `is_one_word_board`（首封 ≤ 09:30 且 炸板次数 == 0）
 *  - 原始 zt_row / strong_row 都塞进 `raw_payload` 便于审计
 *  - 连板数初值取自 AKShare 的 `连板数` 列；TS 服务会基于历史记录复算
 *
 * 单日量级一般 50-300 行（涨停股数 + 强势股数），timeout 60s 足够。
 */
export interface LimitUpStockRow {
  /** ISO 日期 YYYY-MM-DD */
  trade_date: string;
  /** 6 位代码 */
  stock_code: string;
  /** 中文股票简称（可空） */
  stock_name: string | null;
  /** 首次封板时间 HH:MM:SS（强势股池独有行可空） */
  limit_up_time: string | null;
  /** 封板资金（元，可空） */
  limit_up_amount: number | null;
  /** 炸板次数（默认 0） */
  limit_up_open_times: number | null;
  /** 连板天数（AKShare 端的初值；TS 服务会基于历史记录复算并覆盖） */
  continuous_days: number;
  /** 入选理由 / 上榜原因（可空） */
  reason: string | null;
  /** 所属行业（可空） */
  industry: string | null;
  /** 一字板标记（Python 端预计算） */
  is_one_word_board: boolean;
  /** 原始 AKShare 行（含 zt_row / strong_row 两层） */
  raw_payload: Record<string, unknown>;
}

export class LimitUpClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(`LimitUpClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`);
  }

  /**
   * 拉取指定日期的涨停股池（含强势股侧车字段）。
   * @param date ISO 日期 (YYYY-MM-DD) 或 8 位 (YYYYMMDD)
   */
  async fetchDailyPool(date: string): Promise<LimitUpStockRow[]> {
    try {
      logger.info(`Fetching limit-up pool for ${date}`);
      const rows = (await this.callPythonScript('get_limit_up_pool', date)) as
        | LimitUpStockRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Limit-up pool for ${date}: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch limit-up pool for ${date}: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本（与 AKShareClient / NorthboundDataClient 同样的 {success,data} 契约）
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.LIMIT_UP_TIMEOUT_MS || 60_000);
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

export const limitUpClient = new LimitUpClient();
