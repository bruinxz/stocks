import React from 'react';
import AIAnalysisLauncher from '../../../components/trading/AIAnalysisLauncher';

export default function AIAnalysisDesk() {
  return (
    <section className="catdesk-ai-desk">
      <div className="catdesk-ai-desk__note">
        <span>本机 TradingAgents</span>
        <strong>把一只股票交给研究员、交易员与风控团队共同会审。</strong>
        <p>研究结论仅用于辅助判断；行情过期时不会生成可执行价格计划。</p>
      </div>
      <AIAnalysisLauncher compact taskLabel="catdesk_ai_analysis" />
    </section>
  );
}
