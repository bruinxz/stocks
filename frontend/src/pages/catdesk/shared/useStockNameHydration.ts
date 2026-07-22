import { useEffect, useMemo, useState } from 'react';
import api from '../../../services/api';

type NamedSymbol = {
  symbol: string;
  name: string;
  market?: string;
};

const stockNameCache = new Map<string, string>();
const ALWAYS_HYDRATE = () => true;

export interface StockNameHydrationState<T> {
  rows: T[];
  /** 首次名称目录查询完成前保持 true，调用方可避免先渲染代码再替换成名称。 */
  loading: boolean;
}

function stockCode(symbol: string): string {
  const match = symbol.match(/\d{6}/);
  return match?.[0] ?? symbol;
}

function expectedExchange(symbol: string): string | null {
  const normalized = symbol.toLocaleLowerCase('en-US');
  if (normalized.startsWith('sh.') || normalized.endsWith('.sh')) return 'sh';
  if (normalized.startsWith('sz.') || normalized.endsWith('.sz')) return 'sz';
  if (normalized.startsWith('bj.') || normalized.endsWith('.bj')) return 'bj';
  const code = stockCode(symbol);
  if (/^6/.test(code)) return 'sh';
  if (/^[03]/.test(code)) return 'sz';
  if (/^[489]/.test(code)) return 'bj';
  return null;
}

function needsHydration(row: NamedSymbol): boolean {
  return !row.name || row.name === row.symbol || row.name === stockCode(row.symbol);
}

export function useStockNameHydrationState<T extends NamedSymbol>(
  rows: T[],
  shouldHydrate: (row: T) => boolean = ALWAYS_HYDRATE
): StockNameHydrationState<T> {
  // null 表示已查过但目录中没有名称；这样失败时会稳定回退代码，不会无限重试/闪烁。
  const [lookups, setLookups] = useState<Record<string, string | null>>({});
  const missingSymbols = useMemo(
    () =>
      Array.from(
        new Set(
          rows.filter(row => shouldHydrate(row) && needsHydration(row)).map(row => row.symbol)
        )
      ),
    [rows, shouldHydrate]
  );
  const pendingSymbols = useMemo(
    () =>
      missingSymbols.filter(
        symbol =>
          !stockNameCache.has(symbol) &&
          !Object.prototype.hasOwnProperty.call(lookups, symbol)
      ),
    [lookups, missingSymbols]
  );

  useEffect(() => {
    if (!pendingSymbols.length) return;
    let cancelled = false;
    const load = async () => {
      const found: Record<string, string | null> = {};
      await Promise.all(
        pendingSymbols.map(async symbol => {
          const cached = stockNameCache.get(symbol);
          if (cached) {
            found[symbol] = cached;
            return;
          }
          const code = stockCode(symbol);
          try {
            const response = await api.get('/stocks', {
              params: { page: 1, limit: 10, listedOnly: 'true', search: code },
            });
            const candidates: NamedSymbol[] = response.data?.data?.stocks ?? [];
            const exchange = expectedExchange(symbol);
            const exact = candidates.find(
              item =>
                stockCode(item.symbol) === code &&
                (!exchange || item.symbol.toLocaleLowerCase('en-US').startsWith(`${exchange}.`))
            );
            if (exact?.name) {
              stockNameCache.set(symbol, exact.name);
              found[symbol] = exact.name;
            } else {
              found[symbol] = null;
            }
          } catch {
            // Keep the contract ticker visible when the stock directory is unavailable.
            found[symbol] = null;
          }
        })
      );
      if (!cancelled) {
        setLookups(current => {
          const changed = Object.entries(found).some(([symbol, name]) => current[symbol] !== name);
          return changed ? { ...current, ...found } : current;
        });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [pendingSymbols]);

  const hydratedRows = useMemo(
    () =>
      rows.map(row => {
        const name = stockNameCache.get(row.symbol) || lookups[row.symbol];
        return name ? { ...row, name } : row;
      }),
    [lookups, rows]
  );

  return { rows: hydratedRows, loading: pendingSymbols.length > 0 };
}

export function useStockNameHydration<T extends NamedSymbol>(
  rows: T[],
  shouldHydrate: (row: T) => boolean = ALWAYS_HYDRATE
): T[] {
  return useStockNameHydrationState(rows, shouldHydrate).rows;
}
