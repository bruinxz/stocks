import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 股东户数数据客户端 — US-035.
 *
 * 调用 Python 助手 `get_shareholder_count <stock_code>`，底层使用 AKShare
 * `stock_zh_a_gdhs_detail_em(symbol=<6-digit>)` 取一只股票全部历史股东户数
 * 快照（约 50-70 条 / 上市 10+ 年）。
 *
 * **每行 = 一份股东户数快照**（一只股票在某截止日的统计）。
 * 同股同截止日通常唯一；如有更正会沿用同 (report_date, stock_code) PK 重发
 * 新数据 — bulkCreate + updateOnDuplicate 自然处理。
 *
 * 与 DividendHistoryClient / FinancialReportClient / AnalystForecastClient
 * (US-022 / US-024 / US-030) 同款 per-stock 历史时间线 pattern。
 */
export interface ShareholderCountRow {
  /** ISO 股东户数统计截止日 YYYY-MM-DD */
  report_date: string;
  /** 6 位股票代码（无后缀） */
  stock_code: string;
  /** 股票简称 */
  stock_name: string | null;
  /** AC 必需字段：当期股东户数 (> 0) */
  holder_count: number;
  /** 上一期股东户数 (AKShare 已给的"上次"，便于审计) */
  holder_count_prev: number | null;
  /** 增减值 (= holder_count - holder_count_prev) */
  holder_count_change: number | null;
  /** AKShare 提供的环比 % — 因子层不依赖，保留 sanity check */
  holder_count_change_pct: number | null;
  /** 区间涨跌幅 % (上次到本次股价变化) */
  interval_change_pct: number | null;
  /** 户均持股市值 (元) */
  avg_holder_market_cap: number | null;
  /** 户均持股数量 (股) */
  avg_holder_shares: number | null;
  /** 总市值 (元) */
  total_market_cap: number | null;
  /** 总股本 (股) */
  total_shares: number | null;
  /** 股本变动 (股) — 非零 = 送转股 / 增发，影响 holder_count 环比可比性 */
  share_change: number | null;
  /** 股本变动原因（短文本） */
  share_change_reason: string | null;
  /** 股东户数公告日期 (披露日 ≠ 截止日；通常滞后 7-30 日) */
  announce_date: string | null;
  /** 原始 AKShare 行 */
  raw_payload: Record<string, unknown>;
}

export class ShareholderCountClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `ShareholderCountClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取指定股票全部历史股东户数（按截止日升序）
   *
   * @param stockCode 6 位股票代码（无后缀），例如 600519 / 000001
   * @returns 股东户数数组（可能为空）；底层 Python error 时返回 [] 不抛
   */
  async fetchForStock(stockCode: string): Promise<ShareholderCountRow[]> {
    try {
      const cleaned = String(stockCode).trim();
      if (!/^\d{6}$/.test(cleaned)) {
        logger.warn(`ShareholderCountClient: invalid stock_code format: ${stockCode}`);
        return [];
      }
      logger.info(`Fetching shareholder count history for stock=${cleaned}`);
      const rows = (await this.callPythonScript('get_shareholder_count', cleaned)) as
        | ShareholderCountRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Shareholder count rows for ${cleaned}: ${count}`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(
        `Failed to fetch shareholder count for ${stockCode}: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * 与 AnalystForecastClient 同样的契约：JSON `{success, data}` from Python.
   * 默认 timeout 90s（per-stock 历史时间线，单 endpoint 通常 < 5s）。
   * 可通过 `SHAREHOLDER_COUNT_TIMEOUT_MS` 环境变量覆写。
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.SHAREHOLDER_COUNT_TIMEOUT_MS || 90_000);
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

export const shareholderCountClient = new ShareholderCountClient();
