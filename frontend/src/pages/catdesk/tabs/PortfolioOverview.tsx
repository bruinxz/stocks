import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Select, Tag } from 'antd';
import {
  BellOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  LinkOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import AIStockAnalysisModal from '../../../components/trading/AIStockAnalysisModal';
import { usePortfolio } from '../../../contexts/PortfolioContext';
import {
  portfolioWorkspaceService,
  type LedgerTimelineItem,
  type PortfolioLedger,
  type PortfolioLedgerPosition,
} from '../../../services/portfolioWorkspaceService';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import { LoadingState } from '../shared/LoadingState';

const money = (value: number) =>
  Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const dateTime = (value: string | null | undefined) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
};

const SOURCE_LABEL: Record<string, string> = {
  recommendation_snapshot: 'A 股早报规范推荐',
  tradingagents: 'TradingAgents 会审',
  quant_recommendation: '历史量化推荐',
  etf_factor_rotation: 'ETF 因子轮动',
  manual_analysis: '人工分析',
};

const ORIGIN_LABEL: Record<string, string> = {
  manual: '手动建仓',
  rebalance: '组合再平衡',
  auto_buy_from_signals: '自动跟单',
  analysis_engine_hard: '分析引擎执行',
};

const TIMELINE_ICON: Record<LedgerTimelineItem['type'], React.ReactNode> = {
  trade: <CheckCircleOutlined />,
  signal: <LinkOutlined />,
  alert: <WarningOutlined />,
  notification: <BellOutlined />,
  correction: <SafetyCertificateOutlined />,
};

function FreshnessTag({ row }: { row: PortfolioLedgerPosition['quote'] }) {
  if (row.freshness === 'live') return <Tag color="green">盘中 · {row.age_minutes ?? 0} 分钟</Tag>;
  if (row.freshness === 'close') return <Tag color="blue">有效收盘价 · {row.trade_date}</Tag>;
  if (row.freshness === 'delayed') return <Tag color="gold">延迟 · {row.age_minutes} 分钟</Tag>;
  if (row.freshness === 'stale') return <Tag color="red">已过期</Tag>;
  return <Tag>实时行情缺失 · 使用持仓缓存</Tag>;
}

function researchResult(
  label: string,
  row: Pick<
    PortfolioLedgerPosition['morning_brief'],
    'matched' | 'freshness' | 'trading_day' | 'expected_trading_day'
  >
) {
  if (row.freshness === 'missing') return `${label}暂无可用研究`;
  if (row.freshness === 'delayed') {
    return `${label}研究已过期（数据日 ${row.trading_day || '—'}，应到 ${row.expected_trading_day}）`;
  }
  return `${label}${row.matched ? '命中' : '未入选'}`;
}

function researchTagLabel(row: { matched: boolean; freshness: 'fresh' | 'delayed' | 'missing' }) {
  if (row.freshness === 'missing') return '暂无';
  if (row.freshness === 'delayed') return '过期';
  return row.matched ? '命中' : '未入选';
}

