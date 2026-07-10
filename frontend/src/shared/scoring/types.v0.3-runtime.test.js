import { describe, expect, test } from '@jest/globals';
import { TextEncoder } from 'util';
import { MARKET_SCOPES_V0_3, RISK_GATE_TRIGGER_CODES_V0_3, WEIGHTS_PROFILES_V0_3 } from './types';
import { runScoringPipeline } from './pipeline';

const EXPECTED_RISK_CODES = [
  'EARNINGS_T-2',
  'EARNINGS_T-0',
  'HALT_ACTIVE',
  'MERGER_PENDING',
  'LITIGATION_MATERIAL',
  'IV_SHOCK',
  'LIQUIDITY_LOW',
  'RESTATEMENT_30D',
  'DELISTING_NOTICE',
  'ST_TAG',
  'PRICE_LIMIT_APPROACH',
  'SUSPENDED',
  'TSE_HALT',
  'EDINET_DELAY',
  'CORPORATE_GOVERNANCE_ISSUE',
  'TSE_TOKUBETSU_CHI',
  'TSE_KANRI',
  'KRX_HALT',
  'DART_LATE_FILING',
  'INSIDER_TRADING_FLAG',
  'KRX_UNFAITHFUL',
  'KRX_INVESTOR_ALERT',
];

describe('scoring v0.3 runtime contract', () => {
  test('market scopes and weight profiles are exact and unique', () => {
    expect(MARKET_SCOPES_V0_3).toEqual(['cn_a', 'us', 'jp', 'kr']);
    expect(new Set(MARKET_SCOPES_V0_3).size).toBe(4);
    expect(WEIGHTS_PROFILES_V0_3).toEqual([
      'us_preferred',
      'multibagger',
      'custom',
      'japan_blue_chip',
      'korea_semiconductor_chain',
      'japan_multibagger',
      'korea_multibagger',
    ]);
    expect(new Set(WEIGHTS_PROFILES_V0_3).size).toBe(7);
  });

  test('RiskGate codes match the exact ordered Strategy v0.3 set', () => {
    expect(RISK_GATE_TRIGGER_CODES_V0_3).toEqual(EXPECTED_RISK_CODES);
    expect(new Set(RISK_GATE_TRIGGER_CODES_V0_3).size).toBe(22);
  });

  test('scoring pipeline preserves the input market scope', async () => {
    const originalCrypto = globalThis.crypto;
    const originalTextEncoder = globalThis.TextEncoder;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        randomUUID: () => '00000000-0000-4000-8000-000000000001',
        subtle: {
          digest: async () => new Uint8Array(32).buffer,
        },
      },
    });
    Object.defineProperty(globalThis, 'TextEncoder', {
      configurable: true,
      value: TextEncoder,
    });

    try {
      const result = await runScoringPipeline(
        {
          ticker: '7203',
          as_of: '2026-07-10',
          market_scope: 'jp',
          quality_inputs: {
            roic_5y_median: 18,
            roe_5y_median: 16,
            fcf_margin_5y_median: 12,
            gross_margin_stability_5y_sigma: 1,
            interest_coverage_4q: 9,
            accruals_ratio_sloan: 0.02,
          },
          growth_inputs: {
            revenue_cagr_3y: 12,
            revenue_cagr_5y: 10,
            eps_cagr_3y: 15,
            eps_cagr_5y: 12,
            segment_mix_available: false,
          },
          valuation_inputs: {
            pe_ttm: 18,
            ev_ebitda_ttm: 10,
            pb: 1.4,
            peer_pe_percentile: 40,
            peer_ev_ebitda_percentile: 45,
            fcf_yield: 4,
          },
          moat_inputs: {
            gross_margin_absolute: 35,
            gross_margin_sector_rank: 25,
            roic_wacc_spread_2y: 8,
            market_share_stability_3y: 0.8,
            intangible_rd_intensity: 0.12,
            evidence: ['market share stable', 'ROIC exceeds WACC'],
          },
          trend_inputs: {
            ma_50d: 110,
            ma_200d: 100,
            ma_cross_slope: 0.4,
            return_6m_sector_percentile: 70,
            rs_line_vs_sector: 1.2,
          },
          risk_inputs: {
            realized_vol_30d: 20,
            realized_vol_90d: 22,
            max_drawdown_12m: -18,
            beta_30d_rolling: 0.9,
            net_debt_ebitda: 1,
            current_ratio: 1.5,
            concentration_risk: 0.2,
            regulatory_litigation_flag: false,
          },
        },
        {
          profile: 'japan_blue_chip',
          adjustments: [],
          timestamp: '2026-07-10T06:00:00Z',
          riskSignals: {
            ticker: '7203',
            earningsDaysAway: null,
            isHalted: false,
            mergerPending: false,
            litigationMaterial30d: false,
            ivPercentile30d: 50,
            avgDailyValueUsd: 10_000_000,
            restatement30d: false,
            delistingNotice: false,
            stTag: false,
            priceLimitApproachPct: null,
            isSuspended: false,
          },
        }
      );

      expect(result.score.market_scope).toBe('jp');
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
      if (originalTextEncoder) {
        Object.defineProperty(globalThis, 'TextEncoder', {
          configurable: true,
          value: originalTextEncoder,
        });
      } else {
        delete globalThis.TextEncoder;
      }
    }
  });
});
