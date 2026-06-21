/**
 * US-048 [FE-009] FactorWorkspace ETF 资金流 Tab.
 *
 * 展示行业 ETF 申赎资金流（近 N 日累计净流入 + 单日明细），与既有 BlockTradesTab /
 * MacroEnvTab 同款"FactorWorkspace 子 tab"形态。
 *
 * 数据来自 GET /api/data/etf-flow (US-092 落库, DataController.listEtfFlow):
 *   - 后端返 `{ industries: string[], data: FlowEntry[] }`
 *   - industries = 全部白名单行业, 供下拉切换
 *   - data = (trade_date DESC, etf_code ASC) per-row, 默认 30 日全行业
 *
 * 视角:
 *   - 顶部 KPI: 累计净流入 / 净流出最多的 5 个 ETF (近 N 日聚合, 让用户秒看
 *     "哪些行业被申购 / 赎回")
 *   - 主表: per-row 明细 (日期 + ETF + 净流入 + AUM + NAV), 支持按行业 / 天数过滤
 *
 * 与 IndustryFlow (US-008 二级市场主力买盘) 的区别在 backend/src/models/ETFFlow.ts
 * 顶端 jsdoc 里写得很清楚 — 不要混用. UI 顶部 Alert 也提示一下避免操盘手错位.
 *
 * Lazy-load 三态判定 (与 [[lazy-load tab data 三态判定]] 范式一致):
 *   data || loading || error 短路, 仅首次切到 'etf' tab 时 fire.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  InputNumber,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import api from '../../services/api';
import {
  aggregateETFFlow,
  fmtETFMoney as fmtMoney,
  inflowColor,
  ETFFlowEntry,
  ETFAggregateRow,
} from './etfFlowHelpers';

const { Text } = Typography;

interface ETFFlowResponse {
  success: boolean;
  count: number;
  industries: string[];
  data: ETFFlowEntry[];
  filters?: Record<string, unknown>;
}

const ETFFlowTab: React.FC = () => {
  const [data, setData] = useState<ETFFlowResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [industry, setIndustry] = useState<string | undefined>(undefined);
  const [days, setDays] = useState<number>(30);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string | number> = { days, limit: 5000 };
      if (industry) params.industry = industry;
      const resp = await api.get('/data/etf-flow', { params });
      setData(resp.data as ETFFlowResponse);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [days, industry]);

  useEffect(() => {
    void load();
  }, [load]);

  const aggregated = useMemo(() => aggregateETFFlow(data?.data ?? []), [data]);
  const topInflow = useMemo(
    () => [...aggregated].sort((a, b) => b.cumulative_inflow - a.cumulative_inflow).slice(0, 5),
    [aggregated]
  );
  const topOutflow = useMemo(
    () => [...aggregated].sort((a, b) => a.cumulative_inflow - b.cumulative_inflow).slice(0, 5),
    [aggregated]
  );
  const totalNetInflow = useMemo(
    () => aggregated.reduce((s, a) => s + a.cumulative_inflow, 0),
    [aggregated]
  );
  const totalAUM = useMemo(
    () => aggregated.reduce((s, a) => s + (a.latest_aum ?? 0), 0),
    [aggregated]
  );

  if (loading && !data) {
    return (
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin tip="加载 ETF 资金流…" />
        </div>
      </Card>
    );
  }
  if (error && !data) {
    return (
      <Alert
        type="error"
        showIcon
        message="加载 ETF 资金流失败"
        description={error}
        action={
          <Button size="small" onClick={load}>
            重试
          </Button>
        }
      />
    );
  }

  const industries = data?.industries ?? [];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }} data-testid="etf-flow-tab">
      {error && data && (
        <Alert
          type="warning"
          showIcon
          message="数据刷新失败 (展示上次缓存)"
          description={error}
          action={
            <Button size="small" onClick={load}>
              重试
            </Button>
          }
        />
      )}

      {/* 控件 + KPI */}
      <Card size="small">
        <Space size={16} wrap style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#666' }}>行业:</span>
          <Select
            data-testid="etf-flow-industry-select"
            allowClear
            placeholder="全部行业"
            style={{ width: 160 }}
            value={industry}
            onChange={v => setIndustry(v || undefined)}
            options={[...industries.map(i => ({ label: i, value: i }))]}
          />
          <span style={{ fontSize: 12, color: '#666' }}>近 N 日:</span>
          <InputNumber
            data-testid="etf-flow-days-input"
            min={3}
            max={365}
            value={days}
            onChange={v => setDays(Number(v) || 30)}
            style={{ width: 100 }}
            addonAfter="日"
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>
            刷新
          </Button>
          <Statistic
            title="覆盖 ETF"
            value={aggregated.length}
            suffix="只"
            valueStyle={{ fontSize: 16 }}
          />
          <Statistic
            title={`近 ${days} 日累计净流入`}
            value={fmtMoney(totalNetInflow)}
            valueStyle={{ fontSize: 16, color: inflowColor(totalNetInflow) }}
          />
          <Statistic
            title="累计 AUM"
            value={fmtMoney(totalAUM)}
            valueStyle={{ fontSize: 16, color: '#722ed1' }}
          />
        </Space>
      </Card>

      {/* Top inflow / outflow 双栏 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={
              <Space>
                <Tag color="red">资金净申购 top 5</Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  近 {days} 日 ETF 份额增加 × NAV 累计估算
                </Text>
              </Space>
            }
            data-testid="etf-flow-top-inflow"
          >
            {topInflow.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近期无 ETF 申购数据" />
            ) : (
              <Table
                size="small"
                rowKey="etf_code"
                dataSource={topInflow}
                pagination={false}
                columns={[
                  {
                    title: 'ETF',
                    width: 220,
                    render: (_v, r: ETFAggregateRow) => (
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 12 }}>
                          {r.etf_name}{' '}
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {r.etf_code}
                          </Text>
                        </div>
                        <Tag color="blue" style={{ marginTop: 2 }}>
                          {r.underlying_industry}
                        </Tag>
                      </div>
                    ),
                  },
                  {
                    title: '累计净流入',
                    dataIndex: 'cumulative_inflow',
                    align: 'right',
                    width: 120,
                    render: (v: number) => (
                      <Text strong style={{ color: inflowColor(v) }}>
                        {fmtMoney(v)}
                      </Text>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={
              <Space>
                <Tag color="green">资金净赎回 top 5</Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  近 {days} 日 ETF 份额减少 × NAV 累计估算
                </Text>
              </Space>
            }
            data-testid="etf-flow-top-outflow"
          >
            {topOutflow.length === 0 || topOutflow[0].cumulative_inflow >= 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近期无 ETF 赎回数据" />
            ) : (
              <Table
                size="small"
                rowKey="etf_code"
                dataSource={topOutflow}
                pagination={false}
                columns={[
                  {
                    title: 'ETF',
                    width: 220,
                    render: (_v, r: ETFAggregateRow) => (
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 12 }}>
                          {r.etf_name}{' '}
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {r.etf_code}
                          </Text>
                        </div>
                        <Tag color="blue" style={{ marginTop: 2 }}>
                          {r.underlying_industry}
                        </Tag>
                      </div>
                    ),
                  },
                  {
                    title: '累计净流入',
                    dataIndex: 'cumulative_inflow',
                    align: 'right',
                    width: 120,
                    render: (v: number) => (
                      <Text strong style={{ color: inflowColor(v) }}>
                        {fmtMoney(v)}
                      </Text>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>

      {/* 主明细表 */}
      <Card
        size="small"
        title={
          <Space>
            <span>ETF 资金流明细</span>
            <Tag color="purple">{data?.data?.length ?? 0} 条</Tag>
            {industry && <Tag color="blue">行业: {industry}</Tag>}
          </Space>
        }
      >
        {!data?.data?.length ? (
          <Empty
            description={
              <span style={{ fontSize: 12 }}>
                etf_flows 表无数据 — 请在 SchedulerService 启用 <Text code>ETF_FLOW_SYNC</Text> 任务
                (US-092 已 seed)
              </span>
            }
          />
        ) : (
          <Table<ETFFlowEntry>
            size="small"
            rowKey={r => `${r.trade_date}-${r.etf_code}`}
            dataSource={data.data}
            pagination={{ pageSize: 30, size: 'small', showSizeChanger: true }}
            scroll={{ x: 'max-content' }}
            columns={[
              {
                title: '日期',
                dataIndex: 'trade_date',
                width: 100,
                sorter: (a, b) => a.trade_date.localeCompare(b.trade_date),
                defaultSortOrder: 'descend' as const,
              },
              {
                title: 'ETF',
                key: 'etf',
                width: 200,
                render: (_v, r) => (
                  <div>
                    <Text strong>{r.etf_name}</Text>{' '}
                    <Text code style={{ fontSize: 11 }}>
                      {r.etf_code}
                    </Text>
                  </div>
                ),
              },
              {
                title: '行业',
                dataIndex: 'underlying_industry',
                width: 100,
                render: (v: string) => <Tag color="blue">{v || '—'}</Tag>,
              },
              {
                title: '净流入 (申赎)',
                dataIndex: 'net_inflow',
                width: 120,
                align: 'right' as const,
                sorter: (a, b) => (a.net_inflow ?? 0) - (b.net_inflow ?? 0),
                render: (v: number | null) => (
                  <Tooltip title="估算: (今日份额 - 昨日份额) × NAV. 真申赎金额 AKShare 暂无 endpoint.">
                    <Text strong style={{ color: inflowColor(v) }}>
                      {fmtMoney(v)}
                    </Text>
                  </Tooltip>
                ),
              },
              {
                title: 'AUM (规模)',
                dataIndex: 'aum',
                width: 110,
                align: 'right' as const,
                render: (v: number | null) => fmtMoney(v),
              },
              {
                title: 'NAV',
                dataIndex: 'nav',
                width: 80,
                align: 'right' as const,
                render: (v: number | null) =>
                  v == null || !Number.isFinite(v) ? '—' : v.toFixed(4),
              },
              {
                title: '二级市场成交额',
                dataIndex: 'secondary_turnover',
                width: 130,
                align: 'right' as const,
                render: (v: number | null) => fmtMoney(v),
              },
            ]}
          />
        )}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
          ⚠ <Text strong>申赎金额是估算值</Text>: AKShare 无原生 per-ETF 申赎金额端点, 后端用
          「(今日份额 - 昨日份额) × NAV」 推算 (与 backend/src/models/ETFFlow.ts 顶端注释一致). 与
          IndustryFlow 二级市场主力买盘是两件事 — 申赎是一级市场实质资金, 二级是买盘强度.
        </Typography.Paragraph>
      </Card>
    </Space>
  );
};

export default ETFFlowTab;
