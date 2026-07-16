import { useEffect, useMemo, useState } from 'react';
import { authenticatedFetch } from 'services/api';
import type { TabKey } from '../useTabState';

type FreshnessStatus = 'fresh' | 'delayed' | 'missing';

interface FreshnessItem {
  page: TabKey;
  label: string;
  latest_data_at: string | null;
  latest_data_date: string | null;
  reference_trade_date: string | null;
  lag_days: number | null;
  status: FreshnessStatus;
  source: string;
}

interface FreshnessPayload {
  success: boolean;
  data?: { generated_at: string; pages: Partial<Record<TabKey, FreshnessItem>> };
}

const STATUS_LABEL: Record<FreshnessStatus, string> = {
  fresh: '已对齐',
  delayed: '有延迟',
  missing: '待同步',
};

function formatDateTime(value: string | null): string {
  if (!value) return '暂无数据';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function PageFreshnessStamp({ activeTab }: { activeTab: TabKey }) {
  const [pages, setPages] = useState<Partial<Record<TabKey, FreshnessItem>>>({});
  const [requestFailed, setRequestFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await authenticatedFetch('/api/data/page-freshness', {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`freshness ${response.status}`);
        const payload = (await response.json()) as FreshnessPayload;
        if (!controller.signal.aborted) {
          setPages(payload.data?.pages ?? {});
          setRequestFailed(false);
        }
      } catch (error) {
        if (!controller.signal.aborted) setRequestFailed(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5 * 60 * 1000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  const item = pages[activeTab];
  const status: FreshnessStatus = item?.status ?? 'missing';
  const detail = useMemo(() => {
    if (requestFailed) return '数据水位暂不可用';
    if (!item) return '正在核对数据水位';
    const date = item.latest_data_date ?? '暂无日期';
    return `${item.label}截至 ${date} · 写入 ${formatDateTime(item.latest_data_at)}`;
  }, [item, requestFailed]);

  return (
    <div className={`catdesk-freshness catdesk-freshness--${status}`} role="status">
      <span className="catdesk-freshness__mark" aria-hidden="true" />
      <div>
        <small>本页数据时间</small>
        <strong>{detail}</strong>
      </div>
      <em>{requestFailed ? '核对失败' : STATUS_LABEL[status]}</em>
    </div>
  );
}
