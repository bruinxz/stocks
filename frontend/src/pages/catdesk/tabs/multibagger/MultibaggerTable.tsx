import React from 'react';
import { Progress, Tag, Tooltip } from 'antd';
import { TableColumn } from 'shared/components/TableColumn';
import { ScoreCell, ConvictionPill, RiskGateChip } from 'shared/components/TableColumn';
import type { TableColumnDef } from 'shared/components/TableColumn';
import type { MultibaggerRow } from './types';
import { MARKET_SCOPE_LABELS, RATING_LABELS } from '../../shared/uiLabels';

const STAGE_LABEL: Record<string, string> = {
  seed: '种子',
  early: '早期',
  growth: '成长',
  break_below: '破发',
  deep: '深度',
};

const STAGE_COLOR: Record<string, string> = {
  seed: 'default',
  early: 'blue',
  growth: 'green',
  break_below: 'orange',
  deep: 'red',
};

const STAGE_RANK: Record<string, number> = {
  seed: 1,
  early: 2,
  growth: 3,
  break_below: 4,
  deep: 5,
};

const CONCLUSION_LABEL: Record<string, string> = {
  MULTIBAGGER_2X: '2倍',
  MULTIBAGGER_5X: '5倍',
  MULTIBAGGER_10X: '10倍',
  SKIP: '暂不关注',
};

const CONCLUSION_COLOR: Record<string, string> = {
  MULTIBAGGER_2X: 'blue',
  MULTIBAGGER_5X: 'green',
  MULTIBAGGER_10X: 'gold',
  SKIP: 'default',
};

const CONCLUSION_RANK: Record<string, number> = {
  SKIP: 0,
  MULTIBAGGER_2X: 2,
  MULTIBAGGER_5X: 5,
  MULTIBAGGER_10X: 10,
};

const CATALYST_LABEL: Record<string, string> = {
  earnings: '财报',
  upgrade_downgrade: '评级',
  ma_activity: '并购',
  sector_move: '板块',
  regulator: '监管',
  geo_macro: '宏观',
  product: '产品',
  leadership: '管理层',
  unclassified: '未分类',
};

const DISCLAIMER_TEXT = '仅供参考，非投资建议或下单指令';

