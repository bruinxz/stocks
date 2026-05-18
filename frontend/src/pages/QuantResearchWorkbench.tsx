import React, { useMemo } from 'react';
import { Tabs } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { DashboardOutlined, ExperimentOutlined, ThunderboltOutlined } from '@ant-design/icons';
import QuantPerformanceDashboard from './QuantPerformanceDashboard';
import QuantSignalPool from './QuantSignalPool';
import QuantBacktestLab from './QuantBacktestLab';

const tabPathMap: Record<string, string> = {
  dashboard: '/quant/dashboard',
  signals: '/quant/signals',
  backtests: '/quant/backtests',
};

const QuantResearchWorkbench: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const activeKey = useMemo(() => {
    if (location.pathname.includes('/quant/dashboard')) return 'dashboard';
    if (location.pathname.includes('/quant/backtests')) return 'backtests';
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
            key: 'dashboard',
            label: (
              <span>
                <DashboardOutlined /> 收益驾驶舱
              </span>
            ),
            children: <QuantPerformanceDashboard />,
          },
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
        ]}
      />
    </div>
  );
};

export default QuantResearchWorkbench;
