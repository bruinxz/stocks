import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * 股东增减持公告数据客户端 — US-090 数据层.
 *
 * 通过 AKShare Python helper 拉取近 N 月全市场股东增减持公告快照.
 *
 * 对应 Python 命令: `get_shareholder_trade [symbol]`
 * 底层 AKShare 接口: `stock_ggcg_em(symbol='全部'|'股东增持'|'股东减持')`
 *
 * **Real-time-only 快照语义** (与 US-008 IndustryFlow / US-058 SnowballHotKeyword
 * 同款): AKShare 端点无日期参数, 单次调用返回 "当下可见的近 N 月全市场" 公告
 * 集合 (~140k 行). announce_date 是 per-row 公告日期 (parsed from "公告日"),
 * 但 FULL TABLE 的时间窗口随调用时刻滑动. 历史回填只靠每日定时抓取累积入库.
 *
 * 性能: 单次 symbol='全部' 调用 ~90s (~290 页分页); SHAREHOLDER_TRADE_TIMEOUT_MS
 * 默认 240s 留出余量.
 */
export interface ShareholderTradeRow {
  /** 公告日 ISO YYYY-MM-DD */
  announce_date: string;
  /** 6 位股票代码 (无市场前缀) */
  stock_code: string;
  /** 股票简称 (冗余便于排查) */
  stock_name: string | null;
  /** 股东名称 (e.g. 高管姓名 / 机构全称) */
  shareholder_name: string;
  /** 增减方向: '增持' | '减持' */
  trade_direction: '增持' | '减持';
  /** 变动股数 (股, Python helper 已 ×10000 把万股转成股) */
  trade_shares: number | null;
  /**
   * 变动金额 (元, **代理字段** = trade_shares × latest_price).
   * AKShare 不提供成交均价, 仅最新价 + 变动股数, 这是粗略市值代理.
   * 真实公告日价格在回测期内不可得, 此代理用作横截面排序 / 量级判断,
   * 不要做精确金额报表.
   */
  trade_amount: number | null;
  /** 最新价 (元, 用于回算 trade_amount) */
  latest_price: number | null;
  /** 占总股本比例 (%) */
  pct_of_total_shares: number | null;
  /** 占流通股比例 (%) */
  pct_of_float_shares: number | null;
  /** 变动后持股总数 (股) */
  post_hold_shares: number | null;
  /** 变动开始日 ISO YYYY-MM-DD (可为 null) */
  change_start_date: string | null;
  /** 变动截止日 ISO YYYY-MM-DD (可为 null) */
  change_end_date: string | null;
  /** 原始 AKShare 行 (保留所有字段, 便于事后回溯) */
  raw_payload: Record<string, unknown>;
}

export type ShareholderTradeSymbol = '全部' | '股东增持' | '股东减持';

export class ShareholderTradeClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `ShareholderTradeClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取股东增减持公告全快照.
   *
   * @param symbol 增减方向过滤, 默认 '全部' 一次性入库 (按 trade_direction 列分流查询).
   */
  async fetchSnapshot(symbol: ShareholderTradeSymbol = '全部'): Promise<ShareholderTradeRow[]> {
    try {
      logger.info(`Fetching shareholder trade snapshot (symbol=${symbol})`);
      const rows = (await this.callPythonScript('get_shareholder_trade', symbol)) as
        | ShareholderTradeRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Shareholder trade snapshot (symbol=${symbol}): ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(
        `Failed to fetch shareholder trade snapshot (symbol=${symbol}): ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * 调用 Python 助手脚本 (与 EarningsForecastClient / RestrictedShareClient 同款契约 JSON: {success, data}).
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.SHAREHOLDER_TRADE_TIMEOUT_MS || 240_000);
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

export const shareholderTradeClient = new ShareholderTradeClient();