function PositionDetail({ row }: { row: PortfolioLedgerPosition }) {
  return (
    <div className="catdesk-ledger-detail">
      <div className="catdesk-ledger-detail__grid">
        <article>
          <span>成交与推荐</span>
          {row.entry_trades.length ? (
            row.entry_trades.map(trade => (
              <p key={trade.id}>
                #{trade.id} · {dateTime(trade.created_at)} · ¥{trade.execute_price.toFixed(2)} ×{' '}
                {trade.quantity.toLocaleString('zh-CN')} 股
              </p>
            ))
          ) : (
            <p>未找到原始买入成交</p>
          )}
          {row.investment_signal ? (
            <p>
              信号 #{row.investment_signal.id} ·{' '}
              {SOURCE_LABEL[row.investment_signal.source_type] || row.investment_signal.source_type}
              {' · '}信号日 {row.investment_signal.signal_date}
              {' · '}源记录 {row.investment_signal.source_id}
              {row.investment_signal.rationale ? ` · ${row.investment_signal.rationale}` : ''}
            </p>
          ) : row.trade_origin ? (
            <p>
              成交 #{row.trade_origin.trade_id} ·{' '}
              {ORIGIN_LABEL[row.trade_origin.source] || row.trade_origin.source}
              {row.trade_origin.summary ? ` · ${row.trade_origin.summary}` : ''}
            </p>
          ) : (
            <p className="is-warning">成交来源未记录，无法可靠归因</p>
          )}
        </article>

        <article>
          <span>研究交集</span>
          <p>
            A 股早报：
            {row.morning_brief.freshness !== 'fresh'
              ? researchResult('', row.morning_brief)
              : row.morning_brief.matched
                ? `${row.morning_brief.trading_day} · 第 ${Number(row.morning_brief.rank) + 1} 位 · ${
                    row.morning_brief.rating
                  } 级 · 快照 ${row.morning_brief.snapshot_id?.slice(0, 8)}`
                : `${row.morning_brief.trading_day} · 未入选`}
          </p>
          <p>
            高倍潜力：
            {row.multibagger.freshness === 'missing'
              ? '暂无可用研究'
              : row.multibagger.freshness === 'delayed'
                ? `研究已过期 · ${dateTime(row.multibagger.as_of)}`
                : row.multibagger.matched
                  ? `${row.multibagger.stage} · ${row.multibagger.conclusion} · ${
                      row.multibagger.rating || '未评级'
                    } · 候选 ${row.multibagger.snapshot_id?.slice(0, 8)}`
                  : `${dateTime(row.multibagger.as_of)} · 未入选`}
          </p>
        </article>

        <article>
          <span>通知与更正</span>
          <p>
            {row.alerts.length} 条相关告警，{row.alerts.filter(item => !item.is_read).length} 条未读
          </p>
          <p>
            {row.notifications.length} 条通知，{row.corrections.length} 条账务更正
          </p>
          {row.notifications.some(item => item.invalidated) ? (
            <p className="is-invalidated">已有错误通知作废，请以更正记录为准</p>
          ) : row.notifications.some(item => item.corrected) ? (
            <p className="is-corrected">已有通知被后续更正，请以更正记录为准</p>
          ) : null}
        </article>
      </div>

      <ol className="catdesk-ledger-timeline" aria-label={`${row.position.name} 对账时间线`}>
        {row.timeline.length ? (
          row.timeline.map(item => (
            <li
              key={item.id}
              className={
                item.invalidated ? 'is-invalidated' : item.corrected ? 'is-corrected' : ''
              }
            >
              <i>{TIMELINE_ICON[item.type]}</i>
              <div>
                <strong>{item.title}</strong>
                <span>
                  {dateTime(item.occurred_at)}
                  {item.status ? ` · ${item.status}` : ''}
                </span>
                {item.detail ? <p>{item.detail}</p> : null}
              </div>
            </li>
          ))
        ) : (
          <li>
            <div>
              <strong>暂无可追溯事件</strong>
            </div>
          </li>
        )}
      </ol>
    </div>
  );
}

