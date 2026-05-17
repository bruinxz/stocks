type SnapshotLike = {
  generated_at?: string | Date;
  created_at?: string | Date;
  avg_excess_return_pct?: number | string | null;
};

type FieldGateAdjustmentSource = {
  changed_at?: string | Date | null;
  task_name?: string;
  source?: string;
};

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundNumber(value: any, digits = 2): number {
  const num = toNumber(value, 0);
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function average(values: number[]): number {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

export class FieldGateAdjustmentAttributionService {
  build(snapshots: SnapshotLike[] = [], source: FieldGateAdjustmentSource = {}) {
    if (source.source !== 'filled_from_outcome_advice') {
      return this.noAdjustment();
    }

    const changedAt = new Date(source.changed_at || 0).getTime();
    if (!Number.isFinite(changedAt) || changedAt <= 0) {
      return this.noAdjustment('字段门槛采纳记录缺少有效时间，暂无法计算后验。');
    }

    const withTime = snapshots
      .map(snapshot => ({
        ts: new Date(snapshot.generated_at || snapshot.created_at || 0).getTime(),
        excess: toNumber(snapshot.avg_excess_return_pct, NaN),
      }))
      .filter(item => Number.isFinite(item.ts) && Number.isFinite(item.excess));
    const before = withTime.filter(item => item.ts < changedAt).slice(0, 8);
    const after = withTime.filter(item => item.ts >= changedAt).slice(0, 8);
    const beforeAvg = average(before.map(item => item.excess));
    const afterAvg = average(after.map(item => item.excess));
    const delta = after.length && before.length ? afterAvg - beforeAvg : 0;
    const windows = [7, 14, 30].map(days => {
      const end = changedAt + days * 24 * 60 * 60 * 1000;
      const afterWindow = withTime.filter(item => item.ts >= changedAt && item.ts <= end).slice(0, 20);
      const windowAvg = average(afterWindow.map(item => item.excess));
      const windowDelta = afterWindow.length && before.length ? windowAvg - beforeAvg : 0;
      return {
        days,
        sample_count: afterWindow.length,
        avg_excess_return_pct: roundNumber(windowAvg, 4),
        delta_pct: roundNumber(windowDelta, 4),
        conclusion:
          afterWindow.length < 2 || before.length < 2
            ? '样本不足'
            : windowDelta >= 0
            ? `提升 ${roundNumber(windowDelta, 2)}pct`
            : `下降 ${roundNumber(Math.abs(windowDelta), 2)}pct`,
      };
    });
    const decision = this.buildDecision(windows, before.length);
    return {
      status: after.length >= 2 && before.length >= 2 ? 'ready' : 'insufficient_samples',
      changed_at: source.changed_at,
      task_name: source.task_name,
      before_sample_count: before.length,
      after_sample_count: after.length,
      before_avg_excess_return_pct: roundNumber(beforeAvg, 4),
      after_avg_excess_return_pct: roundNumber(afterAvg, 4),
      delta_pct: roundNumber(delta, 4),
      windows,
      decision,
      conclusion:
        after.length < 2 || before.length < 2
          ? '字段门槛建议已人工保存，但前后收益样本仍不足，继续观察。'
          : delta >= 0
          ? `字段门槛建议保存后平均超额提升 ${roundNumber(delta, 2)}pct，当前调整方向可继续观察。`
          : `字段门槛建议保存后平均超额下降 ${roundNumber(
              Math.abs(delta),
              2
            )}pct，需要继续观察是否过度调参。`,
    };
  }

  noAdjustment(reason = '暂无来自收益后验建议的字段门槛人工保存记录。') {
    return {
      status: 'no_advice_adjustment',
      conclusion: reason,
      decision: {
        action: 'insufficient',
        label: '暂无采纳记录',
        confidence: 0,
        reason: '字段门槛尚无收益后验建议采纳记录。',
      },
    };
  }

  private buildDecision(windows: any[], beforeSampleCount: number) {
    const readyWindows = windows.filter(item => toNumber(item.sample_count) >= 2);
    const avgWindowDelta = average(readyWindows.map(item => Number(item.delta_pct)));
    const negativeWindows = readyWindows.filter(item => toNumber(item.delta_pct) < -0.4).length;
    const positiveWindows = readyWindows.filter(item => toNumber(item.delta_pct) > 0.4).length;
    if (readyWindows.length < 2 || beforeSampleCount < 2) {
      return {
        action: 'insufficient',
        label: '样本不足',
        confidence: 0,
        reason: '字段门槛调参后多窗口样本不足，继续观察。',
      };
    }
    if (negativeWindows >= 2) {
      return {
        action: 'caution',
        label: '谨慎沿用',
        confidence: roundNumber(Math.min(0.9, 0.45 + negativeWindows * 0.15), 2),
        reason: `字段门槛调参后 ${negativeWindows}/${readyWindows.length} 个窗口跑弱，平均变化 ${roundNumber(
          avgWindowDelta,
          2
        )}pct。`,
      };
    }
    if (positiveWindows >= 2) {
      return {
        action: 'support',
        label: '支持沿用',
        confidence: roundNumber(Math.min(0.9, 0.45 + positiveWindows * 0.15), 2),
        reason: `字段门槛调参后 ${positiveWindows}/${readyWindows.length} 个窗口改善，平均变化 ${roundNumber(
          avgWindowDelta,
          2
        )}pct。`,
      };
    }
    return {
      action: 'observe',
      label: '继续观察',
      confidence: 0.4,
      reason: `字段门槛调参后多窗口分歧，平均变化 ${roundNumber(avgWindowDelta, 2)}pct。`,
    };
  }
}

export const fieldGateAdjustmentAttributionService = new FieldGateAdjustmentAttributionService();
