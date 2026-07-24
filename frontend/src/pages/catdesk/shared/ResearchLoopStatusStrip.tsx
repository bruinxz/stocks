import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  SyncOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Tag } from 'antd';
import type { ResearchTradingLoopDashboard } from 'services/researchTradingLoopService';

interface Props {
  dashboard: ResearchTradingLoopDashboard | null | undefined;
  error?: Error | null;
  focus: 'morning' | 'multibagger' | 'portfolio';
}

export function ResearchLoopStatusStrip({ dashboard, error, focus }: Props) {
  if (!dashboard) {
    if (!error) return null;
    return (
      <section
        className="catdesk-loop-strip is-unavailable"
        aria-label="研究交易闭环状态"
        role="status"
      >
        <div className="catdesk-loop-strip__flow">
          <span className="is-focus">
            <b>研究闭环未就绪</b>
            <small>{error.message}</small>
          </span>
        </div>
        <Tag icon={<WarningOutlined />} color="red">
          已暂停自动模拟交易
        </Tag>
      </section>
    );
  }
  const { research } = dashboard;
  const fresh = research.morning.fresh && research.multibagger.fresh;
  const run = fresh && dashboard.latest_run?.is_current ? dashboard.latest_run : null;
  const execution = dashboard.execution;
  const jointSummary = run
    ? `买 ${run.buy_count} · 持 ${run.hold_count} · 卖 ${run.sell_count}`
    : execution.status === 'scheduled'
      ? `${research.merged_target_count} 只目标 · 09:35 执行`
      : execution.status === 'waiting_for_quotes'
        ? `${research.merged_target_count} 只目标 · 行情 ${execution.fresh_quote_count ?? 0}/${
            execution.required_quote_count ?? research.merged_target_count
          }`
        : execution.status === 'market_closed'
          ? `${research.merged_target_count} 只目标 · 今日休市`
          : execution.status === 'ready'
            ? `${research.merged_target_count} 只目标 · 行情已齐`
            : execution.status === 'stalled' || execution.status === 'failed'
              ? '今日执行异常'
              : '暂停交易';
  const statusTone =
    execution.status === 'completed'
      ? { color: 'green', icon: <CheckCircleOutlined /> }
      : execution.status === 'running' || execution.status === 'ready'
        ? { color: 'blue', icon: <SyncOutlined spin={execution.status === 'running'} /> }
        : execution.status === 'scheduled' || execution.status === 'waiting_for_quotes'
          ? { color: 'gold', icon: <ClockCircleOutlined /> }
          : execution.status === 'market_closed'
            ? { color: 'default', icon: <ClockCircleOutlined /> }
            : { color: 'red', icon: <WarningOutlined /> };
  return (
    <section className="catdesk-loop-strip" aria-label="研究交易闭环状态">
      <div className="catdesk-loop-strip__flow">
        <span className={focus === 'morning' ? 'is-focus' : ''}>
          <b>A股早报</b>
          <small>
            {research.morning.research_day || '待生成'} · {research.morning.candidate_count} 只
          </small>
        </span>
        <i>＋</i>
        <span className={focus === 'multibagger' ? 'is-focus' : ''}>
          <b>高倍潜力</b>
          <small>
            {research.multibagger.research_day || '待生成'} · {research.multibagger.candidate_count}{' '}
            只
          </small>
        </span>
        <i>→</i>
        <span className={focus === 'portfolio' ? 'is-focus' : ''}>
          <b>联合决策</b>
          <small>{jointSummary}</small>
        </span>
        <i>→</i>
        <span>
          <b>研究闭环盘</b>
          <small>{run ? `${run.trading_day} · #${run.id}` : '今日尚未生成交易记录'}</small>
        </span>
      </div>
      {fresh && research.targets.length ? (
        <div className="catdesk-loop-targets" aria-label="今日联合目标池">
          <strong>今日目标池</strong>
          {research.targets.map(target => (
            <span key={target.symbol}>
              <b>{target.name}</b>
              <small>
                {target.symbol} · 研究 {target.source_size_hint_pct}% → 联合{' '}
                {target.target_weight_pct}% ·{' '}
                {target.sources.length > 1
                  ? '双源'
                  : target.sources[0] === 'morning_brief'
                    ? '早报'
                    : '高倍'}
              </small>
            </span>
          ))}
          <small className="catdesk-loop-targets__policy">
            研究建议 ×{research.allocation_policy.size_hint_multiplier}
            {research.allocation_policy.dual_source_bonus_pct
              ? `；双源确认 +${research.allocation_policy.dual_source_bonus_pct}%`
              : ''}
            ；单只上限 {research.allocation_policy.max_single_weight_pct}%；今日计划总仓位{' '}
            {research.allocation_policy.planned_gross_weight_pct}%
          </small>
        </div>
      ) : null}
      {fresh ? (
        <Tag icon={<CheckCircleOutlined />} color="green">
          研究日 {research.expected_research_day} 已对齐
        </Tag>
      ) : null}
      <Tag icon={statusTone.icon} color={statusTone.color}>
        {execution.message}
      </Tag>
      {execution.next_attempt_label ? <Tag>下次尝试 {execution.next_attempt_label}</Tag> : null}
    </section>
  );
}
