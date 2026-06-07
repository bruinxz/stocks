import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 财务报告数据客户端 (US-024) — 通过 AKShare Python helper 拉取单只股票的全部历史定期报告。
 *
 * 对应 Python 命令：`get_financial_report <stock_code>`
 * 底层 AKShare 接口（合并两个端点）:
 *   - `stock_financial_analysis_indicator(symbol=<6-digit>, start_year=2015)` — 综合指标，每期一行
 *     提供 净利润增长率 / 主营业务收入增长率 / 净资产收益率 / 资产负债率
 *   - `stock_financial_abstract(symbol=<6-digit>)` — 财务摘要，wide-format
 *     提供 归母净利润 / 营业总收入 原始金额
 *   Python 端按 report_date 合并两个 df → 输出 normalized 行列表。
 *
 * **设计说明**：与按 trade_date 批量同步的北向 / 龙虎榜 / 涨停 / 行业流 不同，
 * 财务报告是 **按股票** 同步的（每只股票一次性拉全部历史报告，
 * 通常每只股票 4 × 10 = 40 条记录覆盖 10 年）。Sync 服务对应
 * `syncStock(code)` / `syncStocks(codes[])`，不是 `syncDate(date)` — 同款于
 * DividendHistory (US-022) 的 per-stock sync 模式。
 *
 * 该接口数据**变化频率低**（公司季度/年度发报告），因此 sync 策略
 * 是 "全量重拉 + upsert"，不需要增量逻辑——每次跑就是 idempotent 全量 refresh
 * 该股票的 financial_reports 行。
 *
 * 输出按 report_date 降序（最新报告在前），调用方可以按需 filter
 * `report_type === '年报'` 走年度链路，或保留全量做季度 trend 分析。
 */
export interface FinancialReportRow {
  /** ISO 报告期末 YYYY-MM-DD */
  report_date: string;
  /** 6 位股票代码 */
  stock_code: string;
  /** 报告类型: 年报 / 半年报 / 一季报 / 三季报 / null */
  report_type: string | null;
  /** 归母净利润（元，可负，可为 null） */
  net_profit: number | null;
  /** 净利润同比增长率 (%, 可为 null) */
  net_profit_yoy: number | null;
  /** 营业总收入（元，可为 null） */
  revenue: number | null;
  /** 主营业务收入同比增长率 (%, 可为 null) */
  revenue_yoy: number | null;
  /** 净资产收益率 ROE (%, 可为 null) — 优先用加权 ROE */
  roe: number | null;
  /** 资产负债率 (%, 可为 null) */
  debt_ratio: number | null;
  /** 原始 AKShare 行（含 analysis_indicator + abstract 两侧合集，便于事后回溯） */
  raw_payload: Record<string, unknown>;
}

export class FinancialReportClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `FinancialReportClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取单只股票的全部历史财务报告（年度 + 季度）。
   * @param stockCode 6 位股票代码（无市场后缀），如 '600519' / '000001'
   */
  async fetchForStock(stockCode: string): Promise<FinancialReportRow[]> {
    try {
      logger.info(`Fetching financial report for stock=${stockCode}`);
      const rows = (await this.callPythonScript('get_financial_report', stockCode)) as
        | FinancialReportRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Financial reports for ${stockCode}: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(
        `Failed to fetch financial report for ${stockCode}: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本（与 DividendHistoryClient 同样的契约 JSON: {success, data}）
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      // Financial report 跑两个 AKShare 端点 + 合并，比单端点慢 — 180s 默认
      const timeoutMs = Number(process.env.FINANCIAL_REPORT_TIMEOUT_MS || 180_000);
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

export const financialReportClient = new FinancialReportClient();
