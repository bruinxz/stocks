import React from 'react';
import { Button, Tag } from 'antd';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import { LoadingState } from '../shared/LoadingState';
import { ReportDocument } from './daily-report/ReportDocument';
import { TabKpiStrip } from './daily-report/TabKpiStrip';
import { buildDailyReportKpi } from './daily-report/slots';
import type { DailyReportViewState } from './daily-report/types';
import './daily-report/report.css';

export interface DailyReportProps {
  state?: DailyReportViewState;
  onGenerate?: () => void;
  onRetry?: () => void;
  generateAvailable?: boolean;
  generateUnavailableReason?: string;
}

const DEFAULT_STATE: DailyReportViewState = {
  kind: 'empty',
  profile: 'us_preferred',
  market_scope: 'us',
};

export function DailyReport({
  state = DEFAULT_STATE,
  onGenerate,
  onRetry,
  generateAvailable = false,
  generateUnavailableReason = '回放生成待运行时接入',
}: DailyReportProps) {
  if (state.kind === 'loading') return <LoadingState />;
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
            <span className="report-eyebrow">DAILY REPORT / CONTRACT PREVIEW</span>
            <h2>每日日报</h2>
          </div>
          <div>
            <Tag>{state.profile}</Tag>
            <Tag>{state.market_scope}</Tag>
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
          <span className="report-eyebrow">DAILY REPORT / EVIDENCE LEDGER</span>
          <h2>每日日报</h2>
        </div>
        <Tag color={state.generation.status === 'completed' ? 'green' : 'blue'}>
          {state.generation.status}
        </Tag>
      </div>
      <ReportDocument report={state.report} />
    </section>
  );
}

export default DailyReport;
