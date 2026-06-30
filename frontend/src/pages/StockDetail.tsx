import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import StockDetailPanel from '../components/stock/StockDetailPanel';

/**
 * /stock/:symbol 整页路由 — 直接复用 StockDetailPanel 组件。
 * DataWorkspace 'stocks' tab 也使用同一组件，但 compact + 不显示返回按钮。
 */
const StockDetail: React.FC = () => {
  const { symbol } = useParams<{ symbol: string }>();
  const navigate = useNavigate();

  return <StockDetailPanel symbol={symbol || ''} showBack onBack={() => navigate(-1)} showHeader />;
};

export default StockDetail;
