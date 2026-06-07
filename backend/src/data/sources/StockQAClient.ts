import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger';

/**
 * StockQAClient — US-060 个股投资者问答 (EastMoney "东财问答" 数据源)
 *
 * ── AC endpoint substitution (US-034/US-035 同款范式) ──
 *
 * AC 文字提到 "东财问答" (东方财富股吧 Q&A); 但东方财富股吧在 AKShare 中
 * **无任何 per-stock Q&A endpoint**:
 *   - `stock_guba_em` 在 AKShare 中根本不存在 (US-034 已验证);
 *   - `stock_news_em` 只返回新闻不返回 Q&A;
 *   - 爬取 https://guba.eastmoney.com/list,<code>.html 反爬严格.
 *
 * **选定替代**: AKShare `stock_irm_cninfo(symbol=<6-digit>)`
 *     巨潮资讯 - 互动易 - 投资者问答
 *     https://irm.cninfo.com.cn/ircs/question/questionDetail
 *
 *   巨潮资讯互动易与东财股吧 **同属 "投资者-上市公司 Q&A" 领域**, 数据语义
 *   100% 对齐 (用户提问 → 公司回答, 关注话题域相同). 类名 / 表名 / API 命名
 *   保留 EastMoney 命名与 AC 一致, jsdoc 说明实际数据源.
 *
 * **升级路径**: 若未来 AKShare 提供真正的 `stock_guba_qa_em`, 直接换
 * Python helper 内 endpoint, TS Client / Service / Model 都不动.
 *
 * 与 EastMoneyQAClient (US-034 人气榜) / AnalystForecastClient (US-030 分析师研报) /
 * DividendHistoryClient (US-022 分红历史) 等 **per-stock 历史时间线 client** 同款:
 *   - per-stock sync: 一次拉一只 × 全部历史 (~300-2000 行);
 *   - 子进程返回 JSON {success, data}, 失败时返回 [] 不抛, 让 caller 继续 batch.
 */
export interface StockQARow {
  /** 6 位股票代码 (无后缀) */
  stock_code: string;
  /** 公司简称 (可空, 罕见缺失) */
  stock_name: string | null;
  /** 行业 (cninfo 一级分类, 如 "制造业") */
  industry: string | null;
  /** 用户提问原文 (必有) */
  question: string;
  /** 提问者标识 (irmXXXXXX) */
  questioner: string | null;
  /** 提问来源 ('网站' / 'APP' 等) */
  source: string | null;
  /** 提问时间 YYYY-MM-DD HH:mm:ss 字符串 */
  question_time: string;
  /** 问题编号 (cninfo 内唯一; 缺失时由 Python helper 用 hash 兜底) */
  question_id: string;
  /** 公司回答内容 (大多为 null — 多数提问未回答) */
  answer: string | null;
  /** 回答者标识 */
  answerer: string | null;
  /** 原始 AKShare 行 (便于事后回溯) */
  raw_payload: Record<string, unknown>;
}

export class StockQAClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(`StockQAClient initialized (python=${this.pythonPath}, script=${this.scriptPath})`);
  }

  /**
   * 拉取指定股票全部历史投资者问答 (按提问时间 desc, 已 dedup by question_id).
   *
   * @param stockCode 6 位股票代码 (无后缀)
   * @param limit    最多返回多少条 (默认无限制, 上限由 AKShare 决定; 推荐 200 以减少 NLP 成本)
   * @returns 问答行数组 (可能为空); Python error 时返回 [] 不抛
   */
  async fetchForStock(stockCode: string, limit?: number): Promise<StockQARow[]> {
    try {
      const cleaned = String(stockCode).trim();
      if (!/^\d{6}$/.test(cleaned)) {
        logger.warn(`StockQAClient: invalid stock_code format: ${stockCode}`);
        return [];
      }
      logger.info(`Fetching investor Q&A for stock=${cleaned} (limit=${limit ?? 'unbounded'})`);
      const args: string[] = [cleaned];
      if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
        args.push(String(Math.floor(limit)));
      }
      const rows = (await this.callPythonScript('get_stock_qa_topics', ...args)) as
        | StockQARow[]
        | null;
      const count = Array.isArray(rows) ? rows.length : 0;
      logger.info(`Stock QA for ${cleaned}: ${count} rows`);
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      logger.error(`Failed to fetch stock QA for ${stockCode}: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * 与 EastMoneyQAClient 同款契约: 子进程 stdout 返回 `{success, data}` JSON.
   * 默认 timeout 120s (per-stock 全量历史多数 < 5s; 极端慢 ~30s).
   * 可通过 `STOCK_QA_TIMEOUT_MS` 环境变量覆写.
   */
  private callPythonScript(command: string, ...args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const processArgs = [this.scriptPath, command, ...args];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = Number(process.env.STOCK_QA_TIMEOUT_MS || 120_000);
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

export const stockQAClient = new StockQAClient();
