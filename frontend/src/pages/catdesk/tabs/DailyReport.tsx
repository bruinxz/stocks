import React from 'react';
import { Button, Tag } from 'antd';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import { LoadingState } from '../shared/LoadingState';
import { ReportDocument } from './daily-report/ReportDocument';
import { TabKpiStrip } from './daily-report/TabKpiStrip';
import { buildDailyReportKpi, dailyReportStatusLabel } from './daily-report/slots';
import type { DailyReportViewState } from './daily-report/types';
import { MARKET_SCOPE_LABELS, PROFILE_LABELS } from '../shared/uiLabels';
import './daily-report/report.css';

export interface DailyReportProps {
  state?: DailyReportViewState;
  onGenerate?: () => void;
  onRetry?: () => void;
  generateAvailable?: boolean;
  generateUnavailableReason?: string;
  aShareOverview?: React.ReactNode;
  globalSummary?: React.ReactNode;
}

const DEFAULT_STATE: DailyReportViewState = {
  kind: 'empty',
  profile: 'us_preferred',
  market_scope: 'cn_a',
};

export function DailyReport({
  state = DEFAULT_STATE,
  onGenerate,
  onRetry,
  generateAvailable = false,
  generateUnavailableReason = '回放生成待运行时接入',
  aShareOverview,
  globalSummary,
}: DailyReportProps) {
  if (state.kind === 'loading')
    return (
      <LoadingState
        title="正在铺开 A 股每日研究来信"
        description="先整理 A 股板块与个股证据，再叠加海外大势…"
        mood="hopeful"
      />
    );
  if (state.kind === 'error') {
    return (
      <div className="report-state-shell">
        <ErrorState message={state.message} />
        <Button onClick={onRetry}>重试</Button>
      </div>
    );
  }
  if (state.kind === 'empty') {
    return (
      <section className="report-workbench report-workbench--empty">
        <TabKpiStrip slots={buildDailyReportKpi()} />
        <div className="report-toolbar">
          <div>
            <span className="report-eyebrow">A 股每日日报 · 详细主报告</span>
            <h2>每日日报</h2>
          </div>
          <div>
            <Tag>{PROFILE_LABELS[state.profile] ?? state.profile}</Tag>
            <Tag>{MARKET_SCOPE_LABELS[state.market_scope] ?? state.market_scope}</Tag>
          </div>
        </div>
        <EmptyState title="当前范围暂无已归档日报" />
        <Button type="primary" disabled={!generateAvailable} onClick={onGenerate}>
          {generateAvailable ? '生成日报' : generateUnavailableReason}
        </Button>
      </section>
    );
  }

  return (
    <section className="report-workbench">
      <TabKpiStrip slots={buildDailyReportKpi(state.report, state.generation)} />
      <div className="report-toolbar">
        <div>
          <span className="report-eyebrow">A 股每日日报 · 板块、个股与证据账本</span>
          <h2>每日日报</h2>
        </div>
        <Tag
          color={
            state.generation.status === 'completed' || state.generation.status === 'idle'
              ? 'green'
              : 'blue'
          }
        >
          {dailyReportStatusLabel(state.report, state.generation)}
        </Tag>
      </div>
      <ReportDocument
        report={state.report}
        aShareOverview={aShareOverview}
        globalSummary={globalSummary}
      />
    </section>
  );
}

export default DailyReport;
