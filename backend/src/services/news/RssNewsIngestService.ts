/**
 * RssNewsIngestService — 合规 RSS 财经新闻入库 (§6.1 主渠道: 新浪财经 / 财联社 RSS)
 *
 * 主线数据基础的一半 (另一半 = 公告, 已由 AnnouncementNLPService/sync-announcements 覆盖)。
 * 只吃**合规订阅源** (RSS/Atom), 不爬雪球/东财/同花顺, 不接付费终端 (§6.1 排除清单)。
 *
 * 链路:
 *   1. 逐个 RSS feed 拉 XML (axios, 超时 + UA)
 *   2. 极简正则解析 <item>/<entry> → { title, link, pubDate, description }
 *      (RSS 结构稳定, 不引第三方 xml 依赖, 避免供应链膨胀)
 *   3. matchTheme(title, summary) 关键词兜底打 industry 标签 (§6.1 卫星辅助; LLM 主路径由
 *      上层可选覆盖, 本服务只做确定性兜底)
 *   4. MarketNews.upsert (主键 publish_time + title_hash 幂等; 同标题不重复)
 *   5. 可选保留期清理: 删 publish_date < today-retentionDays 的行 (MarketNews 设计保留 30 天)
 *
 * 只写 market_news 表, 不产 AIInvestmentSignal (信号由题材探测器/fan-out 消费 news 后另行产出)。
 * 数据源 API 失败 → 记 data_update_logs (由调用方 SchedulerService 落), 单 feed 失败不影响其余 feed。
 */

import axios from 'axios';
import { createHash } from 'crypto';
import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { MarketNews } from '../../models/MarketNews';
import { matchTheme } from '../../constants/themeKeywordDict';

/** 一个 RSS 订阅源定义。source 落 MarketNews.source (STRING(40))。 */
export interface RssFeed {
  /** MarketNews.source 值 (cls/sina/em/...) */
  source: string;
  /** 人类可读名 (日志用) */
  name: string;
  /** RSS/Atom feed URL (或 JSON API 端点, 见 format) */
  url: string;
  /** MarketNews.category 默认值 */
  category?: string;
  /**
   * 抓取解析格式:
   *   'rss'       — 标准 RSS2.0/Atom XML (默认)
   *   'sina-roll' — 新浪滚动新闻 JSON API (feed.mix.sina.com.cn/api/roll/get)
   * 新浪公开 RSS 端点已停更/失效, 故主渠道走其官方滚动 JSON API (仍是公开合规接口, 非爬虫)。
   */
  format?: 'rss' | 'sina-roll';
}

/**
 * 默认合规订阅源 (§6.1 主渠道)。URL 可被 RSS_NEWS_FEEDS 环境变量 (JSON) 覆盖,
 * 便于运维在不改代码的前提下切换/增删源。这里只放**公开 RSS 端点**, 不含任何爬虫。
 */
export const DEFAULT_RSS_FEEDS: readonly RssFeed[] = Object.freeze([
  {
    source: 'sina',
    name: '新浪财经-国内财经滚动',
    url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=155&lid=1686&num=50&page=1',
    category: '财经',
    format: 'sina-roll',
  },
  {
    source: 'sina',
    name: '新浪财经-金融滚动',
    url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=155&lid=1690&num=50&page=1',
    category: '金融',
    format: 'sina-roll',
  },
]);

export interface RssItem {
  title: string;
  link?: string;
  pubDate?: string;
  description?: string;
}

export interface IngestFeedResult {
  source: string;
  name: string;
  fetched: number;
  created: number;
  updated: number;
  matched_theme: number;
  error?: string;
}

export interface IngestRunOptions {
  /** 覆盖 feed 列表 (默认 DEFAULT_RSS_FEEDS 或 RSS_NEWS_FEEDS env) */
  feeds?: RssFeed[];
  /** HTTP 超时 ms (默认 15000) */
  timeoutMs?: number;
  /** 保留天数; >0 时清理更早的 market_news (默认 30, 0=不清理) */
  retentionDays?: number;
  /** 干跑: 解析但不写库 */
  dryRun?: boolean;
}

export interface IngestRunResult {
  feeds: IngestFeedResult[];
  total_fetched: number;
  total_created: number;
  total_updated: number;
  total_matched_theme: number;
  purged: number;
  dry_run: boolean;
}

const UNESCAPE: Array<[RegExp, string]> = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&apos;/g, "'"],
  [/&amp;/g, '&'], // 必须最后, 否则重复解码
];

function decodeEntities(s: string): string {
  let out = s;
  for (const [re, ch] of UNESCAPE) out = out.replace(re, ch);
  return out;
}

/** 取 <tag>...</tag> 内容 (支持 CDATA), 无则空串。 */
function pick(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(xml);
  if (!m) return '';
  let v = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  if (cdata) v = cdata[1].trim();
  return decodeEntities(v).replace(/<[^>]+>/g, '').trim();
}

/** 极简 RSS2.0 / Atom 解析: 抓 <item> 或 <entry> 块。 */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const blockRe = /<(item|entry)[\s>][\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[0];
    const title = pick(block, 'title');
    if (!title) continue;
    const link = pick(block, 'link') || undefined;
    const pubDate = pick(block, 'pubDate') || pick(block, 'published') || pick(block, 'updated') || undefined;
    const description = pick(block, 'description') || pick(block, 'summary') || undefined;
    items.push({ title, link, pubDate, description });
  }
  return items;
}

/**
 * 解析新浪滚动新闻 JSON API 响应 → RssItem[]。
 * 结构: { result: { data: [ { title, url, ctime(秒级时间戳), intro/summary } ] } }
 */
