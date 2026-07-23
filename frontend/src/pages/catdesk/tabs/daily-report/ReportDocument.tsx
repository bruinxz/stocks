import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { EvidenceText } from './EvidenceText';
import { recommendationDisplayName } from './editorial';
import type { DailyReportDocument } from './types';
import {
  MARKET_SCOPE_LABELS,
  PROFILE_LABELS,
  RISK_GATE_LABELS,
  SIZE_HINT_LABELS,
} from '../../shared/uiLabels';

export interface ReportDocumentProps {
  report: DailyReportDocument;
  aShareOverview?: React.ReactNode;
  globalSummary?: React.ReactNode;
}

const REPORT_PROFILE_CODES: Record<string, string> = {
  us_preferred: 'SELECT',
  multibagger: 'MBG',
  japan_blue_chip: 'JPB',
  japan_multibagger: 'JPM',
  korea_semiconductor_chain: 'KSC',
  korea_multibagger: 'KRM',
};

const REPORT_MARKET_CODES: Record<string, string> = {
  cn_a: 'CNA',
  us: 'USA',
  jp: 'JPN',
  kr: 'KOR',
};

export function dailyReportNumber(report: DailyReportDocument): string {
  const day = report.trading_day.replace(/-/g, '');
  const market = REPORT_MARKET_CODES[report.snapshot.market_scope] ?? 'MKT';
  const profile = REPORT_PROFILE_CODES[report.snapshot.profile] ?? 'STRAT';
  return `${market}-${day}-${profile}`;
}

export function ReportDocument({ report, aShareOverview, globalSummary }: ReportDocumentProps) {
  return (
    <article className="report-document">
      <header className="report-document__header">
        <div>
          <span className="report-eyebrow">A 股深度主报告 · 推荐快照 0.3.1</span>
          <h2>A 股每日研究手记</h2>
        </div>
        <div className="report-document__edition">
          <span>{report.trading_day}</span>
          <small>第 {dailyReportNumber(report)} 号</small>
        </div>
      </header>

      {aShareOverview}

      <section className="recommendation-ledger" aria-label="A 股个股推荐证据清单">
        <header className="recommendation-ledger__header">
          <div>
            <span className="editorial-section-number">02</span>
            <h2>个股观察</h2>
          </div>
          <p>按综合评分排序；保留证据，但不把观察名单写成买入指令。</p>
        </header>
        {report.snapshot.items.map(item => {
          const recommendation = item.recommendation;
          const companyName = recommendationDisplayName(item);
          const topDims = [...recommendation.score.dims]
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);
          return (
            <article className="recommendation-card" key={recommendation.id}>
              <div className="recommendation-card__rank">
                <span>{item.rating_band}</span>
                <small>{recommendation.score.total.toFixed(1)}</small>
              </div>
              <div>
                <div className="recommendation-card__title">
                  <strong>{companyName}</strong>
                  <code>{recommendation.ticker}</code>
                  <span>
                    {topDims.map(dimension => `${dimension.key} ${dimension.score}`).join(' · ')}
                  </span>
                </div>
                <p>
                  <EvidenceText
                    body={recommendation.explanation.body}
                    evidenceRefs={recommendation.evidence_refs}
                  />
                </p>
                <div className="recommendation-card__meta">
                  <span>确信度 {recommendation.conviction.final}</span>
                  <span>
                    风险{' '}
                    {RISK_GATE_LABELS[recommendation.risk_gate.gate] ??
                      recommendation.risk_gate.gate}
                  </span>
                  <span>
                    仓位{' '}
                    {SIZE_HINT_LABELS[recommendation.entry_plan.size_hint.tier] ??
                      recommendation.entry_plan.size_hint.tier}
                  </span>
                </div>
              </div>
            </article>
          );
        })}
      </section>

      {globalSummary}

      <details className="report-methodology">
        <summary>查看证据账本与版本锚点</summary>
        <div className="report-document__pins" aria-label="报告版本锚点">
          <code>{PROFILE_LABELS[report.snapshot.profile] ?? report.snapshot.profile}</code>
          <code>
            {MARKET_SCOPE_LABELS[report.snapshot.market_scope] ?? report.snapshot.market_scope}
          </code>
          <code>{report.snapshot.meta.contract_version}</code>
          <code>{report.snapshot.snapshot_id}</code>
        </div>
        <div className="report-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.markdown}</ReactMarkdown>
        </div>
      </details>

      <footer className="report-disclaimer" data-version={report.snapshot.disclaimer.version}>
        <strong>风险披露</strong>
        <p>{report.snapshot.disclaimer.full_text}</p>
        <code>{report.snapshot.disclaimer.hash}</code>
      </footer>
    </article>
  );
}
