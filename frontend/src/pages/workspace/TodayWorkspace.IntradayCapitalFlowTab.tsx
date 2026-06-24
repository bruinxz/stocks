/**
 * BK-4 (2026-06-24) — 盘中行业资金流向 tab.
 *
 * 调 GET /api/market/industry-flow/intraday 取 today 全行业的分时累计净流入,
 * 渲染 ECharts 多线图 (X=时间, Y=亿元) + 右侧排名表. 5min auto-refresh.
 *
 * 与抖音"分时累计资金流"截图一致: 用户一眼看出"今天哪个行业资金大涌入 / 大撤离".
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Empty, message, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { ReloadOutlined, ClockCircleOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import api from '../../services/api';

const { Title, Text } = Typography;

interface SeriesPoint {
  ts: string;
  main_inflow: number | null;
}
interface IndustryData {
  industry_code: string;
  industry_name: string;
  latest_main_inflow: number | null;
  latest_change_pct: number | null;
  latest_main_inflow_ratio: number | null;
  series: SeriesPoint[];
}
interface IntradayResponse {
  success: boolean;
  data?: {
    date: string;
    industries: IndustryData[];
    snapshot_ts_list: string[];
  };
  error?: string;
}

const REFRESH_MS = 5 * 60 * 1000; // 5min
const TOP_OPTIONS = [10, 20, 30, 50];

/** 元 → 亿元, 保 2 位小数. */
function yiYuan(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.round((v / 1e8) * 100) / 100;
}

/** ISO ts → HH:MM (Asia/Shanghai). 给 ECharts X 轴用. */
function toHHMM(iso: string): string {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return iso;
  }
}

/** 红 (流入) → 绿 (流出) 渐变. 与中股惯例一致 (红涨绿跌). */
function inflowColor(yi: number | null): string {
  if (yi === null) return '#999';
  if (yi >= 5) return '#cf1322'; // 强流入
  if (yi >= 1) return '#f5222d';
  if (yi >= 0) return '#fa8c16';
  if (yi >= -1) return '#7cb305';
  if (yi >= -5) return '#52c41a';
  return '#237804'; // 强流出
}

