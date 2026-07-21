import React, { useMemo } from 'react';
import { RobotOutlined } from '@ant-design/icons';
import WorkspaceLayout from '../../components/layout/WorkspaceLayout';
import WorkspaceHero from '../../components/layout/WorkspaceHero';
import AIAnalysisLauncher from '../../components/trading/AIAnalysisLauncher';

const AIAnalysisWorkspace: React.FC = () => {
  const hero = useMemo(
    () => (
      <WorkspaceHero
        eyebrow="AI · 智能解读"
        title="AI 决策测算"
        subtitle="给一只股票：TradingAgents 做研究，当前行情把结论落到买点、卖点与风险线"
        variant="violet"
        rightSlot={
          <div className="ai-analysis-hero-icon" aria-hidden>
            <RobotOutlined />
          </div>
        }
      />
    ),
    []
  );

  return (
    <WorkspaceLayout
      title="AI 决策测算"
      subtitle="研究结论与价格计划分层呈现；不会自动下单，也不承诺收益。"
      hero={hero}
      themed
    >
      <AIAnalysisLauncher />
    </WorkspaceLayout>
  );
};

export default AIAnalysisWorkspace;
