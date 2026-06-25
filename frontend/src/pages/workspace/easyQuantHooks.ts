import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useSelector } from 'react-redux';
import { BacktestDetail } from '../../services/labService';
import easyQuantService, { EasyQuantBootstrap } from '../../services/easyQuantService';
import { RootState } from '../../store/rootReducer';

export function useEasyQuantDisplayUsername(): string {
  const authUser = useSelector((state: RootState) => state.auth.user);

  return useMemo(() => {
    if (authUser?.nickname || authUser?.username) {
      return authUser.nickname || authUser.username;
    }

    const cachedUsername = localStorage.getItem('username');
    if (cachedUsername) {
      return cachedUsername;
    }

    try {
      const cachedUser = JSON.parse(localStorage.getItem('user') || '{}');
      return cachedUser?.nickname || cachedUser?.username || 'Admin';
    } catch {
      return 'Admin';
    }
  }, [authUser]);
}

export function useEasyQuantBootstrap(): {
  bootstrap: EasyQuantBootstrap | null;
  bootstrapLoading: boolean;
  bootstrapError: string | null;
} {
  const [bootstrap, setBootstrap] = useState<EasyQuantBootstrap | null>(null);
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBootstrapLoading(true);
    setBootstrapError(null);

    easyQuantService
      .loadEasyQuantBootstrap()
      .then(data => {
        if (!cancelled) {
          setBootstrap(data);
        }
      })
      .catch(error => {
        if (!cancelled) {
          setBootstrapError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBootstrapLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { bootstrap, bootstrapLoading, bootstrapError };
}

export function useEasyQuantBacktestPolling(
  taskId: number | null,
  setBacktestDetail: Dispatch<SetStateAction<BacktestDetail | null>>,
  setBacktestLoading: Dispatch<SetStateAction<boolean>>,
  setBacktestError: Dispatch<SetStateAction<string | null>>
): void {
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!taskId) {
      return undefined;
    }

    let cancelled = false;
    const startedAt = Date.now();
    let attempt = 0;

    const clearPollTimer = () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const stopPolling = () => {
      clearPollTimer();
      setBacktestLoading(false);
    };

    const poll = async () => {
      try {
        const detail = await easyQuantService.getEasyQuantBacktestDetail(taskId);
        if (cancelled) {
          return;
        }

        setBacktestDetail(detail);
        const status = detail?.task?.status;

        if (status === 'COMPLETED' || status === 'FAILED') {
          stopPolling();
          return;
        }

        if (Date.now() - startedAt > 10 * 60 * 1000) {
          stopPolling();
          setBacktestError('回测超过 10 分钟还没有完成，请稍后刷新结果。');
          return;
        }

        attempt += 1;
        const nextDelay = Math.min(5000 + attempt * 2000, 15000);
        timerRef.current = window.setTimeout(poll, nextDelay);
      } catch (error) {
        if (!cancelled) {
          setBacktestError(error instanceof Error ? error.message : String(error));
          stopPolling();
        }
      }
    };

    clearPollTimer();
    void poll();

    return () => {
      cancelled = true;
      clearPollTimer();
    };
  }, [setBacktestDetail, setBacktestError, setBacktestLoading, taskId]);
}
