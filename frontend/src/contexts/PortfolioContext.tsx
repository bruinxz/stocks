/**
 * PortfolioContext (2026-06-17 创建) — 全局选盘状态.
 *
 * 解决问题: user 可能有 8 个 active Codex 模拟盘, 每个 workspace 各自维护 selector
 * 会导致认知不一致 (今日作战看 A 盘 / 持仓与复盘看 B 盘). 统一到顶层 Context 让
 * 任何 workspace 通过 `usePortfolio()` 拿到当前选盘 + 切盘 hook.
 *
 * 数据流:
 * 1. mount 时调 listPortfolios() 拉 active portfolio 列表
 * 2. selectedPortfolioId 持久化到 localStorage 'pt_selected_portfolio_id'
 * 3. 列表为空或当前 selected 不在列表里 → 自动选 list[0].id
 * 4. 任何 component 通过 usePortfolio() 拿: { portfolios, selectedPortfolioId, setSelectedPortfolioId, loading, refresh }
 *
 * 使用范本:
 *   const { selectedPortfolioId } = usePortfolio();
 *   const data = await getPortfolioLedger(selectedPortfolioId);
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  PortfolioListItem,
  listPortfolios as apiListPortfolios,
} from '../services/portfolioWorkspaceService';

const STORAGE_KEY = 'pt_selected_portfolio_id';

interface PortfolioContextValue {
  portfolios: PortfolioListItem[];
  selectedPortfolioId: number | undefined;
  setSelectedPortfolioId: (id: number) => void;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const PortfolioContext = createContext<PortfolioContextValue | null>(null);

function readStoredId(): number | undefined {
  if (typeof window === 'undefined') return undefined;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) return undefined;
  const parsed = Number(stored);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function writeStoredId(id: number | undefined) {
  if (typeof window === 'undefined') return;
  if (id === undefined) window.localStorage.removeItem(STORAGE_KEY);
  else window.localStorage.setItem(STORAGE_KEY, String(id));
}

export const PortfolioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [portfolios, setPortfolios] = useState<PortfolioListItem[]>([]);
  const [selectedPortfolioId, setSelectedPortfolioIdState] = useState<number | undefined>(() =>
    readStoredId()
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await apiListPortfolios();
      setPortfolios(list);
      // 如果当前 selectedId 不在 list 里 (重置 / portfolio 删除), 自动选 first.
      const storedId = readStoredId();
      const exists = storedId && list.some(p => p.id === storedId);
      if (!exists && list.length > 0) {
        const fallbackId = list[0].id;
        setSelectedPortfolioIdState(fallbackId);
        writeStoredId(fallbackId);
      } else if (exists) {
        // 保持 storedId; state 已是初值, 但同步确保 mount 后第一次 list 不会有 mismatch
        if (selectedPortfolioId !== storedId) {
          setSelectedPortfolioIdState(storedId);
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setSelectedPortfolioId = useCallback((id: number) => {
    setSelectedPortfolioIdState(id);
    writeStoredId(id);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <PortfolioContext.Provider
      value={{
        portfolios,
        selectedPortfolioId,
        setSelectedPortfolioId,
        loading,
        error,
        refresh,
      }}
    >
      {children}
    </PortfolioContext.Provider>
  );
};

export function usePortfolio(): PortfolioContextValue {
  const ctx = useContext(PortfolioContext);
  if (!ctx) {
    throw new Error('usePortfolio must be used within a PortfolioProvider');
  }
  return ctx;
}
