/**
 * GlobalPortfolioSelector (2026-06-17 创建) — 顶层导航栏的选盘下拉.
 *
 * 用法: 放在 App.tsx Header 里, 任何已登录用户全屏显示. 切盘会触发所有
 * `usePortfolio()` 消费者的重渲染.
 *
 * 仅当 portfolios.length > 1 显示下拉; 只有 1 个 portfolio 时不显示 (避免噪声).
 */
import React from 'react';
import { Select, Tag, Tooltip } from 'antd';
import { WalletOutlined } from '@ant-design/icons';
import { usePortfolio } from '../../contexts/PortfolioContext';

const GlobalPortfolioSelector: React.FC = () => {
  const { portfolios, selectedPortfolioId, setSelectedPortfolioId, loading } = usePortfolio();

  if (loading && portfolios.length === 0) return null;
  if (portfolios.length === 0) return null;

  // 单盘场景不显示 dropdown, 显示一个 Tag 提示
  if (portfolios.length === 1) {
    const only = portfolios[0];
    const stratCount = only.strategy_display?.length ?? only.strategy_keys?.length ?? 0;
    const factorCount = only.factor_display?.length ?? only.enabled_factors?.length ?? 0;
    return (
      <Tooltip
        title={
          <span>
            当前盘: {only.name}
            {stratCount > 0 || factorCount > 0 ? ` · ${stratCount} 策略 / ${factorCount} 因子` : ''}
            {only.auto_trade_enabled ? ' · 自动跟单 ON' : ''}
          </span>
        }
      >
        <Tag icon={<WalletOutlined />} color="default" style={{ marginRight: 0 }}>
          {only.name}
          {stratCount > 0 || factorCount > 0 ? (
            <span style={{ marginLeft: 6, opacity: 0.7, fontSize: 11 }}>
              ({stratCount}策略/{factorCount}因子)
            </span>
          ) : null}
        </Tag>
      </Tooltip>
    );
  }

  return (
    <Select
      style={{ minWidth: 340 }}
      value={selectedPortfolioId}
      onChange={setSelectedPortfolioId}
      placeholder="选择模拟盘"
      size="middle"
      suffixIcon={<WalletOutlined />}
      options={portfolios.map(p => {
        const stratCount = p.strategy_display?.length ?? p.strategy_keys?.length ?? 0;
        const factorCount = p.factor_display?.length ?? p.enabled_factors?.length ?? 0;
        const meta =
          stratCount > 0 || factorCount > 0 ? ` · ${stratCount}策略/${factorCount}因子` : '';
        const auto = p.auto_trade_enabled ? ' · 🟣自动' : '';
        return {
          value: p.id,
          label: `${p.name} · ${p.position_count ?? (p as any).positions_count ?? 0} 持仓 · ¥${Number(
            p.total_value
          ).toLocaleString(undefined, { maximumFractionDigits: 0 })}${meta}${auto}`,
        };
      })}
    />
  );
};

export default GlobalPortfolioSelector;