export function parseSinaRoll(body: string): RssItem[] {
  const items: RssItem[] = [];
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    return items;
  }
  const data = json?.result?.data;
  if (!Array.isArray(data)) return items;
  for (const d of data) {
    const title = typeof d?.title === 'string' ? d.title.trim() : '';
    if (!title) continue;
    const link = typeof d?.url === 'string' ? d.url : undefined;
    // ctime 为秒级 unix 时间戳字符串
    const ctime = Number(d?.ctime);
    const pubDate = Number.isFinite(ctime) && ctime > 0 ? new Date(ctime * 1000).toISOString() : undefined;
    const description =
      (typeof d?.intro === 'string' && d.intro.trim()) ||
      (typeof d?.summary === 'string' && d.summary.trim()) ||
      undefined;
    items.push({ title, link, pubDate, description });
  }
  return items;
}

/** MD5(title.trim()) 前 16 位 — 与 MarketNews 主键口径一致。 */
function titleHash(title: string): string {
  return createHash('md5').update(title.trim()).digest('hex').slice(0, 16);
}

function parsePublishTime(pubDate?: string): Date {
  if (pubDate) {
    const d = new Date(pubDate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function toDateOnly(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export class RssNewsIngestService {
  private resolveFeeds(explicit?: RssFeed[]): RssFeed[] {
    if (explicit?.length) return explicit;
    const env = process.env.RSS_NEWS_FEEDS;
    if (env) {
      try {
        const parsed = JSON.parse(env);
        if (Array.isArray(parsed) && parsed.length) return parsed as RssFeed[];
      } catch (e: any) {
        logger.warn(`RSS_NEWS_FEEDS 解析失败, 回落默认源: ${e?.message || e}`);
      }
    }
    return [...DEFAULT_RSS_FEEDS];
  }

  private async fetchFeed(feed: RssFeed, timeoutMs: number): Promise<RssItem[]> {
    const resp = await axios.get<string>(feed.url, {
      timeout: timeoutMs,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; QuantXNewsBot/1.0; +compliance-rss-only)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml; q=0.9, */*; q=0.8',
      },
      // 4xx/5xx 抛错走 catch
    });
    const body = String(resp.data || '');
    return feed.format === 'sina-roll' ? parseSinaRoll(body) : parseRss(body);
  }

  private async persistItem(item: RssItem, feed: RssFeed): Promise<'created' | 'updated'> {
    const publishTime = parsePublishTime(item.pubDate);
    const hash = titleHash(item.title);
    const theme = matchTheme(item.title, item.description);
    const content = (item.description || '').slice(0, 4096) || undefined;
    const [, created] = await MarketNews.findOrCreate({
      where: { publish_time: publishTime, title_hash: hash },
      defaults: {
        title_hash: hash,
        publish_time: publishTime,
        publish_date: toDateOnly(publishTime),
        title: item.title.slice(0, 512),
        content,
        source: feed.source.slice(0, 40),
        category: feed.category?.slice(0, 50),
        url: item.link?.slice(0, 1000),
        raw_payload: {
          feed_name: feed.name,
          link: item.link,
          pub_date_raw: item.pubDate,
          theme_industry: theme?.industry ?? null,
          theme_keywords: theme?.matched_keywords ?? [],
        },
      } as any,
    });
    return created ? 'created' : 'updated';
  }

  async run(options: IngestRunOptions = {}): Promise<IngestRunResult> {
    const feeds = this.resolveFeeds(options.feeds);
    const timeoutMs = options.timeoutMs ?? 15000;
    const retentionDays = options.retentionDays ?? 30;
    const dryRun = Boolean(options.dryRun);

    const results: IngestFeedResult[] = [];
    for (const feed of feeds) {
      const r: IngestFeedResult = { source: feed.source, name: feed.name, fetched: 0, created: 0, updated: 0, matched_theme: 0 };
      try {
        const items = await this.fetchFeed(feed, timeoutMs);
        r.fetched = items.length;
        for (const it of items) {
          if (matchTheme(it.title, it.description)) r.matched_theme += 1;
          if (dryRun) continue;
          try {
            const kind = await this.persistItem(it, feed);
            if (kind === 'created') r.created += 1;
            else r.updated += 1;
          } catch (e: any) {
            logger.warn(`[RSS] 落库失败 (${feed.name}) title="${it.title.slice(0, 40)}": ${e?.message || e}`);
          }
        }
      } catch (e: any) {
        r.error = e?.message || String(e);
        logger.warn(`[RSS] feed 拉取失败 ${feed.name} (${feed.url}): ${r.error}`);
      }
      results.push(r);
    }

    let purged = 0;
    if (!dryRun && retentionDays > 0) {
      const cutoff = new Date(Date.now() - retentionDays * 86400_000);
      const cutoffDate = toDateOnly(cutoff);
      try {
        purged = await MarketNews.destroy({ where: { publish_date: { [Op.lt]: cutoffDate } } });
      } catch (e: any) {
        logger.warn(`[RSS] 保留期清理失败: ${e?.message || e}`);
      }
    }

    const sum = (f: (x: IngestFeedResult) => number) => results.reduce((a, x) => a + f(x), 0);
    return {
      feeds: results,
      total_fetched: sum(x => x.fetched),
      total_created: sum(x => x.created),
      total_updated: sum(x => x.updated),
      total_matched_theme: sum(x => x.matched_theme),
      purged,
      dry_run: dryRun,
    };
  }
}

export const rssNewsIngestService = new RssNewsIngestService();
