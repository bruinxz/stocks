import React from 'react';
import type { BacktestEvidenceStatus } from './types';

function progressLabel(observed?: number, required?: number, unit?: string): string | null {
  if (observed == null || required == null) return null;
  return `${observed}/${required}${unit ? ` ${unit}` : ''}`;
}

export function BacktestEvidenceBlockers({ status }: { status: BacktestEvidenceStatus }) {
  return (
    <section className="backtest-blockers" aria-labelledby="backtest-blockers-title">
      <header className="backtest-blockers__header">
        <div>
          <span>FAIL CLOSED · 历史证据门禁</span>
          <h3 id="backtest-blockers-title">证据不足，暂不展示收益曲线</h3>
        </div>
        <strong>
          {status.snapshot_count}/{status.required_checkpoint_count}
          <small> 已核验快照</small>
        </strong>
      </header>

      <p className="backtest-blockers__lead">
        这不是“稍后就会有数据”的空白状态。当前资料还不能证明策略在历史时点真的能选到这些股票，
        所以系统拒绝生成可能带有事后信息或幸存者偏差的漂亮曲线。
      </p>

      <ol className="backtest-blockers__list">
        {status.blockers.map((blocker, index) => {
          const progress = progressLabel(blocker.observed, blocker.required, blocker.unit);
          return (
            <li key={blocker.code}>
              <span className="backtest-blockers__index">{String(index + 1).padStart(2, '0')}</span>
              <div>
                <div className="backtest-blockers__title">
                  <strong>{blocker.title}</strong>
                  {progress && <code>{progress}</code>}
                </div>
                <p>{blocker.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <footer>
        <strong>放行条件</strong>
        <span>补齐上列仍缺失的历史证据后，再生成 27 个可追溯检查点。</span>
      </footer>
    </section>
  );
}
