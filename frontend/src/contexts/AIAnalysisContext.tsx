import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AIPriceDecisionRequest,
  AIPriceDecisionTaskResult,
  aiStockAnalysisService,
} from '../services/aiStockAnalysisService';

export const AI_ANALYSIS_JOB_STORAGE_KEY = 'ai_price_analysis_job_v1';
const POLL_INTERVAL_MS = 3000;

export type AIAnalysisJobPhase =
  'submitting' | 'recovering' | 'pending' | 'processing' | 'completed' | 'failed';

export interface AIAnalysisJob {
  request_id: string;
  owner_user_id: number | null;
  request: AIPriceDecisionRequest;
  phase: AIAnalysisJobPhase;
  task_id: string | null;
  report_id: string | null;
  started_at: string;
  last_checked_at: string | null;
  elapsed_time: number;
  poll_failures: number;
  error: string | null;
  result: AIPriceDecisionTaskResult | null;
}

interface PersistedAIAnalysisJob {
  request_id: string;
  owner_user_id: number | null;
  request: AIPriceDecisionRequest;
  phase: AIAnalysisJobPhase;
  task_id: string | null;
  report_id: string | null;
  started_at: string;
  elapsed_time: number;
  error: string | null;
}

interface AIAnalysisContextValue {
  job: AIAnalysisJob | null;
  is_running: boolean;
  startAnalysis: (request: AIPriceDecisionRequest) => void;
  clearAnalysis: () => void;
}

const AIAnalysisContext = createContext<AIAnalysisContextValue | null>(null);

function readPersistedJob(): AIAnalysisJob | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(AI_ANALYSIS_JOB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedAIAnalysisJob>;
    if (!parsed.request_id || !parsed.request?.stock_code || !parsed.started_at) return null;
    const hasTask = typeof parsed.task_id === 'string' && parsed.task_id.length > 0;
    return {
      request_id: parsed.request_id,
      owner_user_id:
        Number.isSafeInteger(Number(parsed.owner_user_id)) && Number(parsed.owner_user_id) > 0
          ? Number(parsed.owner_user_id)
          : null,
      request: parsed.request,
      phase: hasTask ? 'recovering' : 'failed',
      task_id: hasTask ? String(parsed.task_id) : null,
      report_id: typeof parsed.report_id === 'string' ? parsed.report_id : null,
      started_at: parsed.started_at,
      last_checked_at: null,
      elapsed_time: Number(parsed.elapsed_time || 0),
      poll_failures: 0,
      error:
        typeof parsed.error === 'string' && parsed.error
          ? parsed.error
          : hasTask
            ? null
            : '页面在任务 ID 返回前被刷新，请重新发起分析。',
      result: null,
    };
  } catch {
    return null;
  }
}

function persistJob(job: AIAnalysisJob | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!job) {
      localStorage.removeItem(AI_ANALYSIS_JOB_STORAGE_KEY);
      return;
    }
    const persisted: PersistedAIAnalysisJob = {
      request_id: job.request_id,
      owner_user_id: job.owner_user_id,
      request: job.request,
      phase: job.phase,
      task_id: job.task_id,
      report_id: job.report_id,
      started_at: job.started_at,
      elapsed_time: job.elapsed_time,
      error: job.error,
    };
    localStorage.setItem(AI_ANALYSIS_JOB_STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // 私密模式或 quota 失败不应终止当前页面里的任务。
  }
}

