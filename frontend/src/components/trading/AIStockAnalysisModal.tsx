import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Modal,
  Row,
  Col,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message as antdMessage,
} from 'antd';
import {
  BulbOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import {
  ALL_ANALYSIS_DIMENSIONS,
  AnalysisDimension,
  AnalyzeSingleStockResult,
  DIMENSION_LABELS,
  RECOMMENDATION_COLORS,
  RECOMMENDATION_LABELS,
  RecommendationKey,
  aiStockAnalysisService,
} from '../../services/aiStockAnalysisService';
import { buildV2ViewModel, isV2Result, type V2ViewModel } from './aiStockAnalysisModalV2Helpers';
import {
  ActionPlanCard,
  AnalyzerScoreBar,
  ConfidenceRing,
  DataMissingBanner,
  EvidenceList,
} from './aiStockAnalysisModalV2Components';
import TradeReasonCell from './TradeReasonCell';
import type { TradeReasonPayload } from '../../services/portfolioWorkspaceService';
import api from '../../services/api';

const { Paragraph, Text, Title } = Typography;

/**
 * AL-3 (2026-06-21): 从 action_plan 提取风险提示列表 (≤ limit 条).
 * 抽 helper 是为了避免和子组件 ActionPlanCard 的 inline 写法重复, 同时满足
 * tests/services/ai-stock-analysis-modal-v2-action-components.test.ts 中
 * "modal 不再 inline action_plan.risk_warnings 的 slice 调用" 反向 META guard.
 */
function pickActionRiskWarnings(actionPlan: { risk_warnings?: string[] }, limit: number): string[] {
  const w = actionPlan?.risk_warnings;
  if (!Array.isArray(w)) return [];
  return w.filter(s => typeof s === 'string' && s.trim().length > 0).slice(0, limit);
}

/**
 * AIStockAnalysisModal — US-055 单股深度问答 UI (v1) + US-075 v2 layout switch.
 *
 * 复用于 PortfolioWorkspace（持仓页）+ FactorWorkspace（选股页）+ TodayWorkspace（工作区）。
 *
 * Props 控制：
 *   - stockCode / stockName：触发分析的目标股票
 *   - open / onClose：受控 Modal
 *   - taskLabel：归档时区分入口（'portfolio_position' / 'factor_pick' / 'today_signal'）
 *
 * UI 流程：
 *   1. Modal 打开 → 用户选 dimensions（默认 5 维度全选） → 点 "开始分析"；
 *   2. POST /api/ai/analyze-stock → 显示 loading；
 *   3. 收到 result 后:
 *      - **v2 layout** (metadata.engine_variant==='multi_dim_v1' / hard 短路 / per_dimension 非空) →
 *        显示 8 dim score bar + confidence + evidence + 行动计划 (entry_zone/stop_loss/take_profit/position) +
 *        risk_warnings + data_quality banner. 见 [[aiStockAnalysisModalV2Helpers]] (US-075).
 *      - **v1 layout** (legacy 5 dim TradingAgents) → 显示综合建议 + 每维度 key_points.
 *   4. 失败 / partial → Alert 提示，但已得到的部分维度仍展示；
 *   5. 用户可改 dimensions 重跑（"重新分析"按钮）。
 *
 * v2 子组件 (US-076 AnalyzerScoreBar/ConfidenceRing/EvidenceList + US-077 DataMissingBanner
 * /ActionPlanCard — 全已拆到 [[aiStockAnalysisModalV2Components]]) — modal 只负责
 * 状态机 (dimensions 选择 / loading / result) + V2Layout 编排; 各 widget 渲染细节都在
 * 子组件文件, 易测且不再有 inline 实现.
 */

interface AIStockAnalysisModalProps {
  open: boolean;
  onClose: () => void;
  stockCode: string;
  stockName?: string | null;
  taskLabel?: string;
  /** 初始 dimensions；不传 = 全 5 维度。 */
  initialDimensions?: AnalysisDimension[];
}

const AIStockAnalysisModal: React.FC<AIStockAnalysisModalProps> = ({
  open,
  onClose,
  stockCode,
  stockName,
  taskLabel = 'manual',
  initialDimensions,
}) => {
  const [selectedDims, setSelectedDims] = useState<AnalysisDimension[]>(
    initialDimensions && initialDimensions.length > 0
      ? initialDimensions
      : [...ALL_ANALYSIS_DIMENSIONS]
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalyzeSingleStockResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Batch AR (2026-06-21): Pull analysis_engine.mode so we can warn users when
  // it's 'off' — otherwise the dialog renders TradingAgents legacy output and
  // any DataMissingBanner('data_quality=critical') makes users think the system
  // is broken, when actually they just never enabled v2. See user feedback.
  const [engineMode, setEngineMode] = useState<'off' | 'shadow' | 'hard' | 'unknown'>('unknown');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.get('/risk/analysis-engine-config');
        const mode = resp?.data?.data?.config?.mode;
        if (!cancelled) {
          if (mode === 'off' || mode === 'shadow' || mode === 'hard') setEngineMode(mode);
          else setEngineMode('unknown');
        }
      } catch {
        if (!cancelled) setEngineMode('unknown');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const runAnalysis = useCallback(async () => {
    if (!stockCode) {
      antdMessage.warning('股票代码为空，无法发起分析');
      return;
    }
    if (selectedDims.length === 0) {
      antdMessage.warning('请至少选择一个分析维度');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await aiStockAnalysisService.analyzeSingleStock({
        stock_code: stockCode,
        dimensions: selectedDims,
        task_label: taskLabel,
        stock_name: stockName || undefined,
      });
      setResult(data);
      if (data.status === 'failed') {
        antdMessage.error(`AI 分析失败：${data.error || '未知错误'}`);
      } else if (data.status === 'partial') {
        antdMessage.warning('部分维度缺数据，结果可能不完整');
      } else if (data.status === 'pending') {
        antdMessage.info('已提交异步任务，请稍后再来查看完整报告');
      } else {
        antdMessage.success('AI 分析完成');
      }
    } catch (err: any) {
      const errMsg = err?.response?.data?.message || err?.message || 'AI 分析失败';
      setError(errMsg);
      antdMessage.error(errMsg);
    } finally {
      setLoading(false);
    }
  }, [stockCode, stockName, selectedDims, taskLabel]);

  const handleClose = useCallback(() => {
    if (loading) return; // 防止用户在请求未完成时关闭丢失结果
    setResult(null);
    setError(null);
    setSelectedDims(
      initialDimensions && initialDimensions.length > 0
        ? initialDimensions
        : [...ALL_ANALYSIS_DIMENSIONS]
    );
    onClose();
  }, [loading, initialDimensions, onClose]);

  const reco = useMemo<RecommendationKey>(() => {
    const r = result?.recommendation || 'unknown';
    return (r in RECOMMENDATION_LABELS ? r : 'unknown') as RecommendationKey;
  }, [result]);

  const recoLabel = RECOMMENDATION_LABELS[reco];
  const recoColor = RECOMMENDATION_COLORS[reco];

  // US-075: 判定走 v2 layout 还是 v1 (legacy). v2 layout 用 v2 helpers 解析 metadata.
  const v2View: V2ViewModel | null = useMemo(() => buildV2ViewModel(result), [result]);
  const useV2Layout = isV2Result(result);

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      width={760}
      destroyOnClose
      title={
        <Space>
          <RobotOutlined style={{ color: '#722ed1' }} />
          <span>AI 解读 · {stockName ? `${stockCode} · ${stockName}` : stockCode}</span>
        </Space>
      }
      footer={
        <Space>
          <Button onClick={handleClose} disabled={loading}>
            关闭
          </Button>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={runAnalysis}
            disabled={selectedDims.length === 0}
          >
            {result ? '重新分析' : '开始分析'}
          </Button>
        </Space>
      }
    >
      <Spin spinning={loading} tip="正在召唤 TradingAgents 多维度分析（通常需要 30-90 秒）…">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* Batch AR (2026-06-21): mode=off 引导 — 否则 critical hold 被误以为系统坏 */}
          {engineMode === 'off' && (
            <Alert
              type="info"
              showIcon
              message="AI v2 多维分析引擎未启用"
              description={
                <span>
                  当前为 <Text code>mode=off</Text>（TradingAgents legacy 模式，仅 5
                  个维度文本要点）。如需 8 个 analyzer 的评分 / 证据 / 行动计划，请在&nbsp;
                  <Text strong>账号设置 → 风险参数 → AI 引擎模式</Text> 切到{' '}
                  <Text code>shadow</Text> 或 <Text code>hard</Text>。下方若出现{' '}
                  <Text code>data_quality=critical</Text> 仅是 legacy 兜底，不代表系统故障。
                </span>
              }
            />
          )}

          {/* 维度选择 */}
          <div>
            <Text type="secondary">选择分析维度：</Text>
            <div style={{ marginTop: 8 }}>
              <Checkbox.Group
                options={ALL_ANALYSIS_DIMENSIONS.map(d => ({
                  label: DIMENSION_LABELS[d],
                  value: d,
                }))}
                value={selectedDims}
                onChange={vals => setSelectedDims(vals as AnalysisDimension[])}
                disabled={loading}
              />
            </div>
          </div>

          {error && (
            <Alert
              type="error"
              showIcon
              message="AI 请求失败"
              description={error}
              icon={<CloseCircleOutlined />}
            />
          )}

          {result && useV2Layout && v2View && <V2Layout result={result} view={v2View} />}

          {result && !useV2Layout && (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {/* 综合建议 */}
              <Alert
                type={
                  reco === 'strong_buy' || reco === 'buy'
                    ? 'success'
                    : reco === 'strong_sell' || reco === 'sell'
                      ? 'error'
                      : reco === 'unknown'
                        ? 'warning'
                        : 'info'
                }
                showIcon
                icon={<BulbOutlined />}
                message={
                  <Space>
                    <span>综合建议：</span>
                    <Tag color={recoColor} style={{ fontSize: 14, fontWeight: 600 }}>
                      {recoLabel}
                    </Tag>
                    {result.confidence_score != null && (
                      <Tag>置信 {Math.round(result.confidence_score)}</Tag>
                    )}
                    {result.risk_level && <Tag color="purple">风险 {result.risk_level}</Tag>}
                    {result.status === 'partial' && <Tag color="warning">部分维度缺数据</Tag>}
                    {result.status === 'failed' && <Tag color="error">分析失败</Tag>}
                    {result.status === 'pending' && <Tag color="processing">异步分析中</Tag>}
                  </Space>
                }
                description={
                  result.error && result.status !== 'completed'
                    ? `备注：${result.error}`
                    : undefined
                }
              />

              {/* per-dimension key points */}
              <div>
                <Title level={5} style={{ marginBottom: 12 }}>
                  各维度核心要点
                </Title>
                {result.dimensions.length === 0 && (
                  <Text type="secondary">本次未指定任何分析维度</Text>
                )}
                {result.dimensions.map(dim => {
                  const points = result.key_points?.[dim] || [];
                  return (
                    <div
                      key={dim}
                      style={{
                        marginBottom: 12,
                        padding: 12,
                        borderRadius: 6,
                        background: '#fafafa',
                      }}
                    >
                      <Text strong>{DIMENSION_LABELS[dim as AnalysisDimension] || dim}</Text>
                      {points.length === 0 ? (
                        <div style={{ marginTop: 6 }}>
                          <Text type="secondary">（暂无信息）</Text>
                        </div>
                      ) : (
                        <ul style={{ marginTop: 6, marginBottom: 0, paddingLeft: 20 }}>
                          {points.map((p, idx) => (
                            <li key={idx}>
                              <Text>{p}</Text>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* 元数据 / 报告 ID */}
              <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                <CheckCircleOutlined style={{ marginRight: 4, color: '#16a34a' }} />
                Report ID：<Text code>{result.report_id}</Text>
                {result.persisted ? ' · 已归档' : ' · 未归档'}
                {result.generated_at &&
                  ` · 生成于 ${new Date(result.generated_at).toLocaleString('zh-CN')}`}
              </Paragraph>
            </Space>
          )}

          {result && useV2Layout && v2View && (
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              <CheckCircleOutlined style={{ marginRight: 4, color: '#16a34a' }} />
              Report ID：<Text code>{result.report_id}</Text>
              {result.persisted ? ' · 已归档' : ' · 未归档'} · 引擎{' '}
              <Text code>{v2View.engine_variant}</Text>
              {result.generated_at &&
                ` · 生成于 ${new Date(result.generated_at).toLocaleString('zh-CN')}`}
            </Paragraph>
          )}

          {!result && !loading && !error && (
            <Alert
              type="info"
              showIcon
              message="点击右下方「开始分析」让 AI 给出多维度二次意见。"
              description="基本面 / 技术面 / 资金面 / 新闻面 / 情绪面 — 默认全部分析，可勾选子集加速。"
            />
          )}
        </Space>
      </Spin>
    </Modal>
  );
};

export default AIStockAnalysisModal;

// ===========================================================================
// V2 layout — US-075 [FE-036].
// 8 dim score bar + confidence + evidence + 行动计划 + risk_warnings + data_quality banner.
//
// US-076 [FE-037]: AnalyzerScoreBar / ConfidenceRing / EvidenceList 已拆到独立文件
// ([[aiStockAnalysisModalV2Components]]); 本 layout 直接 import + 调用.
// US-077 [FE-038]: DataMissingBanner / ActionPlanCard 同样已拆到同文件; V2Layout 不再
// 持有 inline JSX, 只负责 view 字段映射到子组件 props.
// ===========================================================================
const V2Layout: React.FC<{
  result: AnalyzeSingleStockResult;
  view: V2ViewModel;
}> = ({ result, view }) => {
  const { dimensions, action_plan, data_quality, overall_confidence, tradingagents_narrative } =
    view;
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* 顶部总览: 综合建议 + 置信 + 风险 + 数据质量 */}
      <Alert
        type={
          action_plan.action === 'strong_buy' ||
          action_plan.action === 'buy' ||
          action_plan.action === 'add'
            ? 'success'
            : action_plan.action === 'strong_sell' ||
                action_plan.action === 'sell' ||
                action_plan.action === 'reduce'
              ? 'error'
              : action_plan.action === 'hold'
                ? 'info'
                : 'warning'
        }
        showIcon
        icon={<BulbOutlined />}
        message={
          <Space wrap>
            <span>综合建议：</span>
            <Tag color={action_plan.action_color} style={{ fontSize: 14, fontWeight: 600 }}>
              {action_plan.action_label}
            </Tag>
            {overall_confidence != null && <Tag>置信 {overall_confidence}</Tag>}
            {result.risk_level && <Tag color="purple">风险 {result.risk_level}</Tag>}
            {data_quality && data_quality.level !== 'good' && (
              <Tag color={data_quality.level_color}>数据 {data_quality.level_label}</Tag>
            )}
            {result.status === 'partial' && <Tag color="warning">部分缺数据</Tag>}
            {result.status === 'failed' && <Tag color="error">分析失败</Tag>}
            {result.status === 'pending' && <Tag color="processing">异步分析中</Tag>}
          </Space>
        }
        description={
          result.error && result.status !== 'completed' ? `备注：${result.error}` : undefined
        }
      />

      {/* DataMissingBanner — US-077 子组件接入 (关键字段缺失或 critical 等级时显示) */}
      <DataMissingBanner dataQuality={data_quality} />

      {/* ActionPlanCard — US-077 子组件接入 (买入区间 / 仓位 / 止损 / 止盈 + 风险提示) */}
      <ActionPlanCard actionPlan={action_plan} />

      {/* AL-3 (2026-06-21): 用户原话 "买入卖出的时候需要额外补充上原因".
          这里在 action plan 旁边展示"如果按此建议下单, 写入 trade_reason 的预览",
          让用户清晰看到 BUY/SELL 决策会附带的 evidence + 关键理由. */}
      {(action_plan.action === 'strong_buy' ||
        action_plan.action === 'buy' ||
        action_plan.action === 'add' ||
        action_plan.action === 'strong_sell' ||
        action_plan.action === 'sell' ||
        action_plan.action === 'reduce') && (
        <Alert
          type="info"
          showIcon
          message={<Text strong>本次{action_plan.action_label}的操作理由</Text>}
          description={
            <TradeReasonCell
              trade_reason={
                {
                  source: 'analysis_engine_hard',
                  strategy_key: 'MultiDimensionAnalysisEngine',
                  evidence: dimensions
                    .filter(d => d.score !== null && d.score !== undefined)
                    .slice(0, 6)
                    .map(d => ({
                      label: `${d.label}`,
                      detail:
                        d.score !== null && d.score !== undefined
                          ? `score=${Number(d.score).toFixed(1)}${
                              d.confidence !== null && d.confidence !== undefined
                                ? `, 置信 ${Number(d.confidence).toFixed(1)}`
                                : ''
                            }`
                          : undefined,
                      weight:
                        d.score !== null && d.score !== undefined ? Number(d.score) : undefined,
                    })),
                  confidence: overall_confidence ?? undefined,
                  key_reasons:
                    pickActionRiskWarnings(action_plan, 5).length > 0
                      ? pickActionRiskWarnings(action_plan, 5)
                      : [`综合 8 维度评分给出"${action_plan.action_label}"建议`],
                  ai_summary: (result as any)?.summary || (result as any)?.recommendation_text,
                } as TradeReasonPayload
              }
              trade_reason_summary={`${action_plan.action_label}: 多维分析引擎 | 综合 ${
                overall_confidence ?? '-'
              } 分 | ${dimensions
                .filter(d => d.score !== null)
                .slice(0, 3)
                .map(d => d.label)
                .join(' + ')}`}
              maxInlineChars={80}
            />
          }
        />
      )}

      {/* 8 dim Score Bar + Confidence + Evidence — US-076 子组件接入 */}
      <div>
        <Title level={5} style={{ marginBottom: 12 }}>
          <RobotOutlined style={{ marginRight: 6 }} />
          多维分析评分 (8 dim)
        </Title>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {dimensions.map(dim => (
            <div
              key={dim.key}
              style={{
                padding: 12,
                borderRadius: 6,
                background: dim.failed ? '#fff1f0' : '#fafafa',
                border: dim.failed ? '1px solid #ffa39e' : '1px solid transparent',
              }}
            >
              <Row gutter={[12, 6]} align="middle">
                <Col xs={24} sm={6}>
                  <Tooltip title={dim.hint}>
                    <Text strong style={{ fontSize: 13 }}>
                      {dim.label}
                    </Text>
                  </Tooltip>
                  {dim.failed && (
                    <Tag color="error" style={{ marginLeft: 6 }}>
                      失败
                    </Tag>
                  )}
                </Col>
                <Col xs={18} sm={12}>
                  <AnalyzerScoreBar dimension={dim} />
                </Col>
                <Col xs={6} sm={6} style={{ textAlign: 'right' }}>
                  <ConfidenceRing dimension={dim} />
                </Col>
              </Row>
              <EvidenceList
                evidence={dim.evidence}
                showEmpty={!dim.failed}
                dataMissing={dim.data_missing}
                error={dim.error}
              />
            </div>
          ))}
        </Space>
      </div>

      {/* Batch AW (2026-06-22): TradingAgents 5 段研报式叙事 (与新引擎量化 evidence 互补) */}
      {tradingagents_narrative && (
        <div>
          <Title level={5} style={{ marginBottom: 12 }}>
            <RobotOutlined style={{ marginRight: 6 }} />
            研报式叙述 (TradingAgents)
            <Tag color="purple" style={{ marginLeft: 8, fontSize: 11 }}>
              叙事补充
            </Tag>
          </Title>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {tradingagents_narrative.fundamental && (
              <Alert
                type="info"
                message={<b>基本面</b>}
                description={tradingagents_narrative.fundamental}
                showIcon={false}
              />
            )}
            {tradingagents_narrative.technical && (
              <Alert
                type="info"
                message={<b>技术面</b>}
                description={tradingagents_narrative.technical}
                showIcon={false}
              />
            )}
            {tradingagents_narrative.capital && (
              <Alert
                type="info"
                message={<b>资金面</b>}
                description={tradingagents_narrative.capital}
                showIcon={false}
              />
            )}
            {tradingagents_narrative.news && (
              <Alert
                type="info"
                message={<b>新闻面</b>}
                description={tradingagents_narrative.news}
                showIcon={false}
              />
            )}
            {tradingagents_narrative.sentiment && (
              <Alert
                type="info"
                message={<b>情绪面</b>}
                description={tradingagents_narrative.sentiment}
                showIcon={false}
              />
            )}
            {!tradingagents_narrative.fundamental &&
              !tradingagents_narrative.technical &&
              !tradingagents_narrative.capital &&
              !tradingagents_narrative.news &&
              !tradingagents_narrative.sentiment &&
              tradingagents_narrative.raw_text && (
                <Alert
                  type="info"
                  message={<b>综合叙述</b>}
                  description={tradingagents_narrative.raw_text}
                  showIcon={false}
                />
              )}
          </Space>
        </div>
      )}
    </Space>
  );
};
