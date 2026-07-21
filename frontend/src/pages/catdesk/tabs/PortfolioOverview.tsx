import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Tag } from 'antd';
import { ReloadOutlined, RobotOutlined } from '@ant-design/icons';
import AIStockAnalysisModal from '../../../components/trading/AIStockAnalysisModal';
import { usePortfolio } from '../../../contexts/PortfolioContext';
import {
  portfolioWorkspaceService,
  type PortfolioWithPositions,
  type PositionRow,
} from '../../../services/portfolioWorkspaceService';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import { LoadingState } from '../shared/LoadingState';

const money = (value: number) =>
  Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export default function PortfolioOverview() {
  const { selectedPortfolioId, portfolios } = usePortfolio();
  const [data, setData] = useState<PortfolioWithPositions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [analysisTarget, setAnalysisTarget] = useState<PositionRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await portfolioWorkspaceService.getPortfolio(selectedPortfolioId));
    } catch (err) {
      setError(err instanceof Error ? err.message : '持仓数据加载失败');
    } finally {
      setLoading(false);
    }
  }, [selectedPortfolioId]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => {
    const portfolio = data?.portfolio;
    const positionValue = (data?.positions || []).reduce(
      (total, position) => total + Number(position.market_value || 0),
      0
    );
    const totalValue = Number(portfolio?.total_value || 0);
    const initial = Number(portfolio?.initial_capital || 0);
    const pnl = totalValue - initial;
    return { positionValue, totalValue, pnl, pnlPct: initial > 0 ? (pnl / initial) * 100 : 0 };
  }, [data]);

  if (loading) {
    return <LoadingState title="正在清点持仓" description="同步资金、仓位与最新价格…" />;
  }
  if (error) return <ErrorState message={error} />;
  if (!data) return <EmptyState title="还没有可查看的模拟盘" />;

  return (
    <section className="catdesk-portfolio">
      <div className="catdesk-portfolio__toolbar">
        <div>
          <span>当前账户</span>
          <strong>
            {data.portfolio.name ||
              portfolios.find(row => row.id === selectedPortfolioId)?.name ||
              '模拟盘'}
          </strong>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          刷新
        </Button>
      </div>

      <div className="catdesk-portfolio__ledger" aria-label="账户概览">
        <div>
          <span>总资产</span>
          <strong>¥{money(summary.totalValue)}</strong>
        </div>
        <div>
          <span>可用资金</span>
          <strong>¥{money(Number(data.portfolio.current_cash))}</strong>
        </div>
        <div>
          <span>持仓市值</span>
          <strong>¥{money(summary.positionValue)}</strong>
        </div>
        <div className={summary.pnl >= 0 ? 'is-up' : 'is-down'}>
          <span>累计盈亏</span>
          <strong>
            {summary.pnl >= 0 ? '+' : ''}¥{money(summary.pnl)}
          </strong>
          <small>
            {summary.pnlPct >= 0 ? '+' : ''}
            {summary.pnlPct.toFixed(2)}%
          </small>
        </div>
      </div>

      {data.positions.length === 0 ? (
        <EmptyState title="当前账户没有持仓" variant="simple" />
      ) : (
        <div className="catdesk-portfolio__table-wrap">
          <table className="catdesk-portfolio__table">
            <thead>
              <tr>
                <th>标的</th>
                <th>数量</th>
                <th>成本 / 现价</th>
                <th>市值</th>
                <th>浮动盈亏</th>
                <th>保护线</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {data.positions.map(position => {
                const cost = Number(position.avg_cost || 0);
                const price = Number(position.current_price || 0);
                const pnl = Number(position.unrealized_pnl || 0);
                const pnlPct = cost > 0 ? ((price - cost) / cost) * 100 : 0;
                return (
                  <tr key={position.id}>
                    <td>
                      <strong>{position.name || position.symbol}</strong>
                      <small>{position.symbol}</small>
                    </td>
                    <td>{Number(position.quantity).toLocaleString('zh-CN')} 股</td>
                    <td>
                      <span>¥{cost.toFixed(2)}</span>
                      <small>现 ¥{price.toFixed(2)}</small>
                    </td>
                    <td>¥{money(Number(position.market_value))}</td>
                    <td className={pnl >= 0 ? 'is-up' : 'is-down'}>
                      <strong>
                        {pnl >= 0 ? '+' : ''}¥{money(pnl)}
                      </strong>
                      <small>
                        {pnlPct >= 0 ? '+' : ''}
                        {pnlPct.toFixed(2)}%
                      </small>
                    </td>
                    <td>
                      {position.stop_loss_price ? (
                        <Tag color="red">损 ¥{Number(position.stop_loss_price).toFixed(2)}</Tag>
                      ) : null}
                      {position.take_profit_price ? (
                        <Tag color="green">盈 ¥{Number(position.take_profit_price).toFixed(2)}</Tag>
                      ) : null}
                      {!position.stop_loss_price && !position.take_profit_price ? '—' : null}
                    </td>
                    <td>
                      <Button
                        type="text"
                        icon={<RobotOutlined />}
                        onClick={() => setAnalysisTarget(position)}
                      >
                        AI 解读
                      </Button>
                    </td>
                  </tr>
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
          stockCode={analysisTarget.symbol}
          stockName={analysisTarget.name}
          taskLabel="catdesk_portfolio"
        />
      ) : null}
    </section>
  );
}