export default function PortfolioOverview() {
  const {
    selectedPortfolioId,
    setSelectedPortfolioId,
    portfolios,
    loading: portfolioLoading,
  } = usePortfolio();
  const [data, setData] = useState<PortfolioLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [analysisTarget, setAnalysisTarget] = useState<PortfolioLedgerPosition | null>(null);

  const load = useCallback(async () => {
    if (!selectedPortfolioId) {
      setData(null);
      setLoading(portfolioLoading);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await portfolioWorkspaceService.getPortfolioLedger(selectedPortfolioId));
    } catch (err) {
      setError(err instanceof Error ? err.message : '持仓对账簿加载失败');
    } finally {
      setLoading(false);
    }
  }, [portfolioLoading, selectedPortfolioId]);

  useEffect(() => {
    void load();
  }, [load]);

  const quoteSummary = useMemo(() => {
    if (!data) return '尚未估值';
    const { live, close, delayed, stale, missing } = data.valuation.quote_counts;
    const parts = [
      live ? `${live} 只盘中价` : '',
      close ? `${close} 只有效收盘价` : '',
      delayed ? `${delayed} 只延迟` : '',
      stale ? `${stale} 只过期` : '',
      missing ? `${missing} 只使用持仓缓存` : '',
    ].filter(Boolean);
    return parts.join('，') || '当前无持仓行情';
  }, [data]);

  if (loading)
    return <LoadingState title="正在核对持仓账" description="对齐账户、行情、推荐与通知链…" />;
  if (error) return <ErrorState message={error} />;
  if (!data) return <EmptyState title="还没有可查看的模拟盘" />;

  const valuation = data.valuation;

  return (
    <section className="catdesk-portfolio catdesk-ledger">
      <div className="catdesk-ledger__account-bar">
        <div className="catdesk-ledger__selector">
          <span>正在核对</span>
          <Select
            aria-label="选择模拟盘"
            value={selectedPortfolioId}
            onChange={setSelectedPortfolioId}
            loading={portfolioLoading}
            options={portfolios.map(item => ({
              value: item.id,
              label: `${item.name} · ${item.position_count ?? item.positions_count ?? 0} 持仓`,
            }))}
          />
        </div>
        <div className="catdesk-ledger__account-state">
          <Tag color={data.portfolio.is_active ? 'green' : 'default'}>
            {data.portfolio.is_active ? '账户运行中' : '账户已停用'}
          </Tag>
          <Tag color={data.portfolio.auto_trade_enabled ? 'purple' : 'default'}>
            自动跟单 {data.portfolio.auto_trade_enabled ? '开启' : '关闭'}
          </Tag>
          {data.unread_alerts_count ? (
            <Tag color="red">{data.unread_alerts_count} 条未读风控告警</Tag>
          ) : null}
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            重新对账
          </Button>
        </div>
      </div>

      <div className="catdesk-ledger__quote-note" data-stale={String(valuation.has_stale_quotes)}>
        <ClockCircleOutlined />
        <span>
          {quoteSummary} · 行情跨度 {dateTime(valuation.oldest_quote_at)}—
          {dateTime(valuation.newest_quote_at)} · 来源 {valuation.quote_source}
        </span>
      </div>

      {data.latest_correction_notification || data.portfolio_corrections.length ? (
        <div className="catdesk-ledger__notice is-correction" role="status">
          <SafetyCertificateOutlined />
          <div>
            <strong>
              {data.latest_correction_notification?.title || '账户存在已应用的数据更正'}
            </strong>
            <span>
              {data.portfolio_corrections.length + data.account_correction_notifications.length}{' '}
              条更正已纳入当前账户，请以本页重算结果和更正通知为准
            </span>
          </div>
        </div>
      ) : null}

      {data.latest_morning_notification ? (
        <div className="catdesk-ledger__notice">
          <BellOutlined />
          <div>
            <strong>{data.latest_morning_notification.title}</strong>
            <span>
              最近晨检通知
              {data.latest_morning_notification.invalidated
                ? '已作废，请以更正通知为准'
                : data.latest_morning_notification.corrected
                  ? '已更正'
                  : `状态：${data.latest_morning_notification.status}`}
            </span>
          </div>
        </div>
      ) : null}

      <div className="catdesk-portfolio__ledger" aria-label="账户估值概览">
        <div>
          <span>总资产</span>
          <strong>¥{money(valuation.total_value)}</strong>
        </div>
        <div>
          <span>可用资金</span>
          <strong>¥{money(valuation.current_cash)}</strong>
        </div>
        <div>
          <span>持仓市值</span>
          <strong>¥{money(valuation.position_value)}</strong>
        </div>
        <div className={valuation.total_pnl >= 0 ? 'is-up' : 'is-down'}>
          <span>累计盈亏</span>
          <strong>
            {valuation.total_pnl >= 0 ? '+' : ''}¥{money(valuation.total_pnl)}
          </strong>
          <small>
            {valuation.total_pnl_pct === null
              ? '—'
              : `${valuation.total_pnl_pct >= 0 ? '+' : ''}${valuation.total_pnl_pct.toFixed(2)}%`}
          </small>
        </div>
      </div>

      <div className="catdesk-ledger__research-strip">
        <span>
          <b>A 股早报</b>
          {data.latest_morning_brief.freshness === 'fresh'
            ? `${data.latest_morning_brief.trading_day} · ${data.positions.filter(row => row.morning_brief.matched).length} 只命中`
            : data.latest_morning_brief.freshness === 'delayed'
              ? `数据停在 ${data.latest_morning_brief.trading_day} · 已过期`
              : '暂无规范快照'}
          <a href="/catdesk?tab=morning">打开同源早报</a>
        </span>
        <span>
          <b>高倍潜力</b>
          {data.latest_multibagger?.freshness === 'fresh'
            ? `${dateTime(data.latest_multibagger.as_of)} · ${data.positions.filter(row => row.multibagger.matched).length} 只命中`
            : data.latest_multibagger
              ? `${dateTime(data.latest_multibagger.as_of)} · 研究已过期`
              : '暂无研究快照'}
          <a href="/catdesk?tab=multi">打开同源高倍研究</a>
        </span>
      </div>

      {data.positions.length === 0 ? (
        <EmptyState title="当前账户没有持仓" variant="simple" />
      ) : (
        <div className="catdesk-portfolio__table-wrap">
          <table className="catdesk-portfolio__table catdesk-ledger__table">
            <thead>
              <tr>
                <th>标的 / 行情</th>
                <th>仓位</th>
                <th>成本 / 现价</th>
                <th>市值 / 浮盈亏</th>
                <th>来源链</th>
                <th>研究交集</th>
                <th>风控与通知</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {data.positions.map(row => {
                const position = row.position;
                const pnl = row.valuation.unrealized_pnl;
                return (
                  <React.Fragment key={position.id}>
                    <tr>
                      <td>
                        <strong>{position.name}</strong>
                        <small>{position.symbol}</small>
                        <FreshnessTag row={row.quote} />
                      </td>
                      <td>{position.quantity.toLocaleString('zh-CN')} 股</td>
                      <td>
                        <span>¥{position.avg_cost.toFixed(2)}</span>
                        <small>现 ¥{row.quote.price.toFixed(2)}</small>
                      </td>
                      <td className={pnl >= 0 ? 'is-up' : 'is-down'}>
                        <span>¥{money(row.valuation.market_value)}</span>
                        <small>
                          {pnl >= 0 ? '+' : ''}¥{money(pnl)} ·{' '}
                          {row.valuation.unrealized_pnl_pct === null
                            ? '—'
                            : `${row.valuation.unrealized_pnl_pct.toFixed(2)}%`}
                        </small>
                      </td>
                      <td>
                        {row.investment_signal ? (
                          <>
                            <Tag color="orange">
                              {SOURCE_LABEL[row.investment_signal.source_type] ||
                                row.investment_signal.source_type}
                            </Tag>
                            <small>信号 #{row.investment_signal.id}</small>
                          </>
                        ) : row.trade_origin ? (
                          <>
                            <Tag color="blue">
                              {ORIGIN_LABEL[row.trade_origin.source] || row.trade_origin.source}
                            </Tag>
                            <small>成交 #{row.trade_origin.trade_id}</small>
                          </>
                        ) : (
                          <Tag color="red">来源未记录</Tag>
                        )}
                      </td>
                      <td>
                        <Tag
                          color={
                            row.morning_brief.freshness !== 'fresh'
                              ? row.morning_brief.freshness === 'delayed'
                                ? 'gold'
                                : 'default'
                              : row.morning_brief.matched
                                ? 'green'
                                : 'default'
                          }
                        >
                          早报 {researchTagLabel(row.morning_brief)}
                        </Tag>
                        <Tag
                          color={
                            row.multibagger.freshness !== 'fresh'
                              ? row.multibagger.freshness === 'delayed'
                                ? 'gold'
                                : 'default'
                              : row.multibagger.matched
                                ? 'purple'
                                : 'default'
                          }
                        >
                          高倍 {researchTagLabel(row.multibagger)}
                        </Tag>
                      </td>
                      <td>
                        {row.alerts.some(item => !item.is_read) ? (
                          <Tag color="red">
                            {row.alerts.filter(item => !item.is_read).length} 未读
                          </Tag>
                        ) : (
                          <Tag>无未读告警</Tag>
                        )}
                        {row.corrections.length ? (
                          <Tag color="orange">{row.corrections.length} 更正</Tag>
                        ) : null}
                      </td>
                      <td>
                        <Button
                          type="text"
                          icon={<RobotOutlined />}
                          onClick={() => setAnalysisTarget(row)}
                        >
                          AI 解读
                        </Button>
                      </td>
                    </tr>
                    <tr className="catdesk-ledger__expand-row">
                      <td colSpan={8}>
                        <details>
                          <summary>展开成交 → 推荐 → 通知 → 更正完整链路</summary>
                          <PositionDetail row={row} />
                        </details>
                      </td>
                    </tr>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {analysisTarget ? (
        <AIStockAnalysisModal
          open
          onClose={() => setAnalysisTarget(null)}
          stockCode={analysisTarget.position.symbol}
          stockName={analysisTarget.position.name}
          taskLabel="catdesk_portfolio_ledger"
        />
      ) : null}
    </section>
  );
}
