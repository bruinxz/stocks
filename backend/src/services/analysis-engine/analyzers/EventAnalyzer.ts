/**
 * EventAnalyzer — 把 EventIntelligenceLayer.filter() 输出 1:1 转 evidence + 透传
 * action (veto/dampen/delay/allow/boost) 给 aggregator.
 *
 * Aggregator 看到 event_action='veto' → 硬否决 action='hold'/'sell';
 * Aggregator 看到 event_action='dampen' → 加权分 × 0.5.
 */

import { BaseAnalyzer, RawAnalyzerResult } from './BaseAnalyzer';
import type { AnalyzerContext, AnalyzerKey, EvidenceItem } from '../AnalyzerTypes';

export interface EventIntelligenceFilterSource {
  filter(input: { symbol: string; as_of_date: string }): Promise<{
    symbol: string;
    action: 'allow' | 'boost' | 'dampen' | 'veto' | 'delay';
    score_multiplier: number;
    delay_minutes: number;
    events: Array<{
      event_type: string;
      score_multiplier: number;
      action_hint: 'allow' | 'boost' | 'dampen' | 'veto' | 'delay';
      reason: string;
    }>;
    reason: string;
  }>;
}

export const PRODUCTION_EVENT_INTELLIGENCE_SOURCE: EventIntelligenceFilterSource = {
  async filter(input) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { eventIntelligenceLayer } = require('../../event-intelligence/EventIntelligenceLayer');
    return eventIntelligenceLayer.filter(input);
  },
};

const ACTION_SCORE: Record<string, number> = {
  veto: -100,
  dampen: -25,
  delay: -10,
  allow: 0,
  boost: 25,
};

export class EventAnalyzer extends BaseAnalyzer {
  readonly key: AnalyzerKey = 'event';

  constructor(
    private readonly source: EventIntelligenceFilterSource = PRODUCTION_EVENT_INTELLIGENCE_SOURCE
  ) {
    super();
  }

  protected requiredFields: readonly string[] = [];

  protected async run(ctx: AnalyzerContext): Promise<RawAnalyzerResult> {
    const evidence: EvidenceItem[] = [];
    let metaResult: Awaited<ReturnType<EventIntelligenceFilterSource['filter']>>;
    try {
      metaResult = await this.source.filter({
        symbol: ctx.stock.code,
        as_of_date: ctx.as_of,
      });
    } catch (e: any) {
      return {
        score: 0,
        evidence: [
          {
            label: 'EventIntelligenceLayer 调用失败',
            detail: e?.message,
            direction: 'neutral',
            weight: 1,
          },
        ],
        data_sources: [],
        confidence: 0,
        data_missing: ['event_intelligence'],
      };
    }

    for (const ev of metaResult.events) {
      evidence.push({
        label: `${ev.event_type} (${ev.action_hint})`,
        detail: ev.reason,
        metric_value: ev.score_multiplier,
        direction:
          ev.action_hint === 'veto' || ev.action_hint === 'dampen'
            ? 'bearish'
            : ev.action_hint === 'boost'
            ? 'bullish'
            : 'neutral',
        weight: 1 / Math.max(1, metaResult.events.length),
      });
    }

    if (!metaResult.events.length) {
      evidence.push({
        label: '无显著事件',
        direction: 'neutral',
        weight: 1,
      });
    }

    const score = ACTION_SCORE[metaResult.action] ?? 0;

    return {
      score,
      evidence,
      data_sources: [{ name: 'event_intelligence_layer', as_of: ctx.as_of, is_realtime: false }],
      confidence: 0.8,
      data_missing: [],
      event_action: metaResult.action,
      event_score_multiplier: metaResult.score_multiplier,
    };
  }
}

export const eventAnalyzer = new EventAnalyzer();
