/**
 * US-076 [FE-037] — v2 modal 子组件 (AnalyzerScoreBar / ConfidenceRing / EvidenceList).
 * US-077 [FE-038] — 续拆 ActionPlanCard / DataMissingBanner 到本文件 (同源同测便利).
 *
 * 把 US-075 在 AIStockAnalysisModal.V2Layout 内联实现的 UI 拆成独立可复用组件:
 *   - AnalyzerScoreBar — 8 dim score 进度条 (吃 dim.bar_value + dim.color, render Progress)
 *   - ConfidenceRing — 单维 confidence Tag (吃 dim.confidence + dim.confidence_color)
 *   - EvidenceList — 证据列表 (吃 dim.evidence: EvidenceViewItemV2[], render bullish/bearish/neutral 标签)
 *   - DataMissingBanner — 数据缺失红色 Alert (吃 DataQualityViewModelV2, 关键字段缺失或 critical 等级时展示)
 *   - ActionPlanCard — 行动计划卡片 (吃 ActionPlanViewModelV2, 显示买入区间 / 仓位 / 止损止盈 / 风险提示)
 *
 * 设计:
 *   - 纯 stateless render — 不取 store / 不发请求, 完全靠 props 喂数据 (易测易复用).
 *   - 类型直接复用 [[aiStockAnalysisModalV2Helpers]] 的 view model — 不再各自挑字段, 避免漂移.
 *   - antd Alert / Progress / Tag / Tooltip / Row / Col / Divider — 与 AIStockAnalysisModal
 *     同款依赖, 不引入新 lib.
 *   - 单测: backend/tests/services/ai-stock-analysis-modal-v2-components.test.ts (US-076)
 *     + backend/tests/services/ai-stock-analysis-modal-v2-action-components.test.ts (US-077)
 *     跨 monorepo ts-node --transpile-only 跑 (与 helpers test 同范式). 以 META-GUARD
 *     形式校验 modal 已用子组件替换 inline 实现 (import + jsx 出现) + props 类型签名稳定.
 *
 * 5 子组件本质都是 stateless presentational, 同文件汇集让 modal 只需 1 行 import 拿全套.
 */

