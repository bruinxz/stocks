import React, { useMemo } from 'react';
import { Tabs } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  BranchesOutlined,
  ExperimentOutlined,
  FundProjectionScreenOutlined,
  LineChartOutlined,
  SlidersOutlined,
} from '@ant-design/icons';
import AutonomousOptimizationLab from './AutonomousOptimizationLab';
import RecommendationLoopPolicies from './RecommendationLoopPolicies';
import StrategyExperimentLab from './StrategyExperimentLab';
import QuantStrategyLibrary from './QuantStrategyLibrary';
import Strategy from './Strategy';

const tabPathMap: Record<string, string> = {
  optimization: '/strategy-research/optimization',
  versions: '/strategy-research/versions',
  experiments: '/strategy-research/experiments',
  weights: '/strategy-research/weights',
  eventResults: '/strategy-research/event-results',
};

const StrategyResearchCenter: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const activeKey = useMemo(() => {
    if (location.pathname.includes('/strategy-research/versions')) return 'versions';
    if (location.pathname.includes('/strategy-research/experiments')) return 'experiments';
    if (location.pathname.includes('/strategy-research/weights')) return 'weights';
    if (location.pathname.includes('/strategy-research/event-results')) return 'eventResults';
    return 'optimization';
  }, [location.pathname]);

  return (
    <div className="strategy-research-center-page">
      <Tabs
        activeKey={activeKey}
        onChange={key => navigate(tabPathMap[key] || '/strategy-research/optimization')}
        className="strategy-research-tabs"
        items={[
          {
            key: 'optimization',
            label: (
              <span>
                <FundProjectionScreenOutlined /> 优化建议
              </span>
            ),
            children: <AutonomousOptimizationLab />,
          },
          {
            key: 'versions',
            label: (
              <span>
                <BranchesOutlined /> 参数版本
              </span>
            ),
            children: <RecommendationLoopPolicies />,
          },
          {
            key: 'experiments',
            label: (
              <span>
                <ExperimentOutlined /> 策略实验
              </span>
            ),
            children: <StrategyExperimentLab />,
          },
          {
            key: 'weights',
            label: (
              <span>
                <SlidersOutlined /> 策略权重
              </span>
            ),
            children: <QuantStrategyLibrary />,
          },
          {
            key: 'eventResults',
            label: (
              <span>
                <LineChartOutlined /> 事件策略榜
              </span>
            ),
            children: <Strategy />,
          },
        ]}
      />
    </div>
  );
};

export default StrategyResearchCenter;