const IntradayCapitalFlowTab: React.FC = () => {
  const [data, setData] = useState<IntradayResponse['data'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topN, setTopN] = useState<number>(20);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // api.get returns axios Response; data.success/.data per backend convention.
      const resp = await api.get<IntradayResponse>(`/market/industry-flow/intraday?top=${topN}`);
      const body = resp.data;
      if (!body?.success || !body.data) {
        throw new Error(body?.error || '加载失败');
      }
      setData(body.data);
      setLastRefresh(new Date());
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
      message.error(`资金流向加载失败: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }, [topN]);

  // mount + topN 变更 + 5min interval refresh
  useEffect(() => {
    refresh();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(refresh, REFRESH_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  const chartOption = useMemo(() => {
    if (!data || data.industries.length === 0) return null;
    const xAxisData = data.snapshot_ts_list.map(toHHMM);
    // X-axis: 公共时间序列; series: 每个行业一条线
    const series = data.industries.map(ind => {
      // 按 snapshot_ts_list 顺序找对应 main_inflow (亿元)
      const tsToInflow = new Map<string, number | null>();
      for (const p of ind.series) tsToInflow.set(p.ts, p.main_inflow);
      const seriesData = data.snapshot_ts_list.map(ts => {
        const yi = yiYuan(tsToInflow.get(ts) ?? null);
        return yi;
      });
      const latestYi = yiYuan(ind.latest_main_inflow);
      const color = inflowColor(latestYi);
      return {
        name: `${ind.industry_name} ${latestYi !== null ? `${latestYi > 0 ? '+' : ''}${latestYi.toFixed(2)}亿` : ''}`,
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 1.5, color },
        emphasis: { lineStyle: { width: 3 }, focus: 'series' },
        data: seriesData,
        endLabel: {
          show: true,
          formatter: (params: any) => {
            const yi = params?.value;
            if (yi === null || yi === undefined) return '';
            return `${ind.industry_name} ${yi > 0 ? '+' : ''}${yi.toFixed(2)}亿`;
          },
          color,
          fontSize: 11,
        },
      };
    });
    return {
      backgroundColor: 'transparent',
      grid: { left: 50, right: 200, top: 30, bottom: 40 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: any[]) => {
          const ts = params?.[0]?.axisValueLabel || '';
          // 显示当前 ts 下 top 10 by |inflow|
          const items = (params || [])
            .filter(p => p?.value !== null && p?.value !== undefined)
            .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
            .slice(0, 10)
            .map(p => {
              const yi = p.value as number;
              const color = yi >= 0 ? '#cf1322' : '#52c41a';
              return `<span style="color:${color};">●</span> ${p.seriesName.split(' ')[0]}: <b style="color:${color}">${yi >= 0 ? '+' : ''}${yi.toFixed(2)}亿</b>`;
            })
            .join('<br/>');
          return `<b>${ts}</b><br/>${items}`;
        },
      },
      xAxis: {
        type: 'category',
        data: xAxisData,
        boundaryGap: false,
        axisLabel: { fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        name: '累计净流入 (亿元)',
        nameTextStyle: { fontSize: 11 },
        axisLabel: { fontSize: 11 },
        splitLine: { lineStyle: { color: '#f0f0f0' } },
      },
      series,
    };
  }, [data]);

  const tableData = useMemo(() => {
    if (!data) return [];
    return data.industries.map(ind => ({
      key: ind.industry_code,
      industry_code: ind.industry_code,
      industry_name: ind.industry_name,
      latest_yi: yiYuan(ind.latest_main_inflow),
      change_pct: ind.latest_change_pct,
      ratio: ind.latest_main_inflow_ratio,
    }));
  }, [data]);

  return (
    <div style={{ padding: '12px 16px' }}>
      <Card
        size="small"
        title={
          <Space>
            <Title level={5} style={{ margin: 0 }}>
              盘中行业资金流向 (10min 累计)
            </Title>
            {data?.date && <Tag color="blue">{data.date}</Tag>}
            {lastRefresh && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                <ClockCircleOutlined /> 上次刷新{' '}
                {new Intl.DateTimeFormat('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false,
                }).format(lastRefresh)}{' '}
                · 每 5 分钟自动刷新
              </Text>
            )}
          </Space>
        }
        extra={
          <Space>
            <Select
              size="small"
              value={topN}
              onChange={setTopN}
              options={TOP_OPTIONS.map(n => ({ label: `Top ${n}`, value: n }))}
              style={{ width: 80 }}
            />
            <ReloadOutlined
              spin={loading}
              onClick={() => !loading && refresh()}
              style={{ cursor: loading ? 'not-allowed' : 'pointer' }}
            />
          </Space>
        }
      >
        {error && <div style={{ color: '#cf1322', padding: 8 }}>{error}</div>}
        <Spin spinning={loading} tip="拉取盘中资金流...">
          {!data || data.industries.length === 0 ? (
            <Empty
              description={
                loading ? '加载中' : '暂无数据 (非盘中或刚开盘 5min 内, 等下个整点 10min 自动落库)'
              }
              style={{ padding: '40px 0' }}
            />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 16 }}>
              <div style={{ height: 560 }}>
                {chartOption && (
                  <ReactECharts
                    option={chartOption}
                    style={{ height: '100%', width: '100%' }}
                    notMerge
                    lazyUpdate
                  />
                )}
              </div>
              <Card size="small" title="实时排名" bodyStyle={{ padding: 8 }}>
                <Table
                  size="small"
                  dataSource={tableData}
                  pagination={false}
                  scroll={{ y: 520 }}
                  columns={[
                    {
                      title: '#',
                      dataIndex: 'key',
                      width: 36,
                      render: (_v, _r, i) => i + 1,
                    },
                    {
                      title: '行业',
                      dataIndex: 'industry_name',
                      ellipsis: true,
                    },
                    {
                      title: '净流入(亿)',
                      dataIndex: 'latest_yi',
                      width: 100,
                      align: 'right' as const,
                      sorter: (a, b) => (a.latest_yi ?? 0) - (b.latest_yi ?? 0),
                      defaultSortOrder: 'descend' as const,
                      render: (v: number | null) =>
                        v === null ? (
                          '-'
                        ) : (
                          <Text strong style={{ color: v >= 0 ? '#cf1322' : '#52c41a' }}>
                            {v > 0 ? '+' : ''}
                            {v.toFixed(2)}
                          </Text>
                        ),
                    },
                    {
                      title: '涨幅',
                      dataIndex: 'change_pct',
                      width: 70,
                      align: 'right' as const,
                      render: (v: number | null) =>
                        v === null ? (
                          '-'
                        ) : (
                          <Text style={{ color: v >= 0 ? '#cf1322' : '#52c41a', fontSize: 12 }}>
                            {v > 0 ? '+' : ''}
                            {v.toFixed(2)}%
                          </Text>
                        ),
                    },
                  ]}
                />
              </Card>
            </div>
          )}
        </Spin>
      </Card>
    </div>
  );
};

export default IntradayCapitalFlowTab;
