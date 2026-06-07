import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * BlackSwan 数据客户端 — US-053.
 *
 * 包装三组 AKShare 端点提供 BlackSwanWatchdog 所需的当日"黑天鹅候选"输入：
 *
 *   1. `stock_zh_a_st_em()`     — 当前 A 股 ST / *ST 列表（风险警示板快照）；
 *   2. `stock_zh_a_stop_em()`   — 当前 A 股停牌列表；
 *   3. `stock_news_em(symbol)`  — 个股最近新闻（≤100 条，最新在前）。
 *
 * ── AC 端点替代说明 (US-034 / US-035 替代范式) ──
 *
 * AC 提到的 `stock_news_main_cx_em` 在 AKShare 中**不存在**（命名是空架子；
 * 实际函数是 `stock_news_main_cx` 返回**整门户的周刊摘要**，不是按股票筛选）。
 * 正确的 per-stock 新闻端点是 `stock_news_em(symbol=6-digit)` —— 选用该端点
 * 替代后，关键词扫描（'立案' / '退市' / '重大违规' 等）仍能精准触发到目标股票。
 *
 * 替代记录的 4 处同步标注（同 US-034 范式）：
 *   - Python helper `get_stock_news_em` docstring 顶部；
 *   - 本 Client 类的 jsdoc（即本段）；
 *   - BlackSwanSyncService 顶部 jsdoc；
 *   - 模型 BlackSwanEvent comment（`source` 字段值 'NEWS' 说明读自 `stock_news_em`）。
 *
 * 与 ShareholderCountClient / EastMoneyQAClient (US-035 / US-034) 同款 per-stock
 * 历史时间线 pattern。`fetchSTList()` / `fetchSuspendedList()` 是无参 snapshot 端点；
 * `fetchStockNews(stockCode, limit?)` 是 per-stock 时间线端点。
 */

/** 单条 ST / 风险警示行情快照行。 */
export interface STStockRow {
  /** 6 位股票代码（无后缀）。 */
  stock_code: string;
  /** 股票名称（含 ST / *ST 前缀，如 'ST 长生'）。 */
  stock_name: string | null;
  /** 最新价。 */
  latest_price: number | null;
  /** 当日涨跌幅 (%)。 */
  change_pct: number | null;
  /** 原始 AKShare 行。 */
  raw_payload: Record<string, unknown>;
}

/** 单条停牌股票快照行。 */
export interface SuspendedStockRow {
  /** 6 位股票代码（无后缀）。 */
  stock_code: string;
  /** 股票名称。 */
  stock_name: string | null;
  /** 停牌前最后价格。 */
  latest_price: number | null;
  /** 停牌前最后涨跌幅 (%)。 */
  change_pct: number | null;
  /** 原始 AKShare 行。 */
  raw_payload: Record<string, unknown>;
}

/** 单条新闻头条。 */
export interface StockNewsRow {
  /** 新闻标题。 */
  title: string;
  /** 新闻正文 / 摘要（可能为 null）。 */
  content: string | null;
  /** 发布时间 ISO 字符串 'YYYY-MM-DD HH:mm:ss'（或 AKShare 原始格式）。 */
  publish_time: string | null;
  /** 来源（如 '证券时报网' / '财联社'）。 */
  source: string | null;
  /** 文章 URL（可能为 null）。 */
  url: string | null;
  /** 原始 AKShare 行。 */
  raw_payload: Record<string, unknown>;
}

export class BlackSwanClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `BlackSwanClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`
    );
  }

  /**
   * 拉取当前全市场 ST / *ST 列表（无参 snapshot）。底层 Python error 返回 []
   * （让 watchdog 按 "今日无新增 ST" 处理，不抛崩 cron）。
   */
  async fetchSTList(): Promise<STStockRow[]> {
    try {
      logger.info('Fetching A-share ST stock list');
      const rows = (await this.callPythonScript('get_st_stocks')) as STStockRow[] | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`ST stocks: ${count}`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch ST stocks: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 拉取当前全市场停牌股票列表（无参 snapshot）。
   */
  async fetchSuspendedList(): Promise<SuspendedStockRow[]> {
    try {
      logger.info('Fetching A-share suspended stock list');
      const rows = (await this.callPythonScript('get_suspended_stocks')) as
        | SuspendedStockRow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Suspended stocks: ${count}`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch suspended stocks: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 拉取指定股票最近 N 条新闻（默认 100，按 publish_time DESC 排序）。
   *
   * @param stockCode 6 位股票代码（无后缀）
   * @param limit max 行数（默认 100；guard 仅取近 24-48h 内的）
   */
  async fetchStockNews(stockCode: string, limit = 100): Promise<StockNewsRow[]> {
    try {
      const cleaned = String(stockCode).trim();
      if (!/^\d{6}$/.test(cleaned)) {
        logger.warn(`BlackSwanClient: invalid stock_code format: ${stockCode}`);
        return [];
      }
      const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 1000 ? limit : 100;
      logger.info(`Fetching stock news for ${cleaned} (limit=${safeLimit})`);
      const rows = (await this.callPythonScript(
        'get_stock_news_em',
        cleaned,
        String(safeLimit)
      )) as StockNewsRow[] | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Stock news rows for ${cleaned}: ${count}`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch stock_news_em for ${stockCode}: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 与 ShareholderCountClient / EastMoneyQAClient 同款契约：JSON `{success, data}`。
   * 默认 timeout 90s；可通过 `BLACKSWAN_TIMEOUT_MS` 环境变量覆写。
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeoutMs = Number(process.env.BLACKSWAN_TIMEOUT_MS) || 90_000;
      const proc = spawn(this.pythonPath, [this.scriptPath, command, ...args]);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
        reject(new Error(`BlackSwanClient ${command} timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (timedOut) return;
        if (code !== 0) {
          logger.warn(`BlackSwanClient.${command} exit=${code} stderr=${stderr}`);
          reject(
            new Error(`BlackSwanClient ${command} exit code ${code}: ${stderr.slice(0, 200)}`)
          );
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && parsed.success && Array.isArray(parsed.data)) {
            resolve(parsed.data);
          } else if (parsed && parsed.success && parsed.data === null) {
            resolve(null);
          } else {
            // 不 throw — caller 兜底成 []
            logger.warn(
              `BlackSwanClient.${command} returned non-success payload: ${JSON.stringify(
                parsed
              ).slice(0, 200)}`
            );
            resolve(null);
          }
        } catch (e) {
          reject(new Error(`BlackSwanClient ${command} parse error: ${(e as Error).message}`));
        }
      });
      proc.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

/** Singleton instance for production use. */
export const blackSwanClient = new BlackSwanClient();
