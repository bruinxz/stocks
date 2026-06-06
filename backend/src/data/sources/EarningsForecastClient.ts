import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 业绩预告数据客户端 — 通过 AKShare Python helper 拉取报告期级业绩预告。
 *
 * 对应 Python 命令：`get_earnings_forecast <report_period>`
 * 底层 AKShare 接口：`stock_yjyg_em(date=YYYYMMDD)`
 *
 * **重要**：`report_period` 是 **报告期末** 日期（如 '2024-09-30' = 2024 Q3），
 * 不是公告日。AKShare 该接口按报告期检索，返回该报告期所有股票的预告；
 * 每条记录里的 `announce_date` 是真正的事件发布日。
 *
 * 常见 report_period：
 *   YYYY-03-31  → 一季报预告
 *   YYYY-06-30  → 半年报预告
 *   YYYY-09-30  → 三季报预告
 *   YYYY-12-31  → 年报预告
 *
 * 其他日期返回空 dataframe；调用方可以按季度循环逐个拉取。
 */
export interface EarningsForecastRow {
  /** ISO 公告日期 YYYY-MM-DD（真正的事件日期） */
  announce_date: string;
  /** 6 位股票代码，例如 600519 / 000001 */
  stock_code: string;
  /** 股票简称（冗余便于人工排查） */
  stock_name: string | null;
  /** 报告期末 ISO 日期，例如 2024-09-30 */
  report_period: string;
  /** 预告类型：预增/预减/扭亏/首亏/续盈/续亏/略增/略减/不确定 */
  forecast_type: string | null;
  /** 净利润同比变动幅度下限 (%) */
  profit_change_low: number | null;
  /** 净利润同比变动幅度上限 (%) */
  profit_change_high: number | null;
  /** 预告净利润下限（元） */
  profit_low: number | null;
  /** 预告净利润上限（元） */
  profit_high: number | null;
  /** 业绩变动原因（短文本） */
  forecast_reason: string | null;
  /** 原始 AKShare 行 */
  raw_payload: Record<string, unknown>;
}

export class EarningsForecastClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `EarningsForecastClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取指定 **报告期** 的业绩预告全集（AKShare 按 report_period 检索）。
   * @param reportPeriod ISO YYYY-MM-DD 或 YYYYMMDD（报告期末日期）
   */
  async fetchForReportPeriod(reportPeriod: string): Promise<EarningsForecastRow[]> {
    try {
      logger.info(`Fetching earnings forecasts for report_period=${reportPeriod}`);
      const rows = (await this.callPythonScript('get_earnings_forecast', reportPeriod)) as
        | EarningsForecastRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Earnings forecasts for ${reportPeriod}: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(
        `Failed to fetch earnings forecasts for ${reportPeriod}: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本（与 NorthboundDataClient 同样的契约 JSON: {success, data}）
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.EARNINGS_FORECAST_TIMEOUT_MS || 120_000);
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

export const earningsForecastClient = new EarningsForecastClient();
