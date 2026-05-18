import React, { useMemo } from 'react';
import { Tabs } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  FundProjectionScreenOutlined,
  NodeIndexOutlined,
  RadarChartOutlined,
  ReadOutlined,
} from '@ant-design/icons';
import RecommendationTradeOutcomes from './RecommendationTradeOutcomes';
import RecommendationPerformance from './RecommendationPerformance';
import AgentTailAlphaLedger from './AgentTailAlphaLedger';
import TradingJournal from './TradingJournal';

const tabPathMap: Record<string, string> = {
  trades: '/review/trades',
  performance: '/review/performance',
  tail: '/review/agent-tail',
  journal: '/review/journal',
};

const ReviewCenter: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const activeKey = useMemo(() => {
    if (location.pathname.includes('/review/performance')) return 'performance';
    if (location.pathname.includes('/review/agent-tail')) return 'tail';
    if (location.pathname.includes('/review/journal')) return 'journal';
    return 'trades';
  }, [location.pathname]);

  return (
    <div className="review-center-page">
      <Tabs
        activeKey={activeKey}
        onChange={key => navigate(tabPathMap[key] || '/review/trades')}
        className="review-center-tabs"
        items={[
          {
            key: 'trades',
            label: (
              <span>
                <NodeIndexOutlined /> 交易闭环
              </span>
            ),
            children: <RecommendationTradeOutcomes />,
          },
          {
            key: 'performance',
            label: (
              <span>
                <FundProjectionScreenOutlined /> 信号绩效
              </span>
            ),
            children: <RecommendationPerformance />,
          },
          {
            key: 'tail',
            label: (
              <span>
                <RadarChartOutlined /> Agent尾盘
              </span>
            ),
            children: <AgentTailAlphaLedger />,
          },
          {
            key: 'journal',
            label: (
              <span>
                <ReadOutlined /> 交易日记
              </span>
            ),
            children: <TradingJournal />,
          },
        ]}
      />
    </div>
  );
};

export default ReviewCenter;
