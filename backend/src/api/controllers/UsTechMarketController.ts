import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database';
import { logger } from '../../utils/logger';

const THEME_LABELS: Record<string, string> = {
  semiconductor: '半导体',
  software_cloud: '软件与云',
  cybersecurity: '网络安全',
  internet_platform: '互联网平台',
  ai_robotics: 'AI 与机器人',
  broad_technology: '大型科技',
  nasdaq_100: '纳斯达克 100',
};

const MARKET_SQL = `
  WITH current_rows AS (
    SELECT DISTINCT ON (quote.symbol)
           quote.symbol,
           quote.instrument_name,
           quote.instrument_type,
           quote.theme,
           quote.is_sector_proxy,
           quote.is_focus,
           quote.exchange,
           quote.trading_day,
           quote.close,
           quote.volume,
           quote.currency,
           quote.source_kind
    FROM global_tech_daily_quote quote
    WHERE quote.market_scope = 'us'
      AND quote.trading_day <= CAST(:date AS date)
      AND quote.available_at_utc <= CAST(:cutoff AS timestamptz)
    ORDER BY quote.symbol,
             quote.trading_day DESC,
             quote.available_at_utc DESC,
             quote.source_version DESC
  )
  SELECT current_row.*,
         COALESCE(
           ROUND(((current_row.close / NULLIF(previous_row.close, 0)) - 1) * 100, 4),
           0
         ) AS change_pct,
         CASE
           WHEN five_day_row.close IS NULL THEN NULL
           ELSE ROUND(((current_row.close / NULLIF(five_day_row.close, 0)) - 1) * 100, 4)
         END AS change_5d_pct,
         ROUND(current_row.close * current_row.volume, 2) AS notional_volume
  FROM current_rows current_row
  LEFT JOIN LATERAL (
    SELECT quote.close
    FROM global_tech_daily_quote quote
    WHERE quote.market_scope = 'us'
      AND quote.symbol = current_row.symbol
      AND quote.trading_day < current_row.trading_day
      AND quote.available_at_utc <= CAST(:cutoff AS timestamptz)
    ORDER BY quote.trading_day DESC, quote.available_at_utc DESC, quote.source_version DESC
    LIMIT 1
  ) previous_row ON TRUE
  LEFT JOIN LATERAL (
    SELECT quote.close
    FROM global_tech_daily_quote quote
    WHERE quote.market_scope = 'us'
      AND quote.symbol = current_row.symbol
      AND quote.trading_day < current_row.trading_day
      AND quote.available_at_utc <= CAST(:cutoff AS timestamptz)
    ORDER BY quote.trading_day DESC, quote.available_at_utc DESC, quote.source_version DESC
    OFFSET 4
    LIMIT 1
  ) five_day_row ON TRUE
`;

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeInstrument(row: any): any {
  return {
    symbol: String(row.symbol),
    name: String(row.instrument_name),
    instrument_type: row.instrument_type,
    sector: row.theme,
    sector_label: THEME_LABELS[row.theme] || row.theme,
    exchange: String(row.exchange),
    close: numberOrZero(row.close),
    change_pct: numberOrZero(row.change_pct),
    change_5d_pct: nullableNumber(row.change_5d_pct),
    volume: numberOrZero(row.volume),
    notional_volume: numberOrZero(row.notional_volume),
    currency: row.currency,
    as_of: String(row.trading_day),
    data_source: String(row.source_kind),
  };
}

function cutoffForDate(date: string): string {
  return `${date}T23:59:59.999Z`;
}

export class UsTechMarketController {
  constructor() {
    this.getByDate = this.getByDate.bind(this);
  }

  async getByDate(req: Request, res: Response): Promise<void> {
    try {
      const { date } = req.params;
      const rows = await sequelize.query<any>(MARKET_SQL, {
        replacements: { date, cutoff: cutoffForDate(date) },
        type: QueryTypes.SELECT,
      });
      const normalized = rows.map(row => ({
        ...normalizeInstrument(row),
        is_sector_proxy: Boolean(row.is_sector_proxy),
        is_focus: Boolean(row.is_focus),
      }));

      const sector_performance = normalized
        .filter(row => row.is_sector_proxy)
        .sort((a, b) => b.change_pct - a.change_pct)
        .map(({ is_sector_proxy: _sectorProxy, is_focus: _focus, ...row }) => ({
          ...row,
          proxy_symbol: row.symbol,
          calculation_basis: 'proxy_etf',
        }));
      const sector_rank = new Map(
        sector_performance.map((sector, index) => [sector.sector, index])
      );
      const representative_tech_stocks = normalized
        .filter(row => row.instrument_type === 'stock' && row.is_focus)
        .sort((a, b) => {
          const sectorDelta =
            (sector_rank.get(a.sector) ?? Number.MAX_SAFE_INTEGER) -
            (sector_rank.get(b.sector) ?? Number.MAX_SAFE_INTEGER);
          return sectorDelta || b.change_pct - a.change_pct;
        })
        .map(({ is_sector_proxy: _sectorProxy, is_focus: _focus, ...row }) => row);
      const focus_etfs = normalized
        .filter(row => row.instrument_type === 'etf' && row.is_focus)
        .sort((a, b) => b.notional_volume - a.notional_volume)
        .map(({ is_sector_proxy: _sectorProxy, is_focus: _focus, ...row }, index) => ({
          ...row,
          attention_rank: index + 1,
          attention_basis: 'latest_dollar_volume',
        }));
      const leader = sector_performance[0] ?? null;
      const as_of = normalized.reduce<string | null>(
        (latest, row) => (!latest || row.as_of > latest ? row.as_of : latest),
        null
      );

      res.json({
        market: 'US',
        date,
        as_of,
        market_summary: {
          leader_sector: leader?.sector ?? null,
          leader_sector_label: leader?.sector_label ?? null,
          leader_change_pct: leader?.change_pct ?? null,
          advancing_sectors: sector_performance.filter(row => row.change_pct > 0).length,
          sector_count: sector_performance.length,
          tech_breadth_pct:
            sector_performance.length === 0
              ? 0
              : Math.round(
                  (sector_performance.filter(row => row.change_pct > 0).length /
                    sector_performance.length) *
                    1000
                ) / 10,
        },
        sector_performance,
        representative_tech_stocks,
        focus_etfs,
      });
    } catch (error: any) {
      logger.error(`[UsTechMarketController.getByDate] ${error?.message || error}`);
      res.status(500).json({ error: 'Failed to fetch US technology market data' });
    }
  }
}
