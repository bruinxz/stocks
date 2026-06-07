import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 个股情绪 / 散户人气数据客户端 — US-034 EastMoneyQAClient.
 *
 * AC 提到的端点 `stock_guba_em` 在 AKShare 中**不存在**（命名是空架子）；
 * AC 提到的 `stock_hot_rank_em` 只返回**当日 top 100**实时榜单（无历史）。
 * 本客户端用真正能提供 per-stock 历史时序的 `stock_hot_rank_detail_em`：
 *
 *   - 东方财富网 - 个股人气榜 - 历史趋势及粉丝特征
 *   - 输入：symbol = 'SH600519' / 'SZ000001' (Python helper 内部从 6-digit 推导)
 *   - 输出：~365 天 (trade_date, rank, new_fan_ratio, hardcore_fan_ratio)
 *
 * AC 期望字段 (post_count / view_count) AKShare 不可得，Python helper 内做
 * **双重代理** 转换（参见 backend/python/akshare_helper.py get_stock_sentiment
 * docstring + StockSentiment 模型注释）：
 *   - post_count   = round(100000 / rank)
 *   - view_count   = round((new_fan + hardcore_fan) × 1000)
 *   - heat_score   = 0.7 × post_count + 0.3 × view_count
 *
 * 类名 `EastMoneyQAClient` 与 AC 一致；实际数据源是 EastMoney 人气榜
 * (rank + fans) 而非股吧 Q&A，类名是 AC 历史命名，不必改。
 *
 * 与 DividendHistoryClient / FinancialReportClient / AnalystForecastClient
 * (US-022 / US-024 / US-030) 同款 **per-stock 历史时间线** pattern：
 *   - per-date sync：一次拉一天 × N 只股票（北向/龙虎榜/涨停/业绩预告）
 *   - per-stock sync：一次拉一只 × N 天/年（股息/财报/分析师研报/**人气**）
 */
export interface StockSentimentRow {
  /** 交易日 ISO YYYY-MM-DD */
  trade_date: string;
  /** 6 位股票代码（无后缀） */
  stock_code: string;
  /** AC 字段：发帖数代理 (1/rank × 100000，整数) */
  post_count: number | null;
  /** AC 字段：浏览量代理 (粉丝总和 × 1000，整数) */
  view_count: number | null;
  /** AC 字段：综合热度分 (0.7×post + 0.3×view，浮点) */
  heat_score: number | null;
  /** 原始 EastMoney 人气榜排名 (1 = 全市场最热) */
  rank: number | null;
  /** 新晋粉丝占比 [0, 1] */
  new_fan_ratio: number | null;
  /** 铁杆粉丝占比 [0, 1] */
  hardcore_fan_ratio: number | null;
  /** 原始 AKShare 行 */
  raw_payload: Record<string, unknown>;
}

export class EastMoneyQAClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `EastMoneyQAClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取指定股票全部历史人气数据（按交易日升序）。
   *
   * @param stockCode 6 位股票代码（无后缀），例如 600519 / 000001
   * @returns sentiment 行数组（可能为空）；底层 Python error 时返回 [] 不抛
   */
  async fetchForStock(stockCode: string): Promise<StockSentimentRow[]> {
    try {
      const cleaned = String(stockCode).trim();
      if (!/^\d{6}$/.test(cleaned)) {
        logger.warn(`EastMoneyQAClient: invalid stock_code format: ${stockCode}`);
        return [];
      }
      logger.info(`Fetching stock sentiment for stock=${cleaned}`);
      const rows = (await this.callPythonScript('get_stock_sentiment', cleaned)) as
        | StockSentimentRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Stock sentiment for ${cleaned}: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch stock sentiment for ${stockCode}: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 与 AnalystForecastClient 同样的契约：JSON `{success, data}` from Python.
   * 默认 timeout 90s（per-stock 历史 365 行，多数 < 5s; 极端慢 ~20s）.
   * 可通过 `EAST_MONEY_QA_TIMEOUT_MS` 环境变量覆写。
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.EAST_MONEY_QA_TIMEOUT_MS || 90_000);
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

export const eastMoneyQAClient = new EastMoneyQAClient();
