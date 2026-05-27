import React, { useMemo } from 'react';
import { Button, Card, Col, Row, Space, Tabs, Tag, Typography } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRightOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  SlidersOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import QuantPerformanceDashboard from './QuantPerformanceDashboard';
import QuantSignalPool from './QuantSignalPool';
import QuantBacktestLab from './QuantBacktestLab';
import QuantStrategyLibrary from './QuantStrategyLibrary';
import StrategyExperimentLab from './StrategyExperimentLab';

const { Text } = Typography;

const tabPathMap: Record<string, string> = {
  dashboard: '/quant/dashboard',
  overview: '/quant/research',
  signals: '/quant/signals',
  strategies: '/quant/strategies',
  backtests: '/quant/backtests',
  experiments: '/quant/experiments',
};

const researchSteps = [
  {
    key: 'signals',
    title: '先看机会池',
    desc: '看今天自动筛出的股票、推荐方向、融合分和风控阻断原因。',
    tag: '决策入口',
  },
  {
    key: 'strategies',
    title: '再看策略库',
    desc: '确认哪些指标/策略正在启用，权重、预算和过滤条件是否合理。',
    tag: '策略配置',
  },
  {
    key: 'backtests',
    title: '然后做跑分',
    desc: '用历史区间验证收益、回撤、胜率和交易样本，支持失败重试。',
    tag: '历史验证',
  },
  {
    key: 'experiments',
    title: '最后沉淀参数',
    desc: '把策略版本和参数实验沉淀为下一次开盘扫描可复用的候选。',
    tag: '闭环优化',
  },
];

const QuantResearchWorkbench: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const activeKey = useMemo(() => {
    if (location.pathname.includes('/quant/dashboard')) return 'dashboard';
    if (location.pathname.includes('/quant/strategies')) return 'strategies';
    if (location.pathname.includes('/quant/backtests')) return 'backtests';
    if (location.pathname.includes('/quant/signals')) return 'signals';
    if (location.pathname.includes('/quant/experiments')) return 'experiments';
    return 'overview';
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
                <DashboardOutlined /> 量化总览
              </span>
            ),
            children: <QuantPerformanceDashboard />,
          },
          {
            key: 'overview',
            label: (
              <span>
                <ArrowRightOutlined /> 研究路径
              </span>
            ),
            children: (
              <div className="quant-workbench-start fade-in-up">
                <div className="quant-workbench-start-hero">
                  <div>
                    <div className="quant-research-kicker">QUANT RESEARCH WORKBENCH</div>
                    <h1>一个工作台完成量化研究</h1>
                    <p>
                      原来分散在信号池、策略库、跑分验证、参数实验里的功能统一收拢到这里。
                      操作顺序很简单：先判断今天有没有机会，再验证策略是否真实有效，最后把表现好的参数沉淀到自动荐股链路。
                    </p>
                    <Space wrap>
                      <Tag color="blue">不删除旧路由</Tag>
                      <Tag color="green">功能集中</Tag>
                      <Tag color="gold">减少左侧导航干扰</Tag>
                    </Space>
                  </div>
                  <div className="quant-workbench-start-verdict">
                    <span>建议阅读顺序</span>
                    <strong>机会 → 策略 → 跑分 → 参数</strong>
                    <em>日常只看「量化总览」和「机会池」即可，研究时再展开后两步。</em>
                  </div>
                </div>
                <Row gutter={[14, 14]}>
                  {researchSteps.map(step => (
                    <Col xs={24} md={12} xl={6} key={step.key}>
                      <Card className="modern-card quant-workbench-step-card" variant="borderless">
                        <Tag>{step.tag}</Tag>
                        <strong>{step.title}</strong>
                        <Text type="secondary">{step.desc}</Text>
                        <Button
                          type="link"
                          onClick={() => navigate(tabPathMap[step.key])}
                          icon={<ArrowRightOutlined />}
                        >
                          进入
                        </Button>
                      </Card>
                    </Col>
                  ))}
                </Row>
              </div>
            ),
          },
          {
            key: 'signals',
            label: (
              <span>
                <ThunderboltOutlined /> 机会池
              </span>
            ),
            children: <QuantSignalPool />,
          },
          {
            key: 'strategies',
            label: (
              <span>
                <SlidersOutlined /> 策略库
              </span>
            ),
            children: <QuantStrategyLibrary />,
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
            key: 'experiments',
            label: (
              <span>
                <ExperimentOutlined /> 参数实验
              </span>
            ),
            children: <StrategyExperimentLab />,
          },
        ]}
      />
    </div>
  );
};

export default QuantResearchWorkbench;
