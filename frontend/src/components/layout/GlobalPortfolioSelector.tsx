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
    return (
      <Tooltip title={`当前盘: ${only.name}`}>
        <Tag icon={<WalletOutlined />} color="default" style={{ marginRight: 0 }}>
          {only.name}
        </Tag>
      </Tooltip>
    );
  }

  return (
    <Select
      style={{ minWidth: 300 }}
      value={selectedPortfolioId}
      onChange={setSelectedPortfolioId}
      placeholder="选择模拟盘"
      size="middle"
      suffixIcon={<WalletOutlined />}
      options={portfolios.map(p => ({
        value: p.id,
        label: `${p.name} · ${p.positions_count} 持仓 · ¥${Number(p.total_value).toLocaleString(
          undefined,
          { maximumFractionDigits: 0 }
        )}`,
      }))}
    />
  );
};

export default GlobalPortfolioSelector;
