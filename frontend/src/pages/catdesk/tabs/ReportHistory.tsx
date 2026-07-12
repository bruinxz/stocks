import React from 'react';
import { Button, Tag } from 'antd';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import { LoadingState } from '../shared/LoadingState';
import { ReportDocument } from './daily-report/ReportDocument';
import { TabKpiStrip } from './daily-report/TabKpiStrip';
import { buildReportHistoryKpi } from './report-history/slots';
import type { ReportHistoryViewState } from './report-history/types';
import './daily-report/report.css';

export interface ReportHistoryProps {
  state?: ReportHistoryViewState;
  onSelect?: (reportId: string) => void;
  onCompare?: (snapshotId: string) => void;
  onRetry?: () => void;
}

const DEFAULT_STATE: ReportHistoryViewState = {
  kind: 'empty',
  query: { page: 1, page_size: 20 },
};

export function ReportHistory({
  state = DEFAULT_STATE,
  onSelect,
  onCompare,
  onRetry,
}: ReportHistoryProps) {
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
        <TabKpiStrip slots={buildReportHistoryKpi()} />
        <div className="report-toolbar">
          <div>
            <span className="report-eyebrow">ARCHIVE / NO MATCH</span>
            <h2>报告历史</h2>
          </div>
        </div>
        <EmptyState title="当前筛选条件下没有归档报告" />
      </section>
    );
  }

  return (
    <section className="report-workbench">
      <TabKpiStrip slots={buildReportHistoryKpi(state.page)} />
      <div className="report-toolbar">
        <div>
          <span className="report-eyebrow">ARCHIVE / SNAPSHOT REGISTER</span>
          <h2>报告历史</h2>
        </div>
        <Tag>{state.page.total} reports</Tag>
      </div>

      <div className="history-register">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>范围</th>
              <th>条目</th>
              <th>高确信度</th>
              <th>指纹</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {state.page.entries.map(entry => (
              <tr key={entry.report_id}>
                <td>{entry.trading_day}</td>
                <td>
                  {entry.profile} / {entry.market_scope}
                </td>
                <td>{entry.entry_count}</td>
                <td>{entry.high_conviction_count}</td>
                <td>
                  <code>{entry.output_fingerprint.slice(0, 10)}</code>
                </td>
                <td>
                  <Button size="small" onClick={() => onSelect?.(entry.report_id)}>
                    查看
                  </Button>
                  <Button size="small" onClick={() => onCompare?.(entry.snapshot_id)}>
                    对比前次
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {state.comparison && (
        <aside className="comparison-strip" aria-label="快照对比结果">
          <strong>DIFF</strong>
          <span>新增 {state.comparison.added.length}</span>
          <span>移除 {state.comparison.removed.length}</span>
          <span>变化 {state.comparison.changed.length}</span>
          <span>不变 {state.comparison.unchanged.length}</span>
        </aside>
      )}

      {state.selected_report && <ReportDocument report={state.selected_report} />}
    </section>
  );
}

export default ReportHistory;
