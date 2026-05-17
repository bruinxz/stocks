import React, { useMemo } from 'react';
import { Tabs } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { BranchesOutlined, ExperimentOutlined, ThunderboltOutlined } from '@ant-design/icons';
import QuantSignalPool from './QuantSignalPool';
import QuantBacktestLab from './QuantBacktestLab';
import QuantStrategyLibrary from './QuantStrategyLibrary';

const tabPathMap: Record<string, string> = {
  signals: '/quant/signals',
  backtests: '/quant/backtests',
  strategies: '/quant/strategies',
};

const QuantResearchWorkbench: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const activeKey = useMemo(() => {
    if (location.pathname.includes('/quant/backtests')) return 'backtests';
    if (location.pathname.includes('/quant/strategies')) return 'strategies';
    return 'signals';
  }, [location.pathname]);

  return (
    <div className="quant-workbench">
      <Tabs
        activeKey={activeKey}
        onChange={key => navigate(tabPathMap[key] || '/quant/signals')}
        className="quant-workbench-tabs"
        items={[
          {
            key: 'signals',
            label: (
              <span>
                <ThunderboltOutlined /> 今日机会
              </span>
            ),
            children: <QuantSignalPool />,
          },
          {
            key: 'backtests',
            label: (
              <span>
                <ExperimentOutlined /> 跑分验证
              </span>
            ),
            children: <QuantBacktestLab />,
          },
          {
            key: 'strategies',
            label: (
              <span>
                <BranchesOutlined /> 策略权重
              </span>
            ),
            children: <QuantStrategyLibrary />,
          },
        ]}
      />
    </div>
  );
};

export default QuantResearchWorkbench;
