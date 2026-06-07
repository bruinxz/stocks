import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 分析师研报数据客户端 — US-030.
 *
 * 调用 Python 助手 `get_analyst_forecast <stock_code>`，底层使用 AKShare
 * `stock_research_report_em(symbol=<6-digit>)` 取一只股票全部历史研报。
 *
 * **每行 = 一份研报**（一家机构在某日发布对该股票的一份研报）。
 * 同一天同一家机构偶尔发 ≥ 2 份独立研报（深度 + 点评），TS 服务层会用
 * (report_date + stock_code + analyst_firm) 复合主键 + bulkCreate upsert 处理
 * 重复键时静默保留最后一条（足够 AnalystConsensusFactor 90 日上调幅度算法）。
 *
 * 与 DividendHistoryClient / FinancialReportClient (US-022 / US-024) 同款
 * per-stock 历史时间线 pattern；与按日期检索的 NorthboundDataClient /
 * EarningsForecastClient (US-005 / US-013) 是镜像形态：
 *
 *   - per-date sync：一次拉一天 × N 只股票（北向/龙虎榜/涨停/业绩预告等）
 *   - per-stock sync：一次拉一只 × N 年（股息/财报/分析师研报）
 *     → 适用于全 A 股冷启动一次后增量追加，禁不起每日全量
 */
export interface AnalystForecastRow {
  /** ISO 研报发布日 YYYY-MM-DD */
  report_date: string;
  /** 6 位股票代码（无后缀） */
  stock_code: string;
  /** 发布机构（如 "诚通证券" "中信证券"），与 (date+code) 联合 unique */
  analyst_firm: string;
  /** 股票简称 */
  stock_name: string | null;
  /** 目标价（元） — 当前 AKShare endpoint 不提供，保留 null */
  target_price: number | null;
  /** 东财评级（买入 / 增持 / 中性 / 持有 / 减持 / 卖出 / 未评级） */
  rating: string | null;
  /** 最近期前向年度 EPS 预测 */
  forecast_eps_y1: number | null;
  /** 第二近前向年度 EPS 预测 */
  forecast_eps_y2: number | null;
  /** 第三近前向年度 EPS 预测（常缺） */
  forecast_eps_y3: number | null;
  /** forecast_eps_y1 对应的年份 (YYYY) */
  forecast_year_y1: number | null;
  /** forecast_eps_y2 对应的年份 */
  forecast_year_y2: number | null;
  /** forecast_eps_y3 对应的年份 */
  forecast_year_y3: number | null;
  /** 该股票"近一月个股研报数"（横截面值，per-stock 当前快照） */
  analyst_count: number | null;
  /** 研报标题 */
  report_title: string | null;
  /** 所属行业（东财分类） */
  industry: string | null;
  /** 报告 PDF 链接 */
  report_pdf_url: string | null;
  /** 原始 AKShare 行 */
  raw_payload: Record<string, unknown>;
}

export class AnalystForecastClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `AnalystForecastClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取指定股票全部历史研报（按发布日倒序）
   *
   * @param stockCode 6 位股票代码（无后缀），例如 600519 / 000001
   * @returns 研报数组（可能为空）；底层 Python error 时返回 [] 不抛
   */
  async fetchForStock(stockCode: string): Promise<AnalystForecastRow[]> {
    try {
      const cleaned = String(stockCode).trim();
      if (!/^\d{6}$/.test(cleaned)) {
        logger.warn(`AnalystForecastClient: invalid stock_code format: ${stockCode}`);
        return [];
      }
      logger.info(`Fetching analyst research reports for stock=${cleaned}`);
      const rows = (await this.callPythonScript('get_analyst_forecast', cleaned)) as
        | AnalystForecastRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Analyst research reports for ${cleaned}: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(
        `Failed to fetch analyst forecasts for ${stockCode}: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * 与 EarningsForecastClient 同样的契约：JSON `{success, data}` from Python.
   * 默认 timeout 120s（per-stock 历史时间线，多数 < 10s）。
   * 可通过 `ANALYST_FORECAST_TIMEOUT_MS` 环境变量覆写。
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.ANALYST_FORECAST_TIMEOUT_MS || 120_000);
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

export const analystForecastClient = new AnalystForecastClient();
