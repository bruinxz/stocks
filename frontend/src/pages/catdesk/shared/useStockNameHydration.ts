import { useEffect, useMemo, useState } from 'react';
import api from '../../../services/api';

type NamedSymbol = {
  symbol: string;
  name: string;
  market?: string;
};

const stockNameCache = new Map<string, string>();
const ALWAYS_HYDRATE = () => true;

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

export function useStockNameHydration<T extends NamedSymbol>(
  rows: T[],
  shouldHydrate: (row: T) => boolean = ALWAYS_HYDRATE
): T[] {
  const [names, setNames] = useState<Record<string, string>>({});
  const missingSymbols = useMemo(
    () =>
      Array.from(
        new Set(
          rows.filter(row => shouldHydrate(row) && needsHydration(row)).map(row => row.symbol)
        )
      ),
    [rows, shouldHydrate]
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const found: Record<string, string> = {};
      await Promise.all(
        missingSymbols.map(async symbol => {
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
            }
          } catch {
            // Keep the contract ticker visible when the stock directory is unavailable.
          }
        })
      );
      if (!cancelled && Object.keys(found).length) {
        setNames(current => {
          const changed = Object.entries(found).some(([symbol, name]) => current[symbol] !== name);
          return changed ? { ...current, ...found } : current;
        });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [missingSymbols]);

  return useMemo(
    () => rows.map(row => (names[row.symbol] ? { ...row, name: names[row.symbol] } : row)),
    [names, rows]
  );
}