function getColumns(): TableColumnDef<MultibaggerRow>[] {
  return [
    {
      key: 'symbol',
      title: '代码',
      ariaLabel: '股票代码',
      width: 80,
      sortable: (a, b) => a.symbol.localeCompare(b.symbol, 'zh-CN', { numeric: true }),
      render: (_, row) => <span>{row.symbol}</span>,
    },
    {
      key: 'name',
      title: '名称',
      ariaLabel: '公司名称',
      width: 120,
      sortable: (a, b) => a.name.localeCompare(b.name, 'zh-CN'),
      render: (_, row) => <span>{row.name}</span>,
    },
    {
      key: 'market',
      title: '市场',
      ariaLabel: '上市市场',
      width: 60,
      render: (_, row) => <Tag>{MARKET_SCOPE_LABELS[row.market] ?? row.market}</Tag>,
    },
    {
      key: 'stage',
      title: '阶段',
      ariaLabel: '候选阶段',
      width: 70,
      sortable: (a, b) => (STAGE_RANK[a.stage] ?? 99) - (STAGE_RANK[b.stage] ?? 99),
      render: (_, row) => <Tag color={STAGE_COLOR[row.stage]}>{STAGE_LABEL[row.stage]}</Tag>,
    },
    {
      key: 'conclusion',
      title: '分结论',
      ariaLabel: '倍数分结论',
      width: 70,
      sortable: (a, b) =>
        (CONCLUSION_RANK[a.conclusion] ?? -1) - (CONCLUSION_RANK[b.conclusion] ?? -1),
      render: (_, row) => (
        <Tag color={CONCLUSION_COLOR[row.conclusion]}>{CONCLUSION_LABEL[row.conclusion]}</Tag>
      ),
    },
    {
      key: 'score',
      title: '评分',
      ariaLabel: '综合评分及等级',
      width: 90,
      align: 'center',
      sortable: (a, b) => (a.score?.total ?? -Infinity) - (b.score?.total ?? -Infinity),
      render: (_, row) =>
        row.score ? (
          <Tooltip title={`scoring_id: ${row.score.scoring_id.slice(0, 8)}…`}>
            {ScoreCell(row.score, `${row.symbol} 评分`)}
          </Tooltip>
        ) : (
          <span style={{ color: 'var(--cd-text-secondary)' }}>—</span>
        ),
    },
    {
      key: 'rating_band',
      title: '评级',
      ariaLabel: '评级等级',
      width: 70,
      align: 'center',
      sortable: (a, b) => a.rating_band.localeCompare(b.rating_band),
      render: (_, row) => {
        const colorMap: Record<string, string> = {
          A: '#389e0d',
          B: '#52c41a',
          C: '#faad14',
          D: '#fa8c16',
          F: '#cf1322',
        };
        return (
          <Tag color={colorMap[row.rating_band]}>
            {RATING_LABELS[row.rating_band] ?? row.rating_band}
          </Tag>
        );
      },
    },
    {
      key: 'conviction',
      title: '置信',
      ariaLabel: '置信度',
      width: 80,
      align: 'center',
      sortable: (a, b) => (a.conviction?.final ?? -Infinity) - (b.conviction?.final ?? -Infinity),
      render: (_, row) => {
        if (!row.conviction) return <span style={{ color: '#999' }}>—</span>;
        const adjSum = row.conviction.adjustments.reduce((s, a) => s + a.delta, 0);
        return (
          <Tooltip
            title={`基础分 ${row.conviction.base}，调整 ${adjSum > 0 ? '+' : ''}${adjSum}，最终 ${row.conviction.final}`}
          >
            {ConvictionPill(row.conviction, `${row.symbol} 置信度`)}
          </Tooltip>
        );
      },
    },
    {
      key: 'risk',
      title: '风险',
      ariaLabel: '风险门禁状态',
      width: 80,
      align: 'center',
      sortable: (a, b) => (a.risk_gate?.gate ?? '').localeCompare(b.risk_gate?.gate ?? ''),
      render: (_, row) => {
        if (!row.risk_gate) return <span style={{ color: '#999' }}>—</span>;
        return RiskGateChip(row.risk_gate, `${row.symbol} 风险门禁`);
      },
    },
    {
      key: 'size_hint',
      title: '建议仓位',
      ariaLabel: '建议仓位比例',
      width: 130,
      sortable: (a, b) =>
        (a.entry_plan?.size_hint.pct ?? -Infinity) - (b.entry_plan?.size_hint.pct ?? -Infinity),
      render: (_, row) => {
        if (!row.entry_plan) return <span style={{ color: '#999' }}>—</span>;
        const { tier, pct } = row.entry_plan.size_hint;
        const tierLabel = tier === 'SKIP' ? '暂不参与' : `${pct}%`;
        const tierColor =
          tier === 'SKIP' ? '#999' : pct >= 5 ? '#389e0d' : pct >= 3 ? '#52c41a' : '#faad14';
        return (
          <Tooltip title={DISCLAIMER_TEXT}>
            <div>
              <Tag color={tierColor}>{tierLabel}</Tag>
              {tier !== 'SKIP' && (
                <Progress
                  percent={(pct / 5) * 100}
                  size="small"
                  showInfo={false}
                  strokeColor={tierColor}
                  style={{ width: 60, display: 'inline-block' }}
                />
              )}
            </div>
          </Tooltip>
        );
      },
    },
    {
      key: 'catalyst_hint',
      title: '催化',
      ariaLabel: '最近催化事件类型',
      width: 70,
      render: (_, row) => {
        if (!row.latest_catalyst) return null;
        return (
          <Tooltip title={row.latest_catalyst.title}>
            <Tag>{CATALYST_LABEL[row.latest_catalyst.kind] ?? row.latest_catalyst.kind}</Tag>
          </Tooltip>
        );
      },
    },
  ];
}

type MultibaggerTableProps = {
  rows: MultibaggerRow[];
  loading: boolean;
  error: Error | null;
  onRowClick: (row: MultibaggerRow) => void;
};

export function MultibaggerTable({ rows, loading, error, onRowClick }: MultibaggerTableProps) {
  return (
    <TableColumn<MultibaggerRow>
      rows={rows}
      columns={getColumns()}
      rowKey="symbol"
      loading={loading}
      onRowClick={onRowClick}
      scroll={{ y: 600 }}
      emptyText="当前过滤条件无候选 · 调整阶段或分结论"
      errorText={
        error ? (
          <div role="alert" aria-live="polite">
            候选池服务暂时不可用
          </div>
        ) : undefined
      }
      size="small"
    />
  );
}