import React from 'react';
import { Alert, Col, Divider, Progress, Row, Space, Tag, Tooltip, Typography } from 'antd';
import {
  BulbOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type {
  ActionPlanViewModelV2,
  AnalyzerDimensionViewModelV2,
  DataQualityViewModelV2,
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

// ===========================================================================
// DataMissingBanner — US-077 [FE-038]
// ===========================================================================

export interface DataMissingBannerProps {
  /** 数据质量 view model — 由 buildDataQualityViewModelV2 产出 */
  dataQuality: DataQualityViewModelV2 | null | undefined;
  /** missing_optional 列表最多展示几条 (默认 5, 防止 banner 撑爆) */
  maxOptionalShown?: number;
}

/**
 * 数据缺失红色 banner — 仅在关键字段缺失或 level==='critical' 时显示, 否则返 null
 * (与 V2Layout inline 行为完全一致, 避免回归).
 *
 * 设计:
 *   - dataQuality=null/undefined → 直接 null (上游 metadata 无 data_quality 字段).
 *   - missing_critical 非空 OR level==='critical' → 显示红色 Alert.
 *   - 其余情况 (level=good/partial/degraded 且 missing_critical=[]) → null.
 *   - missing_optional 截断到 maxOptionalShown (默认 5), 多出来标 '…'.
 *
 * 单测见 backend/tests/services/ai-stock-analysis-modal-v2-action-components.test.ts.
 */
export const DataMissingBanner: React.FC<DataMissingBannerProps> = ({
  dataQuality,
  maxOptionalShown = 5,
}) => {
  if (!dataQuality) return null;
  const showBanner = dataQuality.missing_critical.length > 0 || dataQuality.level === 'critical';
  if (!showBanner) return null;
  const optionalShown = dataQuality.missing_optional.slice(0, maxOptionalShown);
  const optionalOverflow = dataQuality.missing_optional.length > maxOptionalShown;
  return (
    <Alert
      type="error"
      showIcon
      icon={<WarningOutlined />}
      message="关键数据缺失 — 建议谨慎参考本结论"
      description={
        <Space direction="vertical" size={4}>
          {dataQuality.missing_critical.length > 0 && (
            <Text type="secondary">缺失字段：{dataQuality.missing_critical.join('、')}</Text>
          )}
          {optionalShown.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              可选缺失：{optionalShown.join('、')}
              {optionalOverflow ? '…' : ''}
            </Text>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            数据完整系数：{(dataQuality.coefficient * 100).toFixed(0)}%
          </Text>
        </Space>
      }
    />
  );
};

// ===========================================================================
// ActionPlanCard — US-077 [FE-038]
// ===========================================================================

export interface ActionPlanCardProps {
  /** 行动计划 view model — 由 buildActionPlanViewModelV2 产出 */
  actionPlan: ActionPlanViewModelV2;
  /** 风险提示展示上限 (默认 5, 防止滚动) */
  maxRiskWarningsShown?: number;
}

/**
 * 行动计划卡片 — 买入区间 / 仓位 / 止损 / 止盈 + 风险提示.
 *
 * 设计:
 *   - 单字段 null → 显示 '—' 占位 (与 V2Layout inline 实现一致).
 *   - risk_warnings 非空 → 渲染 Divider + 列表; 空 → 仅显示上半部行动计划字段.
 *   - 止损绿色 / 止盈红色 (中股惯例同 [[ACTION_COLORS_V2]]).
 *   - 标题色随 action_color 变 (强买入=深红, 强卖出=深绿, 持有=蓝, unknown=灰).
 *
 * 单测见 backend/tests/services/ai-stock-analysis-modal-v2-action-components.test.ts.
 */
export const ActionPlanCard: React.FC<ActionPlanCardProps> = ({
  actionPlan,
  maxRiskWarningsShown = 5,
}) => {
  return (
    <div
      style={{
        padding: 16,
        borderRadius: 8,
        background: '#fff7e6',
        border: '1px solid #ffd591',
      }}
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space>
          <BulbOutlined style={{ color: actionPlan.action_color }} />
          <Text strong style={{ fontSize: 14 }}>
            行动计划
          </Text>
          <Tag color={actionPlan.action_color}>{actionPlan.action_label}</Tag>
        </Space>
        <Row gutter={[16, 8]}>
          <Col span={12}>
            <Text type="secondary">建议买入区间：</Text>
            <Text strong>
              {actionPlan.entry_zone
                ? `¥${actionPlan.entry_zone[0].toFixed(2)} ~ ¥${actionPlan.entry_zone[1].toFixed(
                    2
                  )}`
                : '—'}
            </Text>
          </Col>
          <Col span={12}>
            <Text type="secondary">建议仓位：</Text>
            <Text strong>
              {/* BA-A (用户清单 #14) — hold 双形态歧义修复:
                  - position_action='maintain' (有持仓+hold) → "维持当前仓位" (不显示 0%)
                  - position_action='avoid' (无持仓+hold/sell) → "不建议建仓"
                  - position_action='open' → 显示具体仓位 % (suggested_position_pct)
                  - position_action='close' → 显示卖出文案
                  - position_action='unknown' (旧 archive) → fallback 走原逻辑 (显示 pct%) */}
              {actionPlan.position_action === 'maintain'
                ? actionPlan.position_action_label
                : actionPlan.position_action === 'avoid'
                  ? actionPlan.position_action_label
                  : actionPlan.position_action === 'close'
                    ? actionPlan.position_action_label
                    : actionPlan.suggested_position_pct != null
                      ? `${(actionPlan.suggested_position_pct * 100).toFixed(1)}%`
                      : '—'}
            </Text>
          </Col>
          <Col span={12}>
            <Text type="secondary">止损价：</Text>
            <Text strong style={{ color: '#16a34a' }}>
              {actionPlan.stop_loss != null ? `¥${actionPlan.stop_loss.toFixed(2)}` : '—'}
            </Text>
          </Col>
          <Col span={12}>
            <Text type="secondary">止盈价：</Text>
            <Text strong style={{ color: '#dc2626' }}>
              {actionPlan.take_profit != null ? `¥${actionPlan.take_profit.toFixed(2)}` : '—'}
            </Text>
          </Col>
        </Row>
        {actionPlan.risk_warnings.length > 0 && (
          <>
            <Divider style={{ margin: '8px 0' }} />
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space>
                <ExclamationCircleOutlined style={{ color: '#fa541c' }} />
                <Text strong style={{ fontSize: 13 }}>
                  风险提示 ({actionPlan.risk_warnings.length})
                </Text>
              </Space>
              <ul style={{ marginBottom: 0, paddingLeft: 20 }}>
                {actionPlan.risk_warnings.slice(0, maxRiskWarningsShown).map((w, idx) => (
                  <li key={idx} style={{ fontSize: 12 }}>
                    <Text type="secondary">{w}</Text>
                  </li>
                ))}
              </ul>
            </Space>
          </>
        )}
      </Space>
    </div>
  );
};
