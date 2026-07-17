import React from 'react';
import DailyReport from '../DailyReport';
import type { Tab67Api } from './tab67Api';
import { useDailyReportRuntime } from './useDailyReportRuntime';
import { GlobalCatalystSummary } from './GlobalCatalystSummary';
import { AShareEditorialSummary } from './AShareEditorialSummary';

export interface DailyReportContainerProps {
  api: Tab67Api;
  tradingDay?: string;
}

function currentShanghaiDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function DailyReportContainer({
  api,
  tradingDay = currentShanghaiDate(),
}: DailyReportContainerProps) {
  const runtime = useDailyReportRuntime(api, {
    profile: 'us_preferred',
    marketScope: 'cn_a',
    tradingDay,
  });
  const report = runtime.state.kind === 'ready' ? runtime.state.report : null;
  return (
    <DailyReport
      state={runtime.state}
      generateAvailable
      onGenerate={() => void runtime.generate()}
      onRetry={runtime.retry}
      aShareOverview={report ? <AShareEditorialSummary report={report} /> : undefined}
      globalSummary={<GlobalCatalystSummary />}
    />
  );
}

export default DailyReportContainer;
