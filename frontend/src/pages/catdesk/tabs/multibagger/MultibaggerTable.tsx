import React from 'react';
import { Progress, Tag, Tooltip } from 'antd';
import { TableColumn } from 'shared/components/TableColumn';
import { ScoreCell, ConvictionPill, RiskGateChip } from 'shared/components/TableColumn';
import type { TableColumnDef } from 'shared/components/TableColumn';
import { SIZE_HINT_TIER_PCT } from 'shared/types/catdesk';
import type { MultibaggerRow } from './types';

const STAGE_LABEL: Record<string, string> = {
  seed: '种子', early: '早期', growth: '成长',
  break_below: '破发', deep: '深度',
};

const STAGE_COLOR: Record<string, string> = {
  seed: 'default', early: 'blue', growth: 'green',
  break_below: 'orange', deep: 'red',
};

const CONCLUSION_LABEL: Record<string, string> = {
  MULTIBAGGER_2X: '2X', MULTIBAGGER_5X: '5X',
  MULTIBAGGER_10X: '10X', SKIP: 'SKIP',
};

const CONCLUSION_COLOR: Record<string, string> = {
  MULTIBAGGER_2X: 'blue', MULTIBAGGER_5X: 'green',
  MULTIBAGGER_10X: 'gold', SKIP: 'default',
};

const CATALYST_LABEL: Record<string, string> = {
  earnings: '财报', upgrade_downgrade: '评级', ma_activity: '并购',
  sector_move: '板块', regulator: '监管', geo_macro: '宏观',
  product: '产品', leadership: '管理层', unclassified: '未分类',
};

const DISCLAIMER_TEXT = '仅供参考，非投资建议或下单指令';

function getColumns(): TableColumnDef<MultibaggerRow>[] {
  return [
    {
      key: 'symbol',
      title: '代码',
      ariaLabel: '股票代码',
      width: 80,
      sortable: true,
      render: (_, row) => <span>{row.symbol}</span>,
    },
    {
      key: 'name',
      title: '名称',
      ariaLabel: '公司名称',
      width: 120,
      render: (_, row) => <span>{row.name}</span>,
    },
    {
      key: 'market',
      title: '市场',
      ariaLabel: '上市市场',
      width: 60,
      render: (_, row) => <Tag>{row.market}</Tag>,
    },
    {
      key: 'stage',
      title: '阶段',
      ariaLabel: '候选阶段',
      width: 70,
      sortable: true,
      render: (_, row) => (
        <Tag color={STAGE_COLOR[row.stage]}>{STAGE_LABEL[row.stage]}</Tag>
      ),
    },
    {
      key: 'conclusion',
      title: '分结论',
      ariaLabel: '倍数分结论',
      width: 70,
      sortable: true,
      render: (_, row) => (
        <Tag color={CONCLUSION_COLOR[row.conclusion]}>
          {CONCLUSION_LABEL[row.conclusion]}
        </Tag>
      ),
    },
    {
      key: 'score',
      title: '评分',
      ariaLabel: '综合评分及等级',
      width: 90,
      align: 'center',
      sortable: true,
      render: (_, row) => (
        <Tooltip title={`scoring_id: ${row.score.scoring_id.slice(0, 8)}…`}>
          {ScoreCell(row.score, `${row.symbol} 评分`)}
        </Tooltip>
      ),
    },
    {
      key: 'rating_band',
      title: 'Rating',
      ariaLabel: 'Rating Band 等级',
      width: 70,
      align: 'center',
      render: (_, row) => {
        const colorMap: Record<string, string> = {
          A: '#389e0d', B: '#52c41a', C: '#faad14', D: '#fa8c16', F: '#cf1322',
        };
        return (
          <Tag color={colorMap[row.rating_band]}>{row.rating_band}</Tag>
        );
      },
    },
    {
      key: 'conviction',
      title: '置信',
      ariaLabel: '置信度',
      width: 80,
      align: 'center',
      render: (_, row) => {
        if (!row.conviction) return <span style={{ color: '#999' }}>—</span>;
        const adjSum = row.conviction.adjustments.reduce((s, a) => s + a.delta, 0);
        return (
          <Tooltip
            title={`base=${row.conviction.base} Σadj=${adjSum > 0 ? '+' : ''}${adjSum} final=${row.conviction.final}`}
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
      render: (_, row) => {
        if (!row.entry_plan) return <span style={{ color: '#999' }}>—</span>;
        const { tier, pct } = row.entry_plan.size_hint;
        const tierLabel = tier === 'SKIP' ? 'SKIP' : `${pct}%`;
        const tierColor = tier === 'SKIP' ? '#999' : pct >= 5 ? '#389e0d' : pct >= 3 ? '#52c41a' : '#faad14';
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
