import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { EvidenceText } from './EvidenceText';
import type { DailyReportDocument } from './types';
import {
  MARKET_SCOPE_LABELS,
  PROFILE_LABELS,
  RISK_GATE_LABELS,
  SIZE_HINT_LABELS,
} from '../../shared/uiLabels';

export function ReportDocument({ report }: { report: DailyReportDocument }) {
  return (
    <article className="report-document">
      <header className="report-document__header">
        <div>
          <span className="report-eyebrow">A 股深度主报告 · 推荐快照 0.3.1</span>
          <h2>{report.title}</h2>
        </div>
        <div className="report-document__pins" aria-label="报告版本锚点">
          <code>{PROFILE_LABELS[report.snapshot.profile] ?? report.snapshot.profile}</code>
          <code>
            {MARKET_SCOPE_LABELS[report.snapshot.market_scope] ?? report.snapshot.market_scope}
          </code>
          <code>{report.snapshot.meta.contract_version}</code>
        </div>
      </header>

      <nav className="report-toc" aria-label="报告目录">
        {report.sections.map((section, index) => (
          <a href={`#report-${section.key}`} key={section.key}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            {section.title}
          </a>
        ))}
      </nav>

      <div className="report-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.markdown}</ReactMarkdown>
      </div>

      <section className="recommendation-ledger" aria-label="A 股个股推荐证据清单">
        {report.snapshot.items.map(item => {
          const recommendation = item.recommendation;
          return (
            <article className="recommendation-card" key={recommendation.id}>
              <div className="recommendation-card__rank">{item.rating_band}</div>
              <div>
                <div className="recommendation-card__title">
                  <strong>{recommendation.ticker}</strong>
                  <span>{recommendation.explanation.headline}</span>
                </div>
                <p>
                  <EvidenceText
                    body={recommendation.explanation.body}
                    evidenceRefs={recommendation.evidence_refs}
                  />
                </p>
                <div className="recommendation-card__meta">
                  <code>评分 {recommendation.score.total}</code>
                  <code>确信度 {recommendation.conviction.final}</code>
                  <code>
                    风险{' '}
                    {RISK_GATE_LABELS[recommendation.risk_gate.gate] ??
                      recommendation.risk_gate.gate}
                  </code>
                  <code>
                    仓位{' '}
                    {SIZE_HINT_LABELS[recommendation.entry_plan.size_hint.tier] ??
                      recommendation.entry_plan.size_hint.tier}
                  </code>
                </div>
              </div>
            </article>
          );
        })}
      </section>

      {report.sections.map(section => (
        <section id={`report-${section.key}`} className="report-section" key={section.key}>
          <h3>{section.title}</h3>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.markdown}</ReactMarkdown>
        </section>
      ))}

      <footer className="report-disclaimer" data-version={report.snapshot.disclaimer.version}>
        <strong>风险披露</strong>
        <p>{report.snapshot.disclaimer.full_text}</p>
        <code>{report.snapshot.disclaimer.hash}</code>
      </footer>
    </article>
  );
}
