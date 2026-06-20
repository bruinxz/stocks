/**
 * US-076 [FE-037] — v2 modal 子组件 (AnalyzerScoreBar / ConfidenceRing / EvidenceList).
 *
 * 把 US-075 在 AIStockAnalysisModal.V2Layout 内联实现的 3 块 UI 拆成独立可复用组件:
 *   - AnalyzerScoreBar — 8 dim score 进度条 (吃 dim.bar_value + dim.color, render Progress)
 *   - ConfidenceRing — 单维 confidence Tag (吃 dim.confidence + dim.confidence_color)
 *   - EvidenceList — 证据列表 (吃 dim.evidence: EvidenceViewItemV2[], render bullish/bearish/neutral 标签)
 *
 * 设计:
 *   - 纯 stateless render — 不取 store / 不发请求, 完全靠 props 喂数据 (易测易复用).
 *   - 类型直接复用 [[aiStockAnalysisModalV2Helpers]] 的 AnalyzerDimensionViewModelV2 +
 *     EvidenceViewItemV2 — 不再各自挑字段, 避免视图模型字段漂移.
 *   - antd Progress / Tag / Tooltip — 与 AIStockAnalysisModal 同款依赖, 不引入新 lib.
 *   - 单测: backend/tests/services/ai-stock-analysis-modal-v2-components.test.ts 跨
 *     monorepo ts-node --transpile-only 跑 (与 helpers test 同范式). 单测以 META-GUARD
 *     形式校验 modal 已用子组件替换 inline 实现 (3 子组件 import + jsx 出现) + 用 jsdom-free
 *     纯 props 校验 (子组件函数引用存在 + 接受类型签名一致).
 *
 * 后续 US-077 [FE-038] 会拆 ActionPlanCard / DataMissingBanner — 与本文件同款思路,
 * 但 model 不同 (吃 ActionPlanViewModelV2 / DataQualityViewModelV2).
 */

import React from 'react';
import { Progress, Tag, Tooltip, Typography } from 'antd';
import { CloseCircleOutlined, InfoCircleOutlined } from '@ant-design/icons';
import type {
  AnalyzerDimensionViewModelV2,
  EvidenceViewItemV2,
} from './aiStockAnalysisModalV2Helpers';

const { Text } = Typography;

// ===========================================================================
// AnalyzerScoreBar
// ===========================================================================

export interface AnalyzerScoreBarProps {
  /** 单维 view model — 由 buildAnalyzerDimensionViewModelV2 产出 */
  dimension: AnalyzerDimensionViewModelV2;
  /** 进度条尺寸; 默认 'small' (modal 内紧凑) */
  size?: 'small' | 'default';
}

/**
 * 单维标准分进度条 — bar_value [0,100] + color 由 helper 预算好.
 * showInfo=false 因为下方有 score 数字, 上面再显示一次冗余.
 */
export const AnalyzerScoreBar: React.FC<AnalyzerScoreBarProps> = ({
  dimension,
  size = 'small',
}) => {
  return (
    <div>
      <Progress
        percent={dimension.bar_value}
        showInfo={false}
        strokeColor={dimension.color}
        trailColor="#f0f0f0"
        size={size}
      />
      <Text style={{ fontSize: 11, color: '#8c8c8c' }}>
        {dimension.score != null ? `score ${dimension.score.toFixed(0)}` : '无评分'}
      </Text>
    </div>
  );
};

// ===========================================================================
// ConfidenceRing
// ===========================================================================

export interface ConfidenceRingProps {
  /** 单维 view model — 取 confidence + confidence_color */
  dimension: AnalyzerDimensionViewModelV2;
  /** Tooltip 文案; 默认 '该维度的数据可信度' */
  tooltip?: string;
}

/**
 * 单维数据可信度 — 用 antd Tag 显示百分比 + helper 预算的颜色.
 * confidence=null 走 '—' 占位 (避免 NaN%).
 * 取名 "Ring" 是预留 — 当前先用 Tag 实现保持紧凑, 后续若 PRD 要 echarts 环形图直接在本组件内换实现,
 * 调用方不变 (类同 [[EngineStatusPill]] 长尾扩展模式).
 */
export const ConfidenceRing: React.FC<ConfidenceRingProps> = ({ dimension, tooltip }) => {
  const pct = dimension.confidence != null ? `${Math.round(dimension.confidence * 100)}` : '—';
  return (
    <Tooltip title={tooltip || '该维度的数据可信度'}>
      <Tag
        color={dimension.confidence != null ? undefined : 'default'}
        style={{
          borderColor: dimension.confidence_color,
          color: dimension.confidence_color,
        }}
      >
        置信 {pct}
      </Tag>
    </Tooltip>
  );
};

// ===========================================================================
// EvidenceList
// ===========================================================================

/** evidence direction 到中文标签 + Tag color 的映射 — frozen 让测试可断言 */
export const EVIDENCE_DIRECTION_LABELS: Readonly<Record<EvidenceViewItemV2['direction'], string>> =
  Object.freeze({
    bullish: '利多',
    bearish: '利空',
    neutral: '中性',
  });

export const EVIDENCE_DIRECTION_COLORS: Readonly<Record<EvidenceViewItemV2['direction'], string>> =
  Object.freeze({
    bullish: 'red', // 中股惯例: 利多=红
    bearish: 'green',
    neutral: 'default',
  });

export interface EvidenceListProps {
  /** 证据列表 — 上游已按 weight desc 排序 + cap 5 */
  evidence: EvidenceViewItemV2[];
  /** evidence 为空时是否显示 fallback ("暂无明显信号"/数据缺失提示) */
  showEmpty?: boolean;
  /** 当 showEmpty=true 且 evidence=[] 时, data_missing 显示前 N 条 */
  dataMissing?: string[];
  /** 错误信息 — 非空时优先显示 error 红字 (覆盖 empty fallback) */
  error?: string | null;
}

/**
 * 证据列表 — 每条 evidence render 一个 li:
 *   [利多/利空/中性 标签] label — detail
 *
 * 空列表 + showEmpty=true 走 fallback 显示 (data_missing 优先于 "暂无信号").
 * error 非空时只显示 error 红字 (失败维度的 evidence 通常无意义).
 */
export const EvidenceList: React.FC<EvidenceListProps> = ({
  evidence,
  showEmpty = false,
  dataMissing = [],
  error = null,
}) => {
  if (error) {
    return (
      <div style={{ marginTop: 6 }}>
        <Text type="danger" style={{ fontSize: 12 }}>
          <CloseCircleOutlined style={{ marginRight: 4 }} />
          {error}
        </Text>
      </div>
    );
  }

  if (evidence.length === 0) {
    if (!showEmpty) return null;
    const missingHint =
      dataMissing.length > 0 ? `数据缺失：${dataMissing.slice(0, 2).join('、')}` : '暂无明显信号';
    return (
      <div style={{ marginTop: 6 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          <InfoCircleOutlined style={{ marginRight: 4 }} />
          {missingHint}
        </Text>
      </div>
    );
  }

  return (
    <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 20 }}>
      {evidence.map((ev, idx) => (
        <li key={idx} style={{ fontSize: 12 }}>
          <Tag color={EVIDENCE_DIRECTION_COLORS[ev.direction]} style={{ marginRight: 6 }}>
            {EVIDENCE_DIRECTION_LABELS[ev.direction]}
          </Tag>
          <Text>{ev.label}</Text>
          {ev.detail && (
            <Text type="secondary" style={{ marginLeft: 6 }}>
              — {ev.detail}
            </Text>
          )}
        </li>
      ))}
    </ul>
  );
};
