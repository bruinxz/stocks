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

function abortAwareDelay(
  delayMs: number,
  signal: AbortSignal,
  setTimer: typeof setTimeout,
  clearTimer: typeof clearTimeout
): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (elapsed: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(elapsed);
    };
    const onAbort = () => {
      clearTimer(timer);
      finish(false);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimer(() => finish(true), delayMs);
    // Test schedulers are allowed to invoke the callback synchronously. Do not
    // leave their returned handle armed after the promise has already settled.
    if (settled) clearTimer(timer);
  });
}

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
  const generationRef = useRef<GenerationJob | null>(null);
  const generatingRef = useRef(false);
  const generationSequenceRef = useRef(0);
  const activeGenerationRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    generationRef.current = null;
    activeGenerationRef.current = null;
    generatingRef.current = false;
  }, []);

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
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [api, marketScope, profile, stop]);

  useEffect(() => {
    void loadLatest();
    return stop;
  }, [loadLatest, stop]);

  const generate = useCallback(async () => {
    if (generatingRef.current) return;
    stop();
    const generationSequence = generationSequenceRef.current + 1;
    generationSequenceRef.current = generationSequence;
    activeGenerationRef.current = generationSequence;
    generatingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ kind: 'loading' });
    const startedAt = now();
    try {
      let job = await api.submitReplay(
        { trading_day: tradingDay, profile, market_scope: marketScope },
        controller.signal
      );
      if (controller.signal.aborted) return;
      generationRef.current = job;
      let attempt = 0;
      while (job.status !== 'completed' && job.status !== 'failed') {
        if (now() - startedAt >= POLL_TIMEOUT_MS) throw new Error('日报生成轮询超时，请重试');
        const elapsed = await abortAwareDelay(
          job.retry_after_ms ?? pollDelay(attempt),
          controller.signal,
          setTimer,
          clearTimer
        );
        if (!elapsed || controller.signal.aborted) return;
        const incoming = await api.replayStatus(job.job_id, controller.signal);
        if (controller.signal.aborted) return;
        job = nextGenerationState(job, incoming);
        generationRef.current = job;
        attempt += 1;
      }
      if (job.status === 'failed') throw new Error(job.error || '日报生成失败');

      // Replay completion only proves that its snapshot is durable. The daily
      // projection may still expose an older snapshot for this day, so keep
      // polling the date-scoped projection and never pair `completed` with an
      // unrelated `latest` report.
      while (!controller.signal.aborted) {
        if (now() - startedAt >= POLL_TIMEOUT_MS) {
          throw new Error('日报生成轮询超时，请重试');
        }
        let report: Awaited<ReturnType<Tab67Api['daily']>> | null = null;
        try {
          report = await api.daily(tradingDay, profile, marketScope, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (!(error instanceof Tab67ApiError && error.status === 404)) throw error;
        }
        if (controller.signal.aborted) return;
        if (
          report &&
          report.wire.source_snapshot_id === job.snapshot_id &&
          report.snapshot.snapshot_id === job.snapshot_id &&
          report.trading_day === tradingDay &&
          report.wire.profile === profile &&
          report.wire.market_scope === marketScope
        ) {
          setState({ kind: 'ready', report, generation: job });
          return;
        }

        const elapsed = await abortAwareDelay(
          pollDelay(attempt),
          controller.signal,
          setTimer,
          clearTimer
        );
        if (!elapsed || controller.signal.aborted) return;
        attempt += 1;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (activeGenerationRef.current === generationSequence) {
        activeGenerationRef.current = null;
        generatingRef.current = false;
      }
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [api, clearTimer, marketScope, now, profile, setTimer, stop, tradingDay]);

  return { state, generate, retry: loadLatest };
}
