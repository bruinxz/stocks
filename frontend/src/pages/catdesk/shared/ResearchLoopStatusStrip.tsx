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
          <small>
            {run
              ? `买 ${run.buy_count} · 持 ${run.hold_count} · 卖 ${run.sell_count}`
              : '等待今日执行'}
          </small>
        </span>
        <i>→</i>
        <span>
          <b>研究闭环盘</b>
          <small>{run ? `${run.trading_day} · #${run.id}` : '尚无运行记录'}</small>
        </span>
      </div>
      <Tag
        icon={fresh ? <CheckCircleOutlined /> : <ClockCircleOutlined />}
        color={fresh ? 'green' : 'gold'}
      >
        {fresh ? `研究日 ${research.expected_research_day} 已对齐` : '研究数据未到齐，暂停交易'}
      </Tag>
      {run?.status === 'running' ? <Tag icon={<SyncOutlined spin />}>执行中</Tag> : null}
    </section>
  );
}
