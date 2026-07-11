import React from 'react';
import { Alert, Tag, Typography } from 'antd';
import {
  ScoreBreakdownCard,
  EntryPlanCard,
  RiskGateDetailCard,
  ConvictionBreakdownCard,
  DataSourceBadge,
} from 'shared/components/DetailSidebar';
import type { DetailSection } from 'shared/components/DetailSidebar';
import type { Dimension, Score, Weights } from 'shared/scoring/types';
import type { MultibaggerRow } from './types';

const { Text } = Typography;

const STAGE_LABEL: Record<string, string> = {
  seed: '种子期',
  early: '早期',
  growth: '成长期',
  break_below: '破发',
  deep: '深度价值',
};

const CONCLUSION_LABEL: Record<string, string> = {
  MULTIBAGGER_2X: '2 倍潜力',
  MULTIBAGGER_5X: '5 倍潜力',
  MULTIBAGGER_10X: '10 倍潜力',
  SKIP: '跳过',
};

const SCORE_DIMENSIONS = [
  'quality',
  'growth',
  'valuation',
  'moat',
  'trend',
  'risk',
] as const satisfies readonly (keyof Weights)[];

function buildScoreDimMap(score: Score): Record<string, { score: number; band: string }> {
  return Object.fromEntries(
    SCORE_DIMENSIONS.map(key => {
      const dimension: Dimension = score[key];
      return [key, { score: dimension.score, band: dimension.band }];
    })
  );
}

function buildServerWeights(weights: Weights): Record<string, number> {
  return Object.fromEntries(SCORE_DIMENSIONS.map(key => [key, weights[key]]));
}

export function buildMultibaggerSections(row: MultibaggerRow): DetailSection[] {
  const sections: DetailSection[] = [];

  if (row.entry_plan?.size_hint.tier === 'SKIP') {
    sections.push({
      key: 'skip_warning',
      title: '仓位警告',
      ariaLabel: `${row.symbol} 仓位跳过警告`,
      content: (
        <Alert
          type="error"
          message="SIZE_HINT = SKIP"
          description="该标的不满足仓位分配条件 (评分不足或风险门禁非 GREEN)"
          showIcon
        />
      ),
    });
  }

  sections.push({
    key: 'stage_conclusion',
    title: '阶段 / 分结论',
    ariaLabel: `${row.symbol} 阶段与分结论`,
    content: (
      <div>
        <div style={{ marginBottom: 8 }}>
          <Text strong>阶段: </Text>
          <Tag>{STAGE_LABEL[row.stage]}</Tag>
        </div>
        <div>
          <Text strong>分结论: </Text>
          <Tag color={row.conclusion === 'SKIP' ? 'default' : 'gold'}>
            {CONCLUSION_LABEL[row.conclusion]}
          </Tag>
        </div>
      </div>
    ),
  });

  if (row.score) {
    sections.push({
      key: 'score_breakdown',
      title: `评分拆解 · ${row.score.weights_profile ?? 'multibagger'}`,
      ariaLabel: `${row.symbol} 6 维评分拆解`,
      content: (
        <ScoreBreakdownCard
          scores={buildScoreDimMap(row.score)}
          ariaLabel={`${row.symbol} multibagger profile 评分`}
          weights={buildServerWeights(row.score.weights)}
        />
      ),
    });
  }

  if (row.conviction) {
    sections.push({
      key: 'conviction_breakdown',
      title: '置信拆解',
      ariaLabel: `${row.symbol} 置信度拆解`,
      content: (
        <ConvictionBreakdownCard
          c={row.conviction}
          ariaLabel={`${row.symbol} base+adjustments 归因`}
        />
      ),
    });
  }

  if (row.risk_gate) {
    sections.push({
      key: 'risk_gate_detail',
      title: '风险门禁',
      ariaLabel: `${row.symbol} 风险门禁详情`,
      content: (
        <RiskGateDetailCard gate={row.risk_gate} ariaLabel={`${row.symbol} 22 trigger 详情`} />
      ),
      collapsible: true,
      defaultCollapsed: row.risk_gate.gate === 'GREEN',
    });
  }

  if (row.entry_plan) {
    sections.push({
      key: 'entry_plan',
      title: '入场计划',
      ariaLabel: `${row.symbol} 入场计划`,
      content: <EntryPlanCard plan={row.entry_plan} ariaLabel={`${row.symbol} 价格区间与仓位`} />,
    });
  }

  if (row.latest_catalyst) {
    sections.push({
      key: 'catalyst',
      title: '催化事件',
      ariaLabel: `${row.symbol} 最近催化`,
      content: (
        <div>
          <Tag>{row.latest_catalyst.kind}</Tag>
          <Text>{row.latest_catalyst.title}</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {new Date(row.latest_catalyst.occurred_at).toLocaleDateString()}
          </Text>
        </div>
      ),
    });
  }

  return sections;
}
