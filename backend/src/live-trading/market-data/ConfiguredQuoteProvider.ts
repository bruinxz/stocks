import { LiveMarketDataProvider, LiveQuoteSnapshot } from './LiveMarketDataProvider';

function normalizeSymbol(symbol: string): string {
  const value = String(symbol || '').trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(value)) return value;
  if (/^(SH|SZ|BJ)\.\d{6}$/.test(value)) {
    const [market, code] = value.split('.');
    return `${code}.${market}`;
  }
  if (/^(SH|SZ|BJ)\d{6}$/.test(value)) return `${value.slice(2)}.${value.slice(0, 2)}`;
  if (/^\d{6}$/.test(value)) {
    const prefix = value.startsWith('6') ? 'SH' : value.startsWith('8') || value.startsWith('4') ? 'BJ' : 'SZ';
    return `${value}.${prefix}`;
  }
  return value;
}

function toNumber(value: any): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function diffSeconds(date?: Date): number | undefined {
  if (!date) return undefined;
  const time = new Date(date).getTime();
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, Math.round((Date.now() - time) / 1000));
}

function splitPath(path: string): string[] {
  return String(path || '')
    .split('.')
    .map(item => item.trim())
    .filter(Boolean);
}

function getByPath(source: any, path?: string): any {
  if (!path) return undefined;
  let value = source;
  for (const key of splitPath(path)) {
    if (value === undefined || value === null) return undefined;
    value = value[key];
  }
  return value;
}

function parseQuoteTime(value: any): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export class ConfiguredQuoteProvider implements LiveMarketDataProvider {
  getProviderInfo() {
    return {
      provider_key: process.env.LIVE_LICENSED_QUOTE_PROVIDER_KEY || 'configured_quote_provider',
      provider_name: process.env.LIVE_LICENSED_QUOTE_PROVIDER_NAME || '可配置授权行情源',
      realtime_supported: true,
      licensed_for_external_use: String(process.env.LIVE_LICENSED_QUOTE_AUTHORIZED || '').toLowerCase() === 'true',
      notes: [
        '通过 LIVE_LICENSED_QUOTE_URL_TEMPLATE 配置外部授权行情接口。',
        '该 Provider 默认不启用；只有配置 URL 与授权声明后才参与对比。',
        '返回字段可用 LIVE_LICENSED_QUOTE_FIELD_* 环境变量映射。',
      ],
    };
  }

  isConfigured(): boolean {
    return Boolean(process.env.LIVE_LICENSED_QUOTE_URL_TEMPLATE);
  }

  async getQuote(symbol: string): Promise<LiveQuoteSnapshot | null> {
    if (!this.isConfigured()) return null;
    const normalized = normalizeSymbol(symbol);
    const url = String(process.env.LIVE_LICENSED_QUOTE_URL_TEMPLATE || '')
      .replace(/\{symbol\}/g, encodeURIComponent(normalized))
      .replace(/\{code\}/g, encodeURIComponent(normalized.slice(0, 6)));
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (process.env.LIVE_LICENSED_QUOTE_API_KEY) {
      headers[process.env.LIVE_LICENSED_QUOTE_API_KEY_HEADER || 'Authorization'] =
        process.env.LIVE_LICENSED_QUOTE_API_KEY_PREFIX
          ? `${process.env.LIVE_LICENSED_QUOTE_API_KEY_PREFIX}${process.env.LIVE_LICENSED_QUOTE_API_KEY}`
          : process.env.LIVE_LICENSED_QUOTE_API_KEY;
    }
    const timeoutMs = Math.max(Number(process.env.LIVE_LICENSED_QUOTE_TIMEOUT_MS || 3000), 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
      }
      const json = text ? JSON.parse(text) : {};
      const dataRoot = process.env.LIVE_LICENSED_QUOTE_FIELD_ROOT
        ? getByPath(json, process.env.LIVE_LICENSED_QUOTE_FIELD_ROOT)
        : json?.data || json;
      const price = toNumber(
        getByPath(dataRoot, process.env.LIVE_LICENSED_QUOTE_FIELD_PRICE || 'current_price') ??
          getByPath(dataRoot, 'price')
      );
      const quoteTime = parseQuoteTime(
        getByPath(dataRoot, process.env.LIVE_LICENSED_QUOTE_FIELD_TIME || 'quote_time') ??
          getByPath(dataRoot, 'time')
      );
      return {
        symbol: String(getByPath(dataRoot, process.env.LIVE_LICENSED_QUOTE_FIELD_SYMBOL || 'symbol') || normalized),
        name: getByPath(dataRoot, process.env.LIVE_LICENSED_QUOTE_FIELD_NAME || 'name'),
        current_price: price,
        change_percent: toNumber(
          getByPath(dataRoot, process.env.LIVE_LICENSED_QUOTE_FIELD_CHANGE_PERCENT || 'change_percent')
        ),
        turnover: toNumber(getByPath(dataRoot, process.env.LIVE_LICENSED_QUOTE_FIELD_TURNOVER || 'turnover')),
        volume: toNumber(getByPath(dataRoot, process.env.LIVE_LICENSED_QUOTE_FIELD_VOLUME || 'volume')),
        quote_time: quoteTime,
        source: this.getProviderInfo().provider_key,
        latency_seconds: diffSeconds(quoteTime),
        is_realtime: Boolean(quoteTime && diffSeconds(quoteTime)! <= 60),
        raw_payload: { provider: this.getProviderInfo().provider_key, payload: json },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async getQuotes(symbols: string[]): Promise<LiveQuoteSnapshot[]> {
    const unique = [...new Set((symbols || []).map(normalizeSymbol).filter(Boolean))].slice(0, 50);
    const results: LiveQuoteSnapshot[] = [];
    for (const symbol of unique) {
      try {
        const quote = await this.getQuote(symbol);
        if (quote) results.push(quote);
      } catch {
        // 单个外部行情失败不应拖垮 readiness；由健康检查展示缺口/风险。
      }
    }
    return results;
  }
}
