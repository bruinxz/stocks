import React from 'react';
import DailyReport from '../DailyReport';
import type { Tab67Api } from './tab67Api';
import { useDailyReportRuntime } from './useDailyReportRuntime';

export interface DailyReportContainerProps {
  api: Tab67Api;
  tradingDay?: string;
}

export function DailyReportContainer({
  api,
  tradingDay = new Date().toISOString().slice(0, 10),
}: DailyReportContainerProps) {
  const runtime = useDailyReportRuntime(api, {
    profile: 'us_preferred',
    marketScope: 'us',
    tradingDay,
  });
  return (
    <DailyReport
      state={runtime.state}
      generateAvailable={false}
      generateUnavailableReason="回放生成待运行时接入"
      onRetry={runtime.retry}
    />
  );
}

export default DailyReportContainer;
