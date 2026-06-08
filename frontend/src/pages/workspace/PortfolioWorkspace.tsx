import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  List,
  Popconfirm,
  Radio,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  EditOutlined,
  LineChartOutlined,
  ReadOutlined,
  ReloadOutlined,
  RobotOutlined,
  StopOutlined,
  UnorderedListOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import dayjs, { Dayjs } from 'dayjs';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import AIStockAnalysisModal from '../../components/trading/AIStockAnalysisModal';
import {
  portfolioWorkspaceService,
  PortfolioWithPositions,
  PositionRow,
  SnapshotRow,
  TradeRow,
  JournalSummary,
  JournalDetail,
  BenchmarkHistoryPoint,
} from '../../services/portfolioWorkspaceService';

const { Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;
const { TextArea } = Input;

/**
 * 持仓与复盘工作区 (Portfolio Workspace) — US-017 完整实现。
 *
 * 4 个 tab：
 *  - 当前持仓：表格 + 一键平仓 + inline 设置止损价
 *  - 资金曲线：净值 vs 沪深 300 + KPI 卡（总收益/年化/夏普/最大回撤/当月）
 *  - 交易明细：分页表格 + 方向/日期筛选
 *  - 复盘日记：左侧日期列表 + 右侧 detail + 追加手记
 *
 * 数据装载：mount 时 Promise.all 加载 portfolio + snapshots + trades + journal list
 *   →顶部 KPI strip 一次性绘制。Tab 切换不重新 fetch。复盘日记 detail
 *   按日期 lazy fetch。沪深 300 在切换"资金曲线" tab 时按需 fetch
 *   (避免登录即拉数据，加快首次加载)。
 */

const BENCHMARK_SYMBOL = 'sh.000300';
const BENCHMARK_LABEL = '沪深 300';

type WindowKey = '30d' | '90d' | '1y' | 'all';

const PortfolioWorkspace: React.FC = () => {
  const tabs: WorkspaceTab[] = [
    { key: 'positions', label: '当前持仓', icon: <WalletOutlined /> },
    { key: 'equity', label: '资金曲线', icon: <LineChartOutlined /> },
    { key: 'trades', label: '交易明细', icon: <UnorderedListOutlined /> },
    { key: 'journal', label: '复盘日记', icon: <ReadOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState<string>('positions');

  // ---- 主数据 ----
  const [portfolioData, setPortfolioData] = useState<PortfolioWithPositions | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [journalList, setJournalList] = useState<JournalSummary[]>([]);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [pf, snaps, trd, jrn] = await Promise.all([
        portfolioWorkspaceService.getPortfolio(),
        portfolioWorkspaceService.getSnapshots(),
        portfolioWorkspaceService.getTradeHistory(),
        portfolioWorkspaceService.listJournals(),
      ]);
      setPortfolioData(pf);
      setSnapshots(snaps);
      setTrades(trd);
      setJournalList(jrn);
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      setLoadError(messageStr);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- 顶部 KPI 计算 ----
  const kpis = useMemo(() => {
    const positions = portfolioData?.positions || [];
    const totalValue = Number(portfolioData?.portfolio.total_value || 0);
    const cash = Number(portfolioData?.portfolio.current_cash || 0);
    const todayUnrealized = positions.reduce((acc, p) => acc + Number(p.unrealized_pnl || 0), 0);
    const equity = snapshots.map(s => Number(s.total_value));
    const dailyReturns = computeDailyReturns(equity);
    const maxDrawdownPct = equity.length >= 2 ? computeMaxDrawdownPct(equity) : 0;
    const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');
    const monthSnaps = snapshots.filter(s => s.date >= monthStart);
    const monthReturnPct =
      monthSnaps.length >= 2
        ? (Number(monthSnaps[monthSnaps.length - 1].total_value) /
            Number(monthSnaps[0].total_value) -
            1) *
          100
        : 0;
    const totalReturnPct =
      snapshots.length >= 2
        ? (Number(snapshots[snapshots.length - 1].total_value) / Number(snapshots[0].total_value) -
            1) *
          100
        : 0;
    const annualizedReturnPct = annualizeReturnPct(snapshots);
    const sharpe = computeSharpeRatio(dailyReturns);
    return {
      positionCount: positions.length,
      totalValue,
      cash,
      todayUnrealized,
      monthReturnPct,
      maxDrawdownPct,
      totalReturnPct,
      annualizedReturnPct,
      sharpe,
    };
  }, [portfolioData, snapshots]);

  const kpiSlot = (
    <Space size={32}>
      <Statistic title="当前持仓" value={kpis.positionCount} suffix="只" />
      <Statistic
        title="浮动盈亏"
        value={kpis.todayUnrealized}
        precision={2}
        prefix="¥"
        valueStyle={{ color: pnlColor(kpis.todayUnrealized) }}
      />
      <Statistic
        title="当月收益"
        value={kpis.monthReturnPct}
        precision={2}
        suffix="%"
        valueStyle={{ color: pnlColor(kpis.monthReturnPct) }}
      />
      <Statistic
        title="最大回撤"
        value={kpis.maxDrawdownPct}
        precision={2}
        suffix="%"
        valueStyle={{ color: '#cf1322' }}
      />
    </Space>
  );

  const headerActions = (
    <Space>
      <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
        刷新
      </Button>
    </Space>
  );

  let body: React.ReactNode;
  if (loading && !portfolioData) {
    body = (
      <Card>
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin tip="加载持仓与复盘数据中..." />
        </div>
      </Card>
    );
  } else if (loadError) {
    body = (
      <Alert
        type="error"
        showIcon
        message="加载失败"
        description={loadError}
        action={
          <Button size="small" onClick={() => void refresh()}>
            重试
          </Button>
        }
      />
    );
  } else if (activeKey === 'positions') {
    body = (
      <PositionsTab
        data={portfolioData}
        onChangeData={setPortfolioData}
        onAfterTrade={() => void refresh()}
      />
    );
  } else if (activeKey === 'equity') {
    body = <EquityCurveTab snapshots={snapshots} kpis={kpis} />;
  } else if (activeKey === 'trades') {
    body = <TradesTab trades={trades} />;
  } else if (activeKey === 'journal') {
    body = <JournalTab list={journalList} onListRefresh={() => void refresh()} />;
  } else {
    body = null;
  }

  return (
    <WorkspaceLayout
      title="持仓与复盘"
      subtitle="模拟盘持仓、资金曲线、交易明细与复盘日记 — 赚亏闭环。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={setActiveKey}
      kpiSlot={kpiSlot}
      headerActions={headerActions}
    >
      {body}
    </WorkspaceLayout>
  );
};

export default PortfolioWorkspace;

// ===========================================================================
//  Tab 1: 当前持仓
// ===========================================================================
interface PositionsTabProps {
  data: PortfolioWithPositions | null;
  onChangeData: (data: PortfolioWithPositions) => void;
  onAfterTrade: () => void;
}

const PositionsTab: React.FC<PositionsTabProps> = ({ data, onChangeData, onAfterTrade }) => {
  // US-076 — 编辑 state 扩展为 (positionId, field) tuple，止损与止盈复用同一套
  // 编辑 / 保存 / 取消机制，避免两个独立 state 各管一边导致同行同时进入两个编辑态。
  const [editingPositionId, setEditingPositionId] = useState<number | null>(null);
  const [editingField, setEditingField] = useState<'stop_loss' | 'take_profit' | null>(null);
  const [editingValue, setEditingValue] = useState<number | null>(null);
  const [savingLimit, setSavingLimit] = useState(false);
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  // US-055 — AI 解读 modal target
  const [aiTarget, setAiTarget] = useState<{ symbol: string; name: string | null } | null>(null);

  const positions = data?.positions || [];
  const totalValue = Number(data?.portfolio.total_value || 0);

  const handleStartEdit = (row: PositionRow, field: 'stop_loss' | 'take_profit') => {
    setEditingPositionId(row.id);
    setEditingField(field);
    const initial =
      field === 'stop_loss'
        ? row.stop_loss_price !== null
          ? Number(row.stop_loss_price)
          : null
        : row.take_profit_price !== null
        ? Number(row.take_profit_price)
        : null;
    setEditingValue(initial);
  };

  const handleCancelEdit = () => {
    setEditingPositionId(null);
    setEditingField(null);
    setEditingValue(null);
  };

  const handleSaveStopLoss = async (row: PositionRow) => {
    setSavingLimit(true);
    try {
      const result = await portfolioWorkspaceService.setPositionStopLoss(row.id, {
        stop_loss_price: editingValue,
      });
      if (data) {
        const next: PortfolioWithPositions = {
          ...data,
          positions: data.positions.map(p =>
            p.id === row.id ? { ...p, stop_loss_price: result.stop_loss_price } : p
          ),
        };
        onChangeData(next);
      }
      message.success(
        result.stop_loss_price === null
          ? '已清除止损价'
          : `${row.name || row.symbol} 止损价 ¥${result.stop_loss_price}`
      );
      handleCancelEdit();
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      message.error(messageStr);
    } finally {
      setSavingLimit(false);
    }
  };

  const handleSaveTakeProfit = async (row: PositionRow) => {
    setSavingLimit(true);
    try {
      const result = await portfolioWorkspaceService.setPositionTakeProfit(row.id, {
        take_profit_price: editingValue,
      });
      if (data) {
        const next: PortfolioWithPositions = {
          ...data,
          positions: data.positions.map(p =>
            p.id === row.id ? { ...p, take_profit_price: result.take_profit_price } : p
          ),
        };
        onChangeData(next);
      }
      message.success(
        result.take_profit_price === null
          ? '已清除止盈价'
          : `${row.name || row.symbol} 止盈价 ¥${result.take_profit_price}`
      );
      handleCancelEdit();
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      message.error(messageStr);
    } finally {
      setSavingLimit(false);
    }
  };

  const handleClosePosition = async (row: PositionRow) => {
    setClosingSymbol(row.symbol);
    try {
      const result = await portfolioWorkspaceService.placeTrade({
        symbol: row.symbol,
        direction: 'SELL',
        quantity: row.quantity,
      });
      const pnl = result.realized_pnl ?? 0;
      message.success(
        `已平仓 ${row.name || row.symbol}：成交价 ¥${result.execute_price.toFixed(2)}，实现盈亏 ${
          pnl >= 0 ? '+' : ''
        }¥${pnl.toFixed(2)}`
      );
      onAfterTrade();
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      message.error(messageStr);
    } finally {
      setClosingSymbol(null);
    }
  };

  if (positions.length === 0) {
    return (
      <Card>
        <Empty
          description={
            <Space direction="vertical" align="center">
              <Text>当前没有持仓。</Text>
              <Text type="secondary">
                到「今日作战」工作区一键应用策略信号，或在「策略实验室」运行回测后落地实盘。
              </Text>
            </Space>
          }
        />
      </Card>
    );
  }

  const columns = [
    {
      title: '代码',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 110,
      render: (v: string) => <Text code>{v}</Text>,
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 120,
      render: (v: string | null, row: PositionRow) => v || row.symbol,
    },
    {
      title: '买入日',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 110,
      render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD') : '-'),
    },
    {
      title: '买入价',
      dataIndex: 'avg_cost',
      key: 'avg_cost',
      width: 90,
      align: 'right' as const,
      render: (v: number) => `¥${Number(v).toFixed(2)}`,
    },
    {
      title: '现价',
      dataIndex: 'current_price',
      key: 'current_price',
      width: 90,
      align: 'right' as const,
      render: (v: number) => `¥${Number(v).toFixed(2)}`,
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 80,
      align: 'right' as const,
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '浮盈',
      dataIndex: 'unrealized_pnl',
      key: 'unrealized_pnl',
      width: 150,
      align: 'right' as const,
      render: (_: any, row: PositionRow) => {
        const pnl = Number(row.unrealized_pnl);
        const cost = Number(row.avg_cost) * Number(row.quantity);
        const pct = cost > 0 ? (pnl / cost) * 100 : 0;
        return (
          <Space size={4}>
            <span style={{ color: pnlColor(pnl), fontWeight: 500 }}>
              {pnl >= 0 ? '+' : ''}¥{pnl.toFixed(2)}
            </span>
            <Tag color={pnl >= 0 ? 'green' : 'red'} style={{ marginLeft: 4 }}>
              {pct >= 0 ? '+' : ''}
              {pct.toFixed(2)}%
            </Tag>
          </Space>
        );
      },
    },
    {
      title: '占比',
      key: 'weight',
      width: 90,
      align: 'right' as const,
      render: (_: any, row: PositionRow) => {
        if (totalValue <= 0) return '-';
        const w = (Number(row.market_value) / totalValue) * 100;
        return `${w.toFixed(2)}%`;
      },
    },
    {
      title: '止损价',
      key: 'stop_loss',
      width: 200,
      render: (_: any, row: PositionRow) => {
        const currentPrice = Number(row.current_price);
        if (editingPositionId === row.id && editingField === 'stop_loss') {
          return (
            <Space size={4}>
              <InputNumber
                value={editingValue}
                onChange={v => setEditingValue(v as number | null)}
                min={0}
                step={0.01}
                precision={2}
                placeholder="留空清除"
                style={{ width: 110 }}
                size="small"
              />
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                loading={savingLimit}
                onClick={() => void handleSaveStopLoss(row)}
              />
              <Button size="small" icon={<CloseOutlined />} onClick={handleCancelEdit} />
            </Space>
          );
        }
        const stopLoss = row.stop_loss_price !== null ? Number(row.stop_loss_price) : null;
        // 止损价 ≥ 现价 = 警告（下一交易日开盘可能立即触发）
        const isAboveCurrent = stopLoss !== null && stopLoss >= currentPrice;
        return (
          <Space size={4}>
            {stopLoss === null ? (
              <Text type="secondary">未设置</Text>
            ) : (
              <Tooltip
                title={
                  isAboveCurrent
                    ? '止损价已 ≥ 当前现价，下一交易日开盘可能立即触发'
                    : `距现价 ${(((currentPrice - stopLoss) / currentPrice) * 100).toFixed(2)}%`
                }
              >
                <Tag color={isAboveCurrent ? 'red' : 'orange'}>¥{stopLoss.toFixed(2)}</Tag>
              </Tooltip>
            )}
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => handleStartEdit(row, 'stop_loss')}
            />
          </Space>
        );
      },
    },
    {
      // US-076 — 止盈价：止损的对偶，现价 ≥ 止盈价时变绿提示用户考虑减仓
      title: '止盈价',
      key: 'take_profit',
      width: 200,
      render: (_: any, row: PositionRow) => {
        const currentPrice = Number(row.current_price);
        if (editingPositionId === row.id && editingField === 'take_profit') {
          return (
            <Space size={4}>
              <InputNumber
                value={editingValue}
                onChange={v => setEditingValue(v as number | null)}
                min={0}
                step={0.01}
                precision={2}
                placeholder="留空清除"
                style={{ width: 110 }}
                size="small"
              />
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                loading={savingLimit}
                onClick={() => void handleSaveTakeProfit(row)}
              />
              <Button size="small" icon={<CloseOutlined />} onClick={handleCancelEdit} />
            </Space>
          );
        }
        const takeProfit = row.take_profit_price !== null ? Number(row.take_profit_price) : null;
        // 止盈价 ≤ 现价 = 绿色提示（目标已达 / 应考虑减仓）
        const isReached = takeProfit !== null && takeProfit <= currentPrice;
        return (
          <Space size={4}>
            {takeProfit === null ? (
              <Text type="secondary">未设置</Text>
            ) : (
              <Tooltip
                title={
                  isReached
                    ? '现价已 ≥ 止盈价，目标已达成，可考虑减仓或平仓'
                    : `距现价 ${(((takeProfit - currentPrice) / currentPrice) * 100).toFixed(2)}%`
                }
              >
                <Tag color={isReached ? 'green' : 'blue'}>¥{takeProfit.toFixed(2)}</Tag>
              </Tooltip>
            )}
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => handleStartEdit(row, 'take_profit')}
            />
          </Space>
        );
      },
    },
    {
      title: '所属策略',
      key: 'strategy',
      width: 110,
      // 真正的策略归属来自 PaperTradingAttribution / RecommendationOutcome 链路；
      // 这里用占位"手动"，待 US-088 完善游资归属 / signal→position join 后再展开。
      render: () => <Tag>手动</Tag>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_: any, row: PositionRow) => (
        <Space size="small">
          <Button
            size="small"
            icon={<RobotOutlined />}
            onClick={() => setAiTarget({ symbol: row.symbol, name: row.name || null })}
            title="AI 解读：基本面 / 技术面 / 资金面 / 新闻面 / 情绪面"
          >
            AI 解读
          </Button>
          <Popconfirm
            title={`确认平仓 ${row.name || row.symbol} 全部 ${row.quantity.toLocaleString()} 股？`}
            okText="平仓"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleClosePosition(row)}
          >
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              loading={closingSymbol === row.symbol}
            >
              平仓
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={
        <Space>
          <WalletOutlined />
          <span>当前持仓 · {positions.length} 只</span>
          <Tag color="blue">
            总市值 ¥{positions.reduce((acc, p) => acc + Number(p.market_value), 0).toLocaleString()}
          </Tag>
          <Tag>现金 ¥{Number(data?.portfolio.current_cash || 0).toLocaleString()}</Tag>
        </Space>
      }
    >
      <Table<PositionRow>
        rowKey="id"
        size="middle"
        dataSource={positions}
        columns={columns as any}
        pagination={false}
        scroll={{ x: 1480 }}
      />
      {aiTarget && (
        <AIStockAnalysisModal
          open={!!aiTarget}
          onClose={() => setAiTarget(null)}
          stockCode={aiTarget.symbol}
          stockName={aiTarget.name}
          taskLabel="portfolio_position"
        />
      )}
    </Card>
  );
};

// ===========================================================================
//  Tab 2: 资金曲线
// ===========================================================================
interface EquityCurveTabProps {
  snapshots: SnapshotRow[];
  kpis: {
    totalReturnPct: number;
    annualizedReturnPct: number;
    sharpe: number;
    maxDrawdownPct: number;
    monthReturnPct: number;
  };
}

const EquityCurveTab: React.FC<EquityCurveTabProps> = ({ snapshots, kpis }) => {
  const [windowKey, setWindowKey] = useState<WindowKey>('all');
  const [benchmarkSeries, setBenchmarkSeries] = useState<BenchmarkHistoryPoint[]>([]);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);

  const sliced = useMemo(
    () => sliceSnapshotsByWindow(snapshots, windowKey),
    [snapshots, windowKey]
  );

  useEffect(() => {
    if (sliced.length === 0) {
      setBenchmarkSeries([]);
      return;
    }
    const startDate = sliced[0].date;
    const endDate = sliced[sliced.length - 1].date;
    setBenchmarkLoading(true);
    setBenchmarkError(null);
    portfolioWorkspaceService
      .fetchBenchmarkHistory(BENCHMARK_SYMBOL, startDate, endDate)
      .then(setBenchmarkSeries)
      .catch((err: unknown) => {
        const messageStr = err instanceof Error ? err.message : String(err);
        setBenchmarkError(messageStr);
        setBenchmarkSeries([]);
      })
      .finally(() => setBenchmarkLoading(false));
  }, [sliced]);

  const chartData = useMemo(() => {
    if (sliced.length === 0) return [];
    const baseValue = Number(sliced[0].total_value);
    const benchmarkBase = benchmarkSeries[0]?.close ?? 0;
    const benchmarkByDate = new Map<string, number>();
    benchmarkSeries.forEach(p => benchmarkByDate.set(p.date, p.close));
    return sliced.map(s => {
      const myNetValue = baseValue > 0 ? (Number(s.total_value) / baseValue) * 100 : 100;
      const bClose = benchmarkByDate.get(s.date);
      const benchmarkNetValue =
        bClose !== undefined && benchmarkBase > 0 ? (bClose / benchmarkBase) * 100 : null;
      return {
        date: s.date,
        my: Number(myNetValue.toFixed(4)),
        benchmark: benchmarkNetValue !== null ? Number(benchmarkNetValue.toFixed(4)) : null,
      };
    });
  }, [sliced, benchmarkSeries]);

  if (snapshots.length === 0) {
    return (
      <Card>
        <Empty
          description={
            <Space direction="vertical" align="center">
              <Text>暂无资金曲线快照。</Text>
              <Text type="secondary">
                下一笔交易完成后会自动写入今日 snapshot，多日累计即可看到走势。
              </Text>
            </Space>
          }
        />
      </Card>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            <LineChartOutlined />
            <span>净值曲线 vs {BENCHMARK_LABEL}（首日归一化为 100）</span>
            {benchmarkLoading && <Tag color="processing">基准加载中</Tag>}
          </Space>
        }
        extra={
          <Segmented<WindowKey>
            options={[
              { label: '近 30 日', value: '30d' },
              { label: '近 90 日', value: '90d' },
              { label: '近 1 年', value: '1y' },
              { label: '全部', value: 'all' },
            ]}
            value={windowKey}
            onChange={v => setWindowKey(v as WindowKey)}
          />
        }
      >
        {benchmarkError && (
          <Alert
            type="warning"
            showIcon
            message="基准指数加载失败"
            description={benchmarkError}
            style={{ marginBottom: 12 }}
          />
        )}
        <div style={{ width: '100%', height: 340 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 12, right: 20, left: 0, bottom: 12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={32} />
              <YAxis
                domain={['dataMin - 1', 'dataMax + 1']}
                tick={{ fontSize: 11 }}
                tickFormatter={(v: number) => `${v.toFixed(1)}`}
              />
              <RechartsTooltip
                formatter={(value: number) => [`${value.toFixed(2)}`, '净值']}
                labelFormatter={(label: string) => `日期：${label}`}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="my"
                name="我的净值"
                stroke="#1677ff"
                dot={false}
                strokeWidth={2}
              />
              <Line
                type="monotone"
                dataKey="benchmark"
                name={BENCHMARK_LABEL}
                stroke="#ff7a45"
                dot={false}
                strokeWidth={2}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card title="绩效指标">
        <Row gutter={[16, 16]}>
          <Col xs={12} sm={8} md={5}>
            <Statistic
              title="总收益"
              value={kpis.totalReturnPct}
              precision={2}
              suffix="%"
              valueStyle={{ color: pnlColor(kpis.totalReturnPct) }}
            />
          </Col>
          <Col xs={12} sm={8} md={5}>
            <Statistic
              title="年化收益"
              value={kpis.annualizedReturnPct}
              precision={2}
              suffix="%"
              valueStyle={{ color: pnlColor(kpis.annualizedReturnPct) }}
            />
          </Col>
          <Col xs={12} sm={8} md={5}>
            <Statistic
              title="最大回撤"
              value={kpis.maxDrawdownPct}
              precision={2}
              suffix="%"
              valueStyle={{ color: '#cf1322' }}
            />
          </Col>
          <Col xs={12} sm={8} md={5}>
            <Statistic
              title="夏普率"
              value={kpis.sharpe}
              precision={2}
              valueStyle={{ color: kpis.sharpe >= 1 ? '#3f8600' : undefined }}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic
              title="当月收益"
              value={kpis.monthReturnPct}
              precision={2}
              suffix="%"
              valueStyle={{ color: pnlColor(kpis.monthReturnPct) }}
            />
          </Col>
        </Row>
      </Card>
    </Space>
  );
};

// ===========================================================================
//  Tab 3: 交易明细
// ===========================================================================
interface TradesTabProps {
  trades: TradeRow[];
}

const TradesTab: React.FC<TradesTabProps> = ({ trades }) => {
  const [directionFilter, setDirectionFilter] = useState<'all' | 'BUY' | 'SELL'>('all');
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [strategyFilter, setStrategyFilter] = useState<string>('all');

  const filtered = useMemo(() => {
    return trades.filter(t => {
      if (directionFilter !== 'all' && t.direction !== directionFilter) return false;
      if (dateRange && dateRange[0] && dateRange[1]) {
        const day = dayjs(t.created_at);
        if (day.isBefore(dateRange[0], 'day') || day.isAfter(dateRange[1], 'day')) return false;
      }
      // 策略筛选当前为 placeholder：仅 BUY = "手动 / 自动跟单" 流水
      // 真正策略归属来自 QuantSignal join (US-088 之后)
      if (strategyFilter === 'manual' && t.realized_pnl !== null) return false;
      return true;
    });
  }, [trades, directionFilter, dateRange, strategyFilter]);

  if (trades.length === 0) {
    return (
      <Card>
        <Empty description="暂无交易记录" />
      </Card>
    );
  }

  const columns = [
    {
      title: '日期',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
      defaultSortOrder: 'descend' as const,
      sorter: (a: TradeRow, b: TradeRow) =>
        dayjs(a.created_at).valueOf() - dayjs(b.created_at).valueOf(),
    },
    {
      title: '代码',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 110,
      render: (v: string) => <Text code>{v}</Text>,
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 120,
    },
    {
      title: '方向',
      dataIndex: 'direction',
      key: 'direction',
      width: 80,
      render: (v: string) =>
        v === 'BUY' ? <Tag color="green">买入</Tag> : <Tag color="red">卖出</Tag>,
    },
    {
      title: '成交价',
      dataIndex: 'execute_price',
      key: 'execute_price',
      width: 100,
      align: 'right' as const,
      render: (v: number) => `¥${Number(v).toFixed(2)}`,
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 90,
      align: 'right' as const,
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      width: 120,
      align: 'right' as const,
      render: (v: number) => `¥${Number(v).toLocaleString()}`,
    },
    {
      title: '手续费',
      dataIndex: 'commission',
      key: 'commission',
      width: 90,
      align: 'right' as const,
      render: (v: number) => `¥${Number(v).toFixed(2)}`,
    },
    {
      title: '实现盈亏',
      dataIndex: 'realized_pnl',
      key: 'realized_pnl',
      width: 120,
      align: 'right' as const,
      render: (v: number | null) => {
        if (v === null || v === undefined) return <Text type="secondary">-</Text>;
        return (
          <span style={{ color: pnlColor(v), fontWeight: 500 }}>
            {v >= 0 ? '+' : ''}¥{Number(v).toFixed(2)}
          </span>
        );
      },
    },
  ];

  return (
    <Card
      title={
        <Space>
          <UnorderedListOutlined />
          <span>交易明细 · 共 {filtered.length} 笔（最近 100 条）</span>
        </Space>
      }
      extra={
        <Space wrap>
          <Radio.Group
            value={directionFilter}
            onChange={e => setDirectionFilter(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            size="small"
          >
            <Radio.Button value="all">全部</Radio.Button>
            <Radio.Button value="BUY">买入</Radio.Button>
            <Radio.Button value="SELL">卖出</Radio.Button>
          </Radio.Group>
          <Select
            size="small"
            value={strategyFilter}
            onChange={setStrategyFilter}
            style={{ width: 140 }}
            options={[
              { label: '全部策略', value: 'all' },
              { label: '仅 BUY 流水', value: 'manual' },
            ]}
          />
          <RangePicker
            size="small"
            value={dateRange as any}
            onChange={v => setDateRange(v as any)}
            allowClear
          />
        </Space>
      }
    >
      <Table<TradeRow>
        rowKey="id"
        size="middle"
        dataSource={filtered}
        columns={columns as any}
        scroll={{ x: 1010 }}
        pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }}
      />
    </Card>
  );
};

// ===========================================================================
//  Tab 4: 复盘日记
// ===========================================================================
interface JournalTabProps {
  list: JournalSummary[];
  onListRefresh: () => void;
}

const JournalTab: React.FC<JournalTabProps> = ({ list, onListRefresh }) => {
  const [selectedDate, setSelectedDate] = useState<string | null>(
    list.length > 0 ? list[0].date : null
  );
  const [detail, setDetail] = useState<JournalDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [noteContent, setNoteContent] = useState('');
  const [appending, setAppending] = useState(false);

  useEffect(() => {
    if (!selectedDate) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    portfolioWorkspaceService
      .getJournalDetail(selectedDate)
      .then(d => setDetail(d))
      .catch((err: unknown) => {
        const messageStr = err instanceof Error ? err.message : String(err);
        setDetailError(messageStr);
      })
      .finally(() => setDetailLoading(false));
  }, [selectedDate]);

  const handleAppend = async () => {
    if (!selectedDate || !noteContent.trim()) {
      message.warning('请先选择日期并输入手记内容');
      return;
    }
    setAppending(true);
    try {
      const result = await portfolioWorkspaceService.appendJournalNote(selectedDate, noteContent);
      message.success('已追加手记');
      setNoteContent('');
      setDetail(prev => (prev ? { ...prev, user_notes: result.user_notes } : prev));
      const hasDate = list.some(j => j.date === selectedDate);
      if (!hasDate) {
        onListRefresh();
      }
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      message.error(messageStr);
    } finally {
      setAppending(false);
    }
  };

  return (
    <Row gutter={16}>
      <Col xs={24} md={8} lg={6}>
        <Card
          size="small"
          title={
            <Space>
              <ReadOutlined />
              <span>日期列表</span>
            </Space>
          }
          extra={
            <DatePicker
              size="small"
              allowClear
              placeholder="选择任意日"
              value={selectedDate ? dayjs(selectedDate) : null}
              onChange={d => setSelectedDate(d ? d.format('YYYY-MM-DD') : null)}
            />
          }
        >
          {list.length === 0 ? (
            <Empty
              description={
                <Text type="secondary">
                  暂无 AI 复盘。可直接在日期选择器选任意日，追加手记自动建档。
                </Text>
              }
            />
          ) : (
            <List
              size="small"
              dataSource={list}
              renderItem={(item: JournalSummary) => (
                <List.Item
                  onClick={() => setSelectedDate(item.date)}
                  style={{
                    cursor: 'pointer',
                    background: selectedDate === item.date ? '#e6f4ff' : 'transparent',
                    padding: '6px 12px',
                    borderRadius: 6,
                  }}
                >
                  <Space>
                    <Text strong>{item.date}</Text>
                    {item.mood && item.mood !== '未生成' ? (
                      <Tag color="purple">{item.mood}</Tag>
                    ) : (
                      <Tag>无 AI 总结</Tag>
                    )}
                  </Space>
                </List.Item>
              )}
            />
          )}
        </Card>
      </Col>
      <Col xs={24} md={16} lg={18}>
        <Card
          size="small"
          title={
            <Space>
              <ReadOutlined />
              <span>{selectedDate ? `${selectedDate} 复盘` : '请选择日期'}</span>
              {detail?.mood && detail.mood !== '未生成' && <Tag color="purple">{detail.mood}</Tag>}
            </Space>
          }
        >
          {detailLoading ? (
            <div style={{ textAlign: 'center', padding: 32 }}>
              <Spin />
            </div>
          ) : detailError ? (
            <Alert type="error" showIcon message="加载日记失败" description={detailError} />
          ) : !selectedDate ? (
            <Empty description="左侧点击日期或上方选择任意日" />
          ) : !detail ? (
            <Empty
              description={
                <Space direction="vertical" align="center">
                  <Text type="secondary">该日期还没有复盘记录。</Text>
                  <Text type="secondary">AI 自动复盘待 US-087 实现；在下方输入手记即可建档。</Text>
                </Space>
              }
            />
          ) : (
            <Space direction="vertical" size={20} style={{ width: '100%' }}>
              <JournalSection title="市场总结" content={detail.market_summary} />
              <JournalSection title="持仓点评" content={detail.portfolio_analysis} />
              {detail.action_plan && (
                <JournalSection title="明日策略" content={detail.action_plan} />
              )}
              {detail.tags && detail.tags.length > 0 && (
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
                    标签：
                  </Text>
                  <Space wrap>
                    {detail.tags.map(t => (
                      <Tag key={t}>{t}</Tag>
                    ))}
                  </Space>
                </div>
              )}
              <div>
                <Text strong style={{ display: 'block', marginBottom: 8 }}>
                  我的手记
                </Text>
                {detail.user_notes && detail.user_notes.length > 0 ? (
                  <Timeline
                    items={detail.user_notes.map(n => ({
                      color: 'blue',
                      children: (
                        <>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {dayjs(n.created_at).format('YYYY-MM-DD HH:mm')}
                          </Text>
                          <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                            {n.content}
                          </Paragraph>
                        </>
                      ),
                    }))}
                  />
                ) : (
                  <Text type="secondary">暂无手记，在下方输入框追加。</Text>
                )}
              </div>
            </Space>
          )}
          {selectedDate && (
            <div style={{ marginTop: 16 }}>
              <TextArea
                rows={3}
                placeholder="追加一条手记（最长 5000 字）..."
                value={noteContent}
                onChange={e => setNoteContent(e.target.value)}
                maxLength={5000}
                showCount
              />
              <div style={{ marginTop: 8, textAlign: 'right' }}>
                <Button
                  type="primary"
                  loading={appending}
                  onClick={() => void handleAppend()}
                  disabled={!noteContent.trim()}
                >
                  追加手记
                </Button>
              </div>
            </div>
          )}
        </Card>
      </Col>
    </Row>
  );
};

interface JournalSectionProps {
  title: string;
  content: string;
}

const JournalSection: React.FC<JournalSectionProps> = ({ title, content }) => (
  <div>
    <Text strong style={{ display: 'block', marginBottom: 4 }}>
      {title}
    </Text>
    <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0, color: '#444' }}>
      {content || <Text type="secondary">（无内容）</Text>}
    </Paragraph>
  </div>
);

