import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 行业 ETF 资金流数据客户端 — US-092 数据层.
 *
 * 通过 AKShare Python helper 拉取 per-ETF 单日基金份额 + 单位净值 + 行情快照,
 * 服务层进一步用 day-to-day diff 计算 net_inflow.
 *
 * 对应 Python 命令: `get_etf_flow <date> <codes_csv>`
 * 底层 AKShare 接口 (4 处文档同步标注 — Model column / Python helper docstring /
 * 本 Client jsdoc / SyncService jsdoc 一致):
 *   - `fund_etf_fund_daily_em()` — 全市场 ETF 日度净值 + 基金份额 (one-shot);
 *   - `fund_etf_hist_em(symbol, period='daily', start, end)` — per-ETF 历史行情
 *     (close / 成交额 / 换手率).
 *
 * **AC endpoint substitution 范式** (与 US-034 / US-035 / US-053 / US-091 同款):
 *   AKShare 没有直接的 "per-ETF 日度申赎金额 / AUM 时序" 端点;
 *   选用 "份额 + 净值" 双源合并作为替代:
 *     - AUM = share_count × nav
 *     - net_inflow ≈ (share_count[T] - share_count[T-1]) × nav[T]
 *   净流入推算在 TS SyncService 层完成 (Python 不做 day-to-day diff,
 *   保持"Python 是 dumb fetcher" 边界).
 *
 * **限定 universe = 白名单 ETF**:
 *   不扫全市场 ETF (5000+ 只含货币 / 债券 / 黄金 / 不主流), Caller 传 codes_csv
 *   只拉白名单内的 30+ 只主流行业 ETF.
 *
 * 性能: 单日 30 只 ETF (fund_etf_fund_daily_em 一次性 ~10s +
 *   fund_etf_hist_em 顺序 30 次每次 ~0.5-1.5s) 总耗 ~30-60s;
 *   ETF_FLOW_TIMEOUT_MS 默认 120s.
 *
 * 数据可用性: AKShare 通常 T+1 上午更新当日数据 (基金份额 EOD 上报).
 */
export interface ETFFlowRow {
  /** 交易日 ISO YYYY-MM-DD */
  trade_date: string;
  /** 6 位 ETF 代码 (无市场前缀) */
  etf_code: string;
  /** ETF 简称 (来自 fund_etf_fund_daily_em "基金简称") */
  etf_name: string | null;
  /** 单位净值 (元/份) */
  nav: number | null;
  /**
   * 基金份额 (份, 部分接口单位是万份, 部分原始份; sync 层不做单位换算 —
   * 同 ETF 时序连续性优先于跨 ETF 比较).
   */
  share_count: number | null;
  /** 当日 ETF 收盘价 (元) */
  close_price: number | null;
  /** 二级市场成交额 (元) */
  secondary_turnover: number | null;
  /**
   * 原始 AKShare 行 (合并 daily + hist), 便于事后回溯
   * (e.g. 后续若引入新字段不需重新拉数据).
   */
  raw_payload: Record<string, unknown>;
}

export class ETFFlowClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(`ETFFlowClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`);
  }

  /**
   * 拉取单个交易日, 指定 ETF 代码列表的份额 + 净值 + 行情快照.
   *
   * @param date  ISO YYYY-MM-DD or YYYYMMDD
   * @param codes 6 位 ETF 代码列表 (e.g. ['159995','512290'])
   */
  async fetchDate(date: string, codes: string[]): Promise<ETFFlowRow[]> {
    if (!codes || codes.length === 0) {
      logger.warn('ETFFlowClient.fetchDate called with empty codes; returning []');
      return [];
    }
    const codesCsv = codes.join(',');
    try {
      logger.info(`Fetching ETF flow for ${date} (${codes.length} codes)`);
      const rows = (await this.callPythonScript('get_etf_flow', date, codesCsv)) as
        | ETFFlowRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`ETF flow rows for ${date}: ${count}`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch ETF flow for ${date}: ${(error as Error).message}`);
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

      const timeoutMs = Number(process.env.ETF_FLOW_TIMEOUT_MS || 120_000);
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

export const etfFlowClient = new ETFFlowClient();
