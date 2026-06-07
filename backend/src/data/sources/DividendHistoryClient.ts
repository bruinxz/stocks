import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 分红派息历史数据客户端 — 通过 AKShare Python helper 拉取单只股票的历史分红明细。
 *
 * 对应 Python 命令：`get_dividend_history <stock_code>`
 * 底层 AKShare 接口：`stock_history_dividend_detail(symbol=<6-digit>, indicator='分红')`
 *
 * **设计说明**：与按 trade_date 批量同步的北向 / 龙虎榜 / 涨停 / 行业流 不同，
 * dividend history 是 **按股票** 同步的（每只股票一次性拉全部历史分红记录，
 * 通常每只股票只有 10-30 条记录覆盖 10-20 年）。Sync 服务对应 `syncStock(code)` /
 * `syncStocks(codes[])`，不是 `syncDate(date)`。
 *
 * 该接口数据**变化频率低**（公司一年最多 1-2 次新增分红记录），因此 sync 策略
 * 是 "全量重拉 + upsert"，不需要增量逻辑——每次跑就是 idempotent 全量 refresh
 * 该股票的 dividend_histories 行。
 *
 * 派息率 (yield_pct) **不在** Python 端计算，因为它依赖 ex_date 前一日的 DailyBar
 * 收盘价（跨表 join）——按 codebase pattern (cross-table join belongs in TS service)
 * 在 DividendHistorySyncService 内计算。
 */
export interface DividendHistoryRow {
  /** ISO 公告日期 YYYY-MM-DD */
  announce_date: string;
  /** ISO 除权除息日 YYYY-MM-DD（事件生效日） */
  ex_date: string;
  /** 6 位股票代码 */
  stock_code: string;
  /** 每股派息金额（元） = "10 派 X 元" 中 X / 10；null = 未公布 / 不分红 */
  dividend_per_share: number | null;
  /** 10 股送股数（股） */
  bonus_per_10: number | null;
  /** 10 股转增股数（股） */
  transfer_per_10: number | null;
  /** 进度: 董事会预案 / 股东大会决议 / 实施 */
  progress: string | null;
  /** ISO 股权登记日 (可选) */
  record_date: string | null;
  /** ISO 派息日 (可选) */
  pay_date: string | null;
  /** 原始 AKShare 行 */
  raw_payload: Record<string, unknown>;
}

export class DividendHistoryClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `DividendHistoryClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取单只股票的全部历史分红记录。
   * @param stockCode 6 位股票代码（无市场后缀），如 '600519' / '000001'
   */
  async fetchForStock(stockCode: string): Promise<DividendHistoryRow[]> {
    try {
      logger.info(`Fetching dividend history for stock=${stockCode}`);
      const rows = (await this.callPythonScript('get_dividend_history', stockCode)) as
        | DividendHistoryRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Dividend history for ${stockCode}: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(
        `Failed to fetch dividend history for ${stockCode}: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本（与 EarningsForecastClient 等同的契约 JSON: {success, data}）
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.DIVIDEND_HISTORY_TIMEOUT_MS || 120_000);
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

export const dividendHistoryClient = new DividendHistoryClient();
