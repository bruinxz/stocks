import { useCallback, useEffect, useRef, useState } from 'react';
import { nextGenerationState, pollDelay, POLL_TIMEOUT_MS } from './generationMachine';
import {
  type DailyReportViewState,
  type GenerationJob,
  type RecommendationMarketScope,
  type RecommendationProfile,
} from './types';
import { Tab67ApiError, type Tab67Api } from './tab67Api';

export interface DailyReportRuntimeOptions {
  profile: RecommendationProfile;
  marketScope: RecommendationMarketScope;
  tradingDay: string;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?: () => number;
}

const DEFAULT_SET_TIMER = setTimeout;
const DEFAULT_CLEAR_TIMER = clearTimeout;
const DEFAULT_NOW = Date.now;

export interface DailyReportRuntime {
  state: DailyReportViewState;
  generate(): Promise<void>;
  retry(): void;
}

export function useDailyReportRuntime(
  api: Tab67Api,
  {
    profile,
    marketScope,
    tradingDay,
    setTimer = DEFAULT_SET_TIMER,
    clearTimer = DEFAULT_CLEAR_TIMER,
    now = DEFAULT_NOW,
  }: DailyReportRuntimeOptions
): DailyReportRuntime {
  const [state, setState] = useState<DailyReportViewState>({ kind: 'loading' });
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef<GenerationJob | null>(null);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (timerRef.current != null) clearTimer(timerRef.current);
    timerRef.current = null;
  }, [clearTimer]);

  const loadLatest = useCallback(async () => {
    stop();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ kind: 'loading' });
    try {
      const report = await api.latest(profile, marketScope, controller.signal);
      if (!controller.signal.aborted) {
        setState({
          kind: 'ready',
          report,
          generation: generationRef.current ?? { job_id: 'idle', status: 'idle' },
        });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof Tab67ApiError && error.status === 404) {
        setState({ kind: 'empty', profile, market_scope: marketScope });
      } else {
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, [api, marketScope, profile, stop]);

  useEffect(() => {
    void loadLatest();
    return stop;
  }, [loadLatest, stop]);

  const generate = useCallback(async () => {
    stop();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ kind: 'loading' });
    const startedAt = now();
    try {
      let job = await api.submitReplay(
        { trading_day: tradingDay, profile, market_scope: marketScope },
        controller.signal
      );
      generationRef.current = job;
      let attempt = 0;
      while (job.status !== 'completed' && job.status !== 'failed') {
        if (now() - startedAt >= POLL_TIMEOUT_MS) throw new Error('日报生成轮询超时，请重试');
        await new Promise<void>(resolve => {
          timerRef.current = setTimer(resolve, job.retry_after_ms ?? pollDelay(attempt));
        });
        if (controller.signal.aborted) return;
        const incoming = await api.replayStatus(job.job_id, controller.signal);
        job = nextGenerationState(job, incoming);
        generationRef.current = job;
        attempt += 1;
      }
      if (job.status === 'failed') throw new Error(job.error || '日报生成失败');
      const report = await api.latest(profile, marketScope, controller.signal);
      if (!controller.signal.aborted) setState({ kind: 'ready', report, generation: job });
    } catch (error) {
      if (!controller.signal.aborted) {
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, [api, marketScope, now, profile, setTimer, stop, tradingDay]);

  return { state, generate, retry: loadLatest };
}