function requestId(): string {
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface AIAnalysisProviderProps {
  children: React.ReactNode;
  /** undefined 仅供独立组件测试；生产 App 始终传入当前认证用户。 */
  current_user_id?: number | null;
  /** 首屏已有 token 但用户资料仍在恢复时，暂不丢弃任务恢复点。 */
  auth_identity_pending?: boolean;
}

export const AIAnalysisProvider: React.FC<AIAnalysisProviderProps> = ({
  children,
  current_user_id,
  auth_identity_pending = false,
}) => {
  const [job, setJob] = useState<AIAnalysisJob | null>(readPersistedJob);
  const activeRequestRef = useRef(job?.request_id || '');

  useEffect(() => persistJob(job), [job]);

  useEffect(() => {
    // Provider 生命周期高于页面与路由，因此登出不会自动卸载它。认证身份一旦
    // 明确变化，必须同步清除内存任务，避免下一位用户继续轮询上一位的 task_id。
    if (current_user_id === undefined || auth_identity_pending || !job) return;
    if (current_user_id === null || job.owner_user_id !== current_user_id) {
      activeRequestRef.current = '';
      setJob(null);
    }
  }, [auth_identity_pending, current_user_id, job]);

  const startAnalysis = useCallback(
    (request: AIPriceDecisionRequest) => {
      const nextRequestId = requestId();
      const startedAt = new Date().toISOString();
      activeRequestRef.current = nextRequestId;
      setJob({
        request_id: nextRequestId,
        owner_user_id: current_user_id ?? null,
        request,
        phase: 'submitting',
        task_id: null,
        report_id: null,
        started_at: startedAt,
        last_checked_at: null,
        elapsed_time: 0,
        poll_failures: 0,
        error: null,
        result: null,
      });

      void aiStockAnalysisService.submitPriceDecisionAsync(request).then(
        submitted => {
          if (activeRequestRef.current !== nextRequestId) return;
          setJob(previous =>
            previous?.request_id === nextRequestId
              ? {
                  ...previous,
                  phase: submitted.task_phase === 'processing' ? 'processing' : 'pending',
                  task_id: submitted.task_id,
                  report_id: submitted.report_id,
                  elapsed_time: submitted.elapsed_time || 0,
                  last_checked_at: new Date().toISOString(),
                }
              : previous
          );
        },
        error => {
          if (activeRequestRef.current !== nextRequestId) return;
          setJob(previous =>
            previous?.request_id === nextRequestId
              ? {
                  ...previous,
                  phase: 'failed',
                  error: error?.response?.data?.message || error?.message || 'AI 异步任务提交失败',
                }
              : previous
          );
        }
      );
    },
    [current_user_id]
  );

  useEffect(() => {
    if (!job?.task_id || !['recovering', 'pending', 'processing'].includes(job.phase)) {
      return undefined;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const request_id = job.request_id;
    const task_id = job.task_id;

    const poll = async () => {
      try {
        const result = await aiStockAnalysisService.getPriceDecisionTask(task_id);
        if (cancelled || activeRequestRef.current !== request_id) return;
        const phase: AIAnalysisJobPhase =
          result.task_phase === 'completed'
            ? 'completed'
            : result.task_phase === 'failed'
              ? 'failed'
              : result.task_phase === 'processing'
                ? 'processing'
                : 'pending';
        setJob(previous =>
          previous?.request_id === request_id
            ? {
                ...previous,
                phase,
                report_id: result.report_id || previous.report_id,
                elapsed_time: Number(result.elapsed_time || previous.elapsed_time || 0),
                last_checked_at: new Date().toISOString(),
                poll_failures: 0,
                error: phase === 'failed' ? result.error || 'AI 分析失败' : null,
                result: phase === 'completed' || phase === 'failed' ? result : null,
              }
            : previous
        );
        if (phase === 'pending' || phase === 'processing') {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch {
        if (cancelled || activeRequestRef.current !== request_id) return;
        setJob(previous => {
          if (!previous || previous.request_id !== request_id) return previous;
          const failures = previous.poll_failures + 1;
          return {
            ...previous,
            poll_failures: failures,
            last_checked_at: new Date().toISOString(),
            error: previous.error,
          };
        });
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(poll, job.phase === 'recovering' ? 0 : POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [job?.phase, job?.request_id, job?.task_id]);

  const clearAnalysis = useCallback(() => {
    activeRequestRef.current = '';
    setJob(null);
  }, []);

  const value = useMemo<AIAnalysisContextValue>(
    () => ({
      job,
      is_running: Boolean(
        job && ['submitting', 'recovering', 'pending', 'processing'].includes(job.phase)
      ),
      startAnalysis,
      clearAnalysis,
    }),
    [clearAnalysis, job, startAnalysis]
  );

  return <AIAnalysisContext.Provider value={value}>{children}</AIAnalysisContext.Provider>;
};

export function useAIAnalysis(): AIAnalysisContextValue {
  const context = useContext(AIAnalysisContext);
  if (!context) throw new Error('useAIAnalysis must be used within AIAnalysisProvider');
  return context;
}
