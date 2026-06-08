import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 融资融券交易明细数据客户端 — US-091 数据层.
 *
 * 通过 AKShare Python helper 拉取 per-stock 单日融资融券明细数据 (深交所 + 上交所
 * 合并到统一 schema).
 *
 * 对应 Python 命令: `get_margin_trading_detail <date>`
 * 底层 AKShare 接口:
 *   - `stock_margin_detail_szse(date)` — 深证证券交易所融资融券明细
 *   - `stock_margin_detail_sse(date)`  — 上海证券交易所融资融券明细
 *
 * **与 US-057 MarginBalanceClient 区分**: 后者是 `stock_margin_account_info()`
 * (全市场单行汇总), 用于 MarketSentimentIndex 市场情绪打分; 本 Client 是
 * per-stock 明细, 用于个股级因子.
 *
 * **跨交易所字段差异** (4 处文档同步标注: model column comment / Python helper /
 * 本 Client jsdoc / SyncService jsdoc):
 *   - 深交所有 "融券余额" 列 (元), 上交所无;
 *   - 上交所有 "融资偿还额" 列 (元), 深交所无 (TS 服务层 day-to-day diff 推算);
 *   - 深交所有 "融资融券余额合计" 列 (元), 上交所无.
 *
 * 缺失字段在 Python 层统一对齐为 null, TS 层不需要再做端点分流.
 *
 * 性能: 单次 single-day 调用 ~10-20s (两个交易所串行 ~4000 行总量);
 *   `MARGIN_TRADING_TIMEOUT_MS` 默认 60s 留出余量.
 *
 * 数据可用性: AKShare 通常 T+1 09:00 之前更新当日数据 (盘后导出).
 */
export interface MarginTradingDetailRow {
  /** 交易日 ISO YYYY-MM-DD */
  trade_date: string;
  /** 6 位股票代码 (无市场前缀) */
  stock_code: string;
  /** 股票简称 (冗余便于排查) */
  stock_name: string | null;
  /** 交易所标识 (SZSE 深交所 | SSE 上交所) */
  exchange: 'SZSE' | 'SSE';
  /** 融资余额 (元) */
  fin_balance: number | null;
  /** 融资买入额 (元) */
  fin_buy_amt: number | null;
  /**
   * 融资偿还额 (元).
   *   - 上交所: 来自 AKShare "融资偿还额" 列;
   *   - 深交所: AKShare 无原始列, Python 层返回 null, TS 服务层 day-to-day
   *           diff 推算 = max(0, prev_fin_balance + fin_buy_amt - fin_balance).
   */
  fin_repay_amt: number | null;
  /**
   * 融券余额 (元).
   *   - 深交所: 来自 AKShare "融券余额" 列;
   *   - 上交所: AKShare 端点不返回, null 兜底.
   */
  short_balance: number | null;
  /** 融券卖出量 (股) */
  short_sell_vol: number | null;
  /** 融券偿还量 (股) — 仅上交所提供, 深交所为 null */
  short_repay_vol: number | null;
  /** 融券余量 (股) — 两市都有 */
  short_volume: number | null;
  /**
   * 融资融券余额合计 (元).
   *   - 深交所: 来自 AKShare "融资融券余额" 列;
   *   - 上交所: AKShare 端点无此聚合字段, null 兜底.
   */
  total_margin_balance: number | null;
  /** 原始 AKShare 行 (保留所有字段, 便于事后回溯) */
  raw_payload: Record<string, unknown>;
}

export class MarginTradingClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `MarginTradingClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取单个交易日的全市场融资融券明细 (深交所 + 上交所合并).
   *
   * @param date ISO YYYY-MM-DD or YYYYMMDD (单日)
   */
  async fetchDate(date: string): Promise<MarginTradingDetailRow[]> {
    try {
      logger.info(`Fetching margin trading detail for ${date}`);
      const rows = (await this.callPythonScript('get_margin_trading_detail', date)) as
        | MarginTradingDetailRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Margin trading detail rows for ${date}: ${count}`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(
        `Failed to fetch margin trading detail for ${date}: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本 (与其他 Client 同款契约 JSON: {success, data}).
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.MARGIN_TRADING_TIMEOUT_MS || 60_000);
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
          logger.error(`Failed to parse Python output: ${stdout.slice(0, 500)}`);
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

export const marginTradingClient = new MarginTradingClient();
