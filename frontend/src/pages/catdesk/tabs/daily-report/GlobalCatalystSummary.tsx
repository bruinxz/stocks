import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import { authenticatedFetch } from 'services/api';
import { loadRecommendationCandidateFeed } from '../recommendationCandidates';

interface CatalystCard {
  key: 'us' | 'jp' | 'kr';
  market: string;
  pulse: string;
  detail: string;
  as_of: string;
  tone: 'positive' | 'neutral' | 'cautious';
}

interface GlobalCatalystState {
  cards: CatalystCard[];
}

function shanghaiDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function tone(change: number): CatalystCard['tone'] {
  if (change >= 0.5) return 'positive';
  if (change <= -0.5) return 'cautious';
  return 'neutral';
}

function trendText(change: number): string {
  if (change >= 1) return '风险偏好明显回升';
  if (change >= 0.2) return '市场情绪温和偏强';
  if (change <= -1) return '风险偏好明显收缩';
  if (change <= -0.2) return '市场情绪略偏谨慎';
  return '整体维持震荡平衡';
}

async function loadJpKr(signal: AbortSignal, market: 'JP' | 'KR') {
  const response = await authenticatedFetch(
    `/api/v1/jpkr-market/${shanghaiDate()}?market=${market}`,
    { signal }
  );
  if (!response.ok) throw new Error(`${market} catalyst ${response.status}`);
  return (await response.json()) as {
    kpi?: {
      nikkei225?: { change_pct?: number; as_of?: string } | null;
      kospi?: { change_pct?: number; as_of?: string } | null;
    };
    rows?: Array<{ change_pct?: number; sector?: string }>;
  };
}

async function loadGlobalCatalysts(signal: AbortSignal): Promise<GlobalCatalystState> {
  const [usResult, jpResult, krResult] = await Promise.allSettled([
    loadRecommendationCandidateFeed(signal, 'us_preferred', 'us'),
    loadJpKr(signal, 'JP'),
    loadJpKr(signal, 'KR'),
  ]);
  const cards: CatalystCard[] = [];

  if (usResult.status === 'fulfilled' && usResult.value.kind === 'ready') {
    const { feed } = usResult.value;
    const avg = feed.kpi.avg_score;
    cards.push({
      key: 'us',
      market: '美股隔夜',
      pulse: avg >= 75 ? '成长与科技催化偏强' : avg >= 60 ? '大盘成长保持韧性' : '风险偏好仍需观察',
      detail: `整体评分 ${avg.toFixed(1)}，高确信度线索 ${feed.kpi.high_conviction} 组；仅作为 A 股科技、消费与出口链的侧面催化。`,
      as_of: feed.snapshot.as_of,
      tone: avg >= 70 ? 'positive' : avg < 55 ? 'cautious' : 'neutral',
    });
  }

  for (const [key, market, settled] of [
    ['jp', '日本市场', jpResult],
    ['kr', '韩国市场', krResult],
  ] as const) {
    if (settled.status !== 'fulfilled') continue;
    const index = key === 'jp' ? settled.value.kpi?.nikkei225 : settled.value.kpi?.kospi;
    const change = Number(index?.change_pct ?? 0);
    const rows = settled.value.rows ?? [];
    const positiveRatio = rows.length
      ? Math.round((rows.filter(row => Number(row.change_pct ?? 0) > 0).length / rows.length) * 100)
      : 0;
    cards.push({
      key,
      market,
      pulse: trendText(change),
      detail: `主要指数 ${change >= 0 ? '+' : ''}${change.toFixed(2)}%，观察池上涨占比 ${positiveRatio}%；重点映射 A 股半导体、汽车与高端制造链。`,
      as_of: index?.as_of ?? shanghaiDate(),
      tone: tone(change),
    });
  }

  return { cards };
}

export function GlobalCatalystSummary() {
  const { data, loading } = useAbortableRequest(loadGlobalCatalysts, []);
  return (
    <section className="global-catalyst" aria-label="海外市场对 A 股的侧面催化">
      <header>
        <div>
          <span className="editorial-section-number">03</span>
          <h2>海外三句话</h2>
        </div>
        <p>日韩与美股只作简要旁注，主稿仍然聚焦 A 股。</p>
      </header>
      <div className="global-catalyst__grid">
        {(data?.cards ?? []).map(card => (
          <article key={card.key} data-tone={card.tone}>
            <span>{card.market}</span>
            <strong>{card.pulse}</strong>
            <p>{card.detail}</p>
            <time>数据截至 {card.as_of.slice(0, 10)}</time>
          </article>
        ))}
        {loading && <div className="global-catalyst__loading">正在收拢海外大势…</div>}
        {!loading && !data?.cards.length && (
          <div className="global-catalyst__loading">海外催化暂未就绪，不影响 A 股主报告阅读。</div>
        )}
      </div>
    </section>
  );
}
