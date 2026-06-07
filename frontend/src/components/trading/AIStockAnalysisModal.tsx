import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Modal,
  Space,
  Spin,
  Tag,
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

const { Paragraph, Text, Title } = Typography;

/**
 * AIStockAnalysisModal — US-055 单股深度问答 UI
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
 *   3. 收到 result 后显示综合建议 + 每维度 key_points；
 *   4. 失败 / partial → Alert 提示，但已得到的部分维度仍展示；
 *   5. 用户可改 dimensions 重跑（"重新分析"按钮）。
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

          {result && (
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
                      <Text strong>
                        {DIMENSION_LABELS[dim as AnalysisDimension] || dim}
                      </Text>
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
                <CheckCircleOutlined style={{ marginRight: 4, color: '#52c41a' }} />
                Report ID：<Text code>{result.report_id}</Text>
                {result.persisted ? ' · 已归档' : ' · 未归档'}
                {result.generated_at &&
                  ` · 生成于 ${new Date(result.generated_at).toLocaleString('zh-CN')}`}
              </Paragraph>
            </Space>
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
