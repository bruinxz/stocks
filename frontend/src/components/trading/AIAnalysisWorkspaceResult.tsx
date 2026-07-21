import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Space, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  FileSearchOutlined,
  LoadingOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { useAIAnalysis } from '../../contexts/AIAnalysisContext';
import {
  DIMENSION_LABELS,
  RECOMMENDATION_COLORS,
  RECOMMENDATION_LABELS,
  RecommendationKey,
} from '../../services/aiStockAnalysisService';
import AIPriceDecisionCard from './AIPriceDecisionCard';

const { Paragraph, Text, Title } = Typography;

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return minutes > 0 ? `${minutes} 分 ${remain} 秒` : `${remain} 秒`;
}

export default function AIAnalysisWorkspaceResult() {
  const { job, is_running, clearAnalysis } = useAIAnalysis();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!is_running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [is_running]);

  const elapsed = useMemo(() => {
    if (!job) return 0;
    if ((job.phase === 'completed' || job.phase === 'failed') && job.elapsed_time > 0) {
      return job.elapsed_time;
    }
    const localElapsed = Math.max(0, (now - new Date(job.started_at).getTime()) / 1000);
    return Math.max(localElapsed, job.elapsed_time || 0);
  }, [job, now]);

  if (!job) return null;

  const result = job.result;
  const stockLabel = job.request.stock_name
    ? `${job.request.stock_code} · ${job.request.stock_name}`
    : job.request.stock_code;
  const recommendation = (result?.recommendation || 'unknown') as RecommendationKey;
  const recommendationLabel = RECOMMENDATION_LABELS[recommendation] || '暂无明确建议';
  const phaseCopy =
    job.phase === 'submitting'
      ? '正在登记会审任务'
      : job.phase === 'recovering'
        ? '正在恢复上次会审'
        : job.phase === 'pending'
          ? '已排队，等待多智能体接手'
          : job.phase === 'processing'
            ? '研究员、交易员与风控角色正在会审'
            : job.phase === 'completed'
              ? '会审完成，结果已归档'
              : '本次会审未完成';

  return (
    <section className={`ai-analysis-sheet is-${job.phase}`} aria-live="polite">
      <header className="ai-analysis-sheet__header">
        <div>
          <span className="ai-analysis-sheet__eyebrow">
            {is_running ? <LoadingOutlined spin /> : <FileSearchOutlined />} 会审稿
          </span>
          <Title level={3}>{stockLabel}</Title>
          <Paragraph>{phaseCopy}</Paragraph>
        </div>
        <div className="ai-analysis-sheet__clock">
          <ClockCircleOutlined />
          <span>已用时</span>
          <strong>{formatDuration(elapsed)}</strong>
        </div>
      </header>

      {is_running ? (
        <div className="ai-analysis-sheet__working">
          <div className="ai-analysis-sheet__pulse" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div>
            <strong>任务在页面之外持续运行</strong>
            <p>现在可以切换到其他页签；回来后这里会继续显示真实状态和最终结果。</p>
            {job.poll_failures > 0 ? (
              <Text type="warning">状态连接短暂波动，正在自动重试。</Text>
            ) : null}
          </div>
        </div>
      ) : null}

      {job.phase === 'failed' ? (
        <Alert
          type="error"
          showIcon
          icon={<CloseCircleOutlined />}
          message="AI 会审失败"
          description={job.error || result?.error || '任务没有返回可用结果'}
          action={<Button onClick={clearAnalysis}>重新选择股票</Button>}
        />
      ) : null}

      {job.phase === 'completed' && result ? (
        <div className="ai-analysis-sheet__result">
          <div className="ai-analysis-sheet__verdict">
            <div>
              <span>综合判断</span>
              <Tag color={RECOMMENDATION_COLORS[recommendation]}>{recommendationLabel}</Tag>
            </div>
            <Space wrap>
              {result.confidence_score != null ? (
                <Tag>置信 {Math.round(Number(result.confidence_score))}</Tag>
              ) : null}
              {result.risk_level ? <Tag color="orange">风险 {result.risk_level}</Tag> : null}
              {result.status === 'partial' ? <Tag color="warning">部分维度缺数据</Tag> : null}
            </Space>
          </div>

          {result.market_snapshot && result.price_decision ? (
            <AIPriceDecisionCard market={result.market_snapshot} plan={result.price_decision} />
          ) : (
            <Alert
              type="warning"
              showIcon
              message="研究报告已完成，但当前行情不足，未生成价格测算"
            />
          )}

          {result.summary ? (
            <article className="ai-analysis-sheet__summary">
              <span>会审摘要</span>
              <p>{result.summary}</p>
            </article>
          ) : null}

          <div className="ai-analysis-sheet__dimensions">
            {result.dimensions.map(dimension => {
              const points = result.key_points?.[dimension] || [];
              return (
                <article key={dimension}>
                  <strong>{DIMENSION_LABELS[dimension] || dimension}</strong>
                  {points.length > 0 ? (
                    <ul>
                      {points.map((point, index) => (
                        <li key={`${dimension}-${index}`}>{point}</li>
                      ))}
                    </ul>
                  ) : (
                    <Text type="secondary">暂无独立要点</Text>
                  )}
                </article>
              );
            })}
          </div>

          <footer className="ai-analysis-sheet__footer">
            <span>
              <CheckCircleOutlined /> Report ID：{result.report_id}
              {result.persisted ? ' · 已归档' : ''}
            </span>
            <Button icon={<RobotOutlined />} onClick={clearAnalysis}>
              分析另一只股票
            </Button>
          </footer>
        </div>
      ) : null}
    </section>
  );
}
