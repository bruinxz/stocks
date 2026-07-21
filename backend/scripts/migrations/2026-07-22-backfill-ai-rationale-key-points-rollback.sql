BEGIN;

UPDATE ai_stock_analysis_reports
   SET key_points_json = jsonb_build_object(
         'fundamental', '[]'::jsonb,
         'technical', '[]'::jsonb,
         'capital', '[]'::jsonb,
         'news', '[]'::jsonb,
         'sentiment', '[]'::jsonb
       ),
       summary = '**【AI 解读 · sz.002463 · 沪电股份】**' || E'\n' || '- 综合建议：卖出',
       status = 'partial',
       error = '部分维度缺失关键要点（key_points 不完整）',
       metadata = metadata - 'tradingagents_rationale' - 'rationale_key_points_backfill',
       updated_at = NOW()
 WHERE report_id = 'AI-002463-20260721094000-65de'
   AND metadata->>'rationale_key_points_backfill' = '2026-07-22';

UPDATE ai_stock_analysis_reports
   SET key_points_json = jsonb_build_object(
         'fundamental', '[]'::jsonb,
         'technical', '[]'::jsonb,
         'capital', '[]'::jsonb,
         'news', '[]'::jsonb,
         'sentiment', '[]'::jsonb
       ),
       summary = '**【AI 解读 · sz.002463 · 沪电股份】**' || E'\n' || '- 综合建议：持有 / 观望',
       status = 'partial',
       error = '部分维度缺失关键要点（key_points 不完整）',
       metadata = metadata - 'tradingagents_rationale' - 'rationale_key_points_backfill',
       updated_at = NOW()
 WHERE report_id = 'AI-002463-20260721085928-c294'
   AND metadata->>'rationale_key_points_backfill' = '2026-07-22';

COMMIT;
