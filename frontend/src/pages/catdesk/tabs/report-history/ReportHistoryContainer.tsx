import React from 'react';
import ReportHistory from '../ReportHistory';
import type { Tab67Api } from '../daily-report/tab67Api';
import { useReportHistoryRuntime } from './useReportHistoryRuntime';

export function ReportHistoryContainer({ api }: { api: Tab67Api }) {
  const runtime = useReportHistoryRuntime(api);
  return (
    <ReportHistory
      state={runtime.state}
      onSelect={reportId => void runtime.select(reportId)}
      onCompare={snapshotId => void runtime.compare(snapshotId)}
      onRetry={runtime.retry}
    />
  );
}

export default ReportHistoryContainer;
