import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { useSelector } from 'react-redux';
import { BacktestDetail } from '../../services/labService';
import easyQuantService, { EasyQuantBootstrap } from '../../services/easyQuantService';
import { RootState } from '../../store/rootReducer';

export type EasyQuantStepKey = 'template' | 'data' | 'backtest' | 'observe';
export type EasyQuantSectionId =
  | 'easy-quant-hero'
  | 'easy-quant-flow'
  | 'easy-quant-template'
  | 'easy-quant-data'
  | 'easy-quant-backtest'
  | 'easy-quant-observe';

export interface EasyQuantSectionNavItem {
  id: EasyQuantSectionId;
  label: string;
}

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

export function useEasyQuantSectionScrollSpy(
  scrollRootRef: RefObject<HTMLDivElement | null>,
  programmaticSectionRef: MutableRefObject<EasyQuantSectionId | null>,
  sectionNavItems: EasyQuantSectionNavItem[],
  stepBySection: Partial<Record<EasyQuantSectionId, EasyQuantStepKey>>,
  setActiveSectionId: Dispatch<SetStateAction<EasyQuantSectionId>>,
  setActiveStep: Dispatch<SetStateAction<EasyQuantStepKey>>,
  setVisibleSections: Dispatch<SetStateAction<Record<string, boolean>>>
): void {
  useEffect(() => {
    const scrollRoot = scrollRootRef.current;
    const sections = sectionNavItems
      .map(item => document.getElementById(item.id))
      .filter((section): section is HTMLElement => Boolean(section));

    if (!sections.length) {
      return undefined;
    }

    if (!('IntersectionObserver' in window)) {
      setVisibleSections(
        sectionNavItems.reduce<Record<string, boolean>>((acc, item) => {
          acc[item.id] = true;
          return acc;
        }, {})
      );
      return undefined;
    }

    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) {
            return;
          }

          const sectionId = entry.target.id as EasyQuantSectionId;
          const stepKey = stepBySection[sectionId];
          if (programmaticSectionRef.current) {
            return;
          }

          setActiveSectionId(sectionId);
          if (stepKey) {
            setActiveStep(stepKey);
          }
          setVisibleSections(prev =>
            prev[sectionId]
              ? prev
              : {
                  ...prev,
                  [sectionId]: true,
                }
          );
        });
      },
      {
        root: scrollRoot,
        threshold: 0.42,
        rootMargin: '0px 0px -8% 0px',
      }
    );

    sections.forEach(section => observer.observe(section));

    return () => observer.disconnect();
  }, [
    programmaticSectionRef,
    scrollRootRef,
    sectionNavItems,
    setActiveSectionId,
    setActiveStep,
    setVisibleSections,
    stepBySection,
  ]);

  useEffect(() => {
    const scrollRoot = scrollRootRef.current;
    if (!scrollRoot) {
      return undefined;
    }

    let frameId = 0;

    const updateActiveSection = () => {
      const scrollerRect = scrollRoot.getBoundingClientRect();
      const viewportCenter = scrollerRect.top + scrollRoot.clientHeight / 2;
      const nearestSection = sectionNavItems
        .map(item => {
          const section = document.getElementById(item.id);
          if (!section) {
            return null;
          }

          const rect = section.getBoundingClientRect();
          const sectionCenter = rect.top + rect.height / 2;
          return {
            id: item.id,
            distance: Math.abs(sectionCenter - viewportCenter),
          };
        })
        .filter((item): item is { id: EasyQuantSectionId; distance: number } => Boolean(item))
        .sort((a, b) => a.distance - b.distance)[0];

      if (nearestSection) {
        const stepKey = stepBySection[nearestSection.id];
        setActiveSectionId(nearestSection.id);
        if (stepKey) {
          setActiveStep(stepKey);
        }
      }
    };

    const requestUpdate = () => {
      if (programmaticSectionRef.current) {
        return;
      }

      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(updateActiveSection);
    };

    updateActiveSection();
    scrollRoot.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);

    return () => {
      window.cancelAnimationFrame(frameId);
      scrollRoot.removeEventListener('scroll', requestUpdate);
      window.removeEventListener('resize', requestUpdate);
    };
  }, [
    programmaticSectionRef,
    scrollRootRef,
    sectionNavItems,
    setActiveSectionId,
    setActiveStep,
    stepBySection,
  ]);
}