// ===========================================================================
//  Helpers
// ===========================================================================

function pnlColor(value: number): string | undefined {
  if (value > 0) return '#3f8600';
  if (value < 0) return '#cf1322';
  return undefined;
}

function computeDailyReturns(equity: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    if (equity[i - 1] > 0 && Number.isFinite(equity[i])) {
      out.push(equity[i] / equity[i - 1] - 1);
    }
  }
  return out;
}

function computeMaxDrawdownPct(equity: number[]): number {
  let peak = equity[0] || 0;
  let maxDd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd * 100;
}

function computeSharpeRatio(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((acc, v) => acc + v, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (dailyReturns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (mean / sd) * Math.sqrt(252);
}

function annualizeReturnPct(snapshots: SnapshotRow[]): number {
  if (snapshots.length < 2) return 0;
  const first = Number(snapshots[0].total_value);
  const last = Number(snapshots[snapshots.length - 1].total_value);
  if (first <= 0) return 0;
  const days = dayjs(snapshots[snapshots.length - 1].date).diff(dayjs(snapshots[0].date), 'day');
  if (days <= 0) return 0;
  const totalReturn = last / first;
  if (totalReturn <= 0) return 0;
  // 按 365 自然日折算到 1 年
  return (Math.pow(totalReturn, 365 / days) - 1) * 100;
}

function sliceSnapshotsByWindow(snapshots: SnapshotRow[], window: WindowKey): SnapshotRow[] {
  if (window === 'all' || snapshots.length === 0) return snapshots;
  const lastDate = dayjs(snapshots[snapshots.length - 1].date);
  const lookback = window === '30d' ? 30 : window === '90d' ? 90 : window === '1y' ? 365 : 0;
  if (lookback === 0) return snapshots;
  const cutoff = lastDate.subtract(lookback, 'day');
  return snapshots.filter(s => !dayjs(s.date).isBefore(cutoff));
}
