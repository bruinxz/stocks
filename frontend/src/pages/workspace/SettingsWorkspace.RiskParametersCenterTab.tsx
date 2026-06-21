/**
 * SettingsWorkspace.RiskParametersCenterTab — US-066 / FE-027 / US-135 [PR-020]
 *
 * **风控参数中心** — 把所有 backend risk guard 的阈值合并到一个 tab,
 * 让用户在同一个面板内编辑所有"挡 BUY / 触发减仓 / 全清仓 / 全市场暂停"类阈值,
 * 不用在多个隐藏入口之间跳。
 *
 * 接入的 8 个 backend endpoint (全部沿用 RiskController 既有 GET/PUT):
 *   1. /api/risk/position-limits         (US-047 PositionLimitGuard) — pre-trade
 *   2. /api/risk/trailing-stop           (US-048 TrailingStopGuard) — 持仓监控
 *   3. /api/risk/drawdown-breaker        (US-049 DrawdownCircuitBreaker) — 组合熔断
 *   4. /api/risk/per-stock-stop-loss     (US-051 PerStockStopLossGuard) — 单股止损
 *   5. /api/risk/industry-concentration  (US-052 IndustryConcentrationGuard) — 行业集中
 *   6. /api/risk/market-regime           (US-050 / US-132 PR-017 MarketRegimeAlertService) — 市场环境
 *   7. /api/risk/black-swan              (US-053 BlackSwanWatchdog) — 黑天鹅监控
 *   8. /api/risk/morning-checkup         (US-054 MorningRiskCheckupService) — 开盘前体检
 *   9. /api/risk/reconciliation-alert    (US-137 EX-012 ReconciliationAlertService) — 对账告警
 *
 * US-135 [PR-020] 在 US-066 5 endpoint 基础上 +3 (market-regime / black-swan / morning-checkup),
 * 让"风控阈值散落 3 个隐藏 tab"问题彻底消除 — 操盘手一处编辑全部. 沿用 US-066 既有
 * "多 section 聚合" 模板 (SectionState<T> / loadAll Promise.allSettled / 独立 Save), 复用
 * 0 改动. 新 section UI 选 antd Select 编辑 boolean enable_* 比 InputNumber 直观.
 *
 * 行为契约 (与 backend lenient normalize 对齐):
 *   - PUT body 字段全 lenient — 非法值被 normalizeXxxConfig 静默退到 default,
 *     UI 不做前端 strict 校验, 只用 InputNumber min/max 提示 (不强阻)。
 *   - GET 返 normalized config (含 default 兜底), 加载到 view + draft 双状态。
 *   - hasChanges 按 section 独立判断 — 用户改 trailing_stop 只 Enable 该 section
 *     的 Save, 不要求一次保存所有 5 个 section。
 *
 * 设计模式 (沿用 PortfolioConstructionTab / AnalysisEngineTab "draft/view 双状态"):
 *   - section 内 draft state, 保存后用 server normalize 值同时回灌 view+draft,
 *     防 lenient normalize 让 hasChanges 永真 (US-065 lesson 同款).
 *   - Promise.allSettled 并行拉 5 个 endpoint, **某一路失败仅本 section 内 Alert
 *     降级**, 不阻塞其它 section (与 backend Alert UI fail-OPEN 同思想).
 *   - 每个 section 独立 Card + 独立 Save 按钮 + 独立 loading/saving state, 让
 *     失败/慢的 endpoint 不拖累其它 section 的可用性。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Row,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  QuestionCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  SafetyOutlined,
  AlertOutlined,
  FundOutlined,
  StopOutlined,
  ApartmentOutlined,
  GlobalOutlined,
  ThunderboltOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import api from '../../services/api';

const { Text, Paragraph } = Typography;

// ---------------------------------------------------------------------------
//  Section config types (与 backend interface 字段名一一对应)
// ---------------------------------------------------------------------------

interface PositionLimitsConfig {
  max_positions: number;
  max_single_stock_pct: number;
  max_single_industry_pct: number;
}

interface TrailingStopConfig {
  enabled: boolean;
  pct: number;
}

interface DrawdownBreakerConfig {
  enabled: boolean;
  level1_pct: number;
  level2_pct: number;
  level3_pct: number;
  level1_pause_ms: number;
}

interface PerStockStopLossConfig {
  enabled: boolean;
  pct: number;
  mass_threshold_ratio: number;
}

interface IndustryConcentrationConfig {
  enabled: boolean;
  alert_pct: number;
  rebalance_target_pct: number;
  rebalance_max_sell_count: number;
}

/** US-050 / US-132 [PR-017] — MarketRegimeAlertService.MarketRegimeAlertConfig 对齐. */
interface MarketRegimeAlertConfig {
  enabled: boolean;
  benchmark_symbol: string;
  drop_3d_pct: number;
  drop_20d_pct: number;
  enable_death_cross: boolean;
  reduce_position_pct: number;
  /** US-132 PR-017 — 连续 N 日跌停股 > 阈值触发 CRITICAL "全市场暂停建仓". */
  enable_halt_buy_on_panic: boolean;
  halt_buy_limit_down_count_threshold: number;
  halt_buy_consecutive_days: number;
}

/** US-053 — BlackSwanWatchdog.BlackSwanConfig 对齐. */
interface BlackSwanWatchdogConfig {
  enabled: boolean;
  scan_st: boolean;
  scan_suspended: boolean;
  scan_news: boolean;
  news_keywords: readonly string[];
  news_lookback_hours: number;
  news_per_stock_limit: number;
  scan_shareholder_reduction: boolean;
  shareholder_reduction_lookback_days: number;
  shareholder_reduction_amount_threshold: number;
  shareholder_reduction_pct_threshold: number;
  dedupe_enabled: boolean;
}

/** US-054 — MorningRiskCheckupService.MorningRiskCheckupConfig 对齐. */
interface MorningRiskCheckupConfig {
  enabled: boolean;
  weekly_lookback_days: number;
  drawdown_lookback_days: number;
  include_breakdown_in_message: boolean;
}

/** US-137 [EX-012] — ReconciliationAlertService.ReconciliationAlertConfig 对齐. */
interface ReconciliationAlertConfig {
  enabled: boolean;
  alignment_score_high_threshold: number;
  alignment_score_medium_threshold: number;
  drift_count_high_threshold: number;
  drift_count_medium_threshold: number;
  dedupe_window_minutes: number;
}

// ---------------------------------------------------------------------------
//  Generic section state — 5 个 section 共用同款 view/draft/loading/saving/error
// ---------------------------------------------------------------------------

interface SectionState<T> {
  view: T | null;
  draft: T | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

function initialSectionState<T>(): SectionState<T> {
  return { view: null, draft: null, loading: false, saving: false, error: null };
}

const hasSectionChanges = <T,>(s: SectionState<T>): boolean => {
  if (!s.view || !s.draft) return false;
  return JSON.stringify(s.draft) !== JSON.stringify(s.view);
};

const RiskParametersCenterTab: React.FC = () => {
  // 5 section state
  const [pl, setPl] = useState<SectionState<PositionLimitsConfig>>(() =>
    initialSectionState<PositionLimitsConfig>()
  );
  const [ts, setTs] = useState<SectionState<TrailingStopConfig>>(() =>
    initialSectionState<TrailingStopConfig>()
  );
  const [db, setDb] = useState<SectionState<DrawdownBreakerConfig>>(() =>
    initialSectionState<DrawdownBreakerConfig>()
  );
  const [psl, setPsl] = useState<SectionState<PerStockStopLossConfig>>(() =>
    initialSectionState<PerStockStopLossConfig>()
  );
  const [ic, setIc] = useState<SectionState<IndustryConcentrationConfig>>(() =>
    initialSectionState<IndustryConcentrationConfig>()
  );
  // US-135 [PR-020] +3 section
  const [mr, setMr] = useState<SectionState<MarketRegimeAlertConfig>>(() =>
    initialSectionState<MarketRegimeAlertConfig>()
  );
  const [bs, setBs] = useState<SectionState<BlackSwanWatchdogConfig>>(() =>
    initialSectionState<BlackSwanWatchdogConfig>()
  );
  const [mc, setMc] = useState<SectionState<MorningRiskCheckupConfig>>(() =>
    initialSectionState<MorningRiskCheckupConfig>()
  );
  // US-137 [EX-012] ReconciliationAlert 阈值持久化 — 第 9 个 section
  const [ra, setRa] = useState<SectionState<ReconciliationAlertConfig>>(() =>
    initialSectionState<ReconciliationAlertConfig>()
  );

  // ---- generic per-section load helper (sets loading/error/view/draft) ----
  // 不在 setLoading 里 setView/setDraft 避免 React 18 batching 边界问题,
  // 单 section 一个 updater + 单 setState (与 PortfolioConstructionTab 同款)
  const loadSection = useCallback(
    async <T,>(
      path: string,
      setter: React.Dispatch<React.SetStateAction<SectionState<T>>>
    ): Promise<void> => {
      setter(prev => ({ ...prev, loading: true, error: null }));
      try {
        const resp = await api.get(path);
        const data: T = resp.data?.data;
        setter(prev => ({ ...prev, view: data, draft: data, loading: false }));
      } catch (err: any) {
        const msg = err?.response?.data?.message || err?.message || String(err);
        setter(prev => ({ ...prev, error: msg, loading: false }));
      }
    },
    []
  );

  /** 并行拉 8 个 endpoint — 某一路失败仅 set 自己的 error, 其它 section 照常 */
  const loadAll = useCallback(async (): Promise<void> => {
    await Promise.allSettled([
      loadSection<PositionLimitsConfig>('/risk/position-limits', setPl),
      loadSection<TrailingStopConfig>('/risk/trailing-stop', setTs),
      loadSection<DrawdownBreakerConfig>('/risk/drawdown-breaker', setDb),
      loadSection<PerStockStopLossConfig>('/risk/per-stock-stop-loss', setPsl),
      loadSection<IndustryConcentrationConfig>('/risk/industry-concentration', setIc),
      loadSection<MarketRegimeAlertConfig>('/risk/market-regime', setMr),
      loadSection<BlackSwanWatchdogConfig>('/risk/black-swan', setBs),
      loadSection<MorningRiskCheckupConfig>('/risk/morning-checkup', setMc),
      loadSection<ReconciliationAlertConfig>('/risk/reconciliation-alert', setRa),
    ]);
  }, [loadSection]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  /** 通用 save helper — 保存后用 server normalize 后值同时回灌 view+draft */
  const saveSection = useCallback(
    async <T,>(
      path: string,
      draft: T | null,
      setter: React.Dispatch<React.SetStateAction<SectionState<T>>>,
      label: string
    ): Promise<void> => {
      if (!draft) return;
      setter(prev => ({ ...prev, saving: true }));
      try {
        const resp = await api.put(path, draft);
        const normalized: T = resp.data?.data;
        // server 已 normalize → 同时回灌 view + draft, 防 hasChanges 永真
        setter(prev => ({ ...prev, view: normalized, draft: normalized, saving: false }));
        message.success(resp.data?.message || `${label}已保存`);
      } catch (err: any) {
        const msg = err?.response?.data?.message || err?.message || `${label}保存失败`;
        message.error(msg);
        setter(prev => ({ ...prev, saving: false }));
      }
    },
    []
  );

  // ---- 派生 hasChanges (8 个独立) -----------------------------------------
  const plHasChanges = useMemo(() => hasSectionChanges(pl), [pl]);
  const tsHasChanges = useMemo(() => hasSectionChanges(ts), [ts]);
  const dbHasChanges = useMemo(() => hasSectionChanges(db), [db]);
  const pslHasChanges = useMemo(() => hasSectionChanges(psl), [psl]);
  const icHasChanges = useMemo(() => hasSectionChanges(ic), [ic]);
  const mrHasChanges = useMemo(() => hasSectionChanges(mr), [mr]);
  const bsHasChanges = useMemo(() => hasSectionChanges(bs), [bs]);
  const mcHasChanges = useMemo(() => hasSectionChanges(mc), [mc]);
  const raHasChanges = useMemo(() => hasSectionChanges(ra), [ra]);

  /**
   * 顶层 KPI bar — 一眼看出"还有几项未保存的改动" + "整体风控启用率",
   * 让用户在多 section 编辑后不至于忘按某个 Save (US-080 KPI bar 同思想)。
   */
  const totalUnsavedSections = [
    plHasChanges,
    tsHasChanges,
    dbHasChanges,
    pslHasChanges,
    icHasChanges,
    mrHasChanges,
    bsHasChanges,
    mcHasChanges,
    raHasChanges,
  ].filter(Boolean).length;
  const enabledGuards = [
    ts.view?.enabled,
    db.view?.enabled,
    psl.view?.enabled,
    ic.view?.enabled,
    mr.view?.enabled,
    bs.view?.enabled,
    mc.view?.enabled,
    ra.view?.enabled,
  ].filter(v => v === true).length;
  // position_limits 永远 enabled (没有 enabled 字段) — 算进总数
  const totalGuards = 9;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="风控参数中心"
        description={
          <div>
            <Paragraph style={{ marginBottom: 4 }}>
              合并所有 pre-trade / 持仓监控 / 组合熔断 类风控阈值到同一面板, 每个 section 独立保存。
              修改后 <strong>下一次 guard cron / pre-trade 检查时生效</strong>。
            </Paragraph>
            <Space size="small" wrap>
              <Tag color={totalUnsavedSections > 0 ? 'warning' : 'success'}>
                {totalUnsavedSections > 0
                  ? `有 ${totalUnsavedSections} 个 section 待保存`
                  : '所有 section 已同步'}
              </Tag>
              <Tag color="processing">
                启用 guard: {enabledGuards + 1}/{totalGuards} (position_limits 默认启用)
              </Tag>
              <Tag color="purple">US-066 风控参数中心</Tag>
              <Tag color="cyan">US-135 PR-020 全 8 维度</Tag>
              <Tag color="magenta">US-137 EX-012 对账阈值</Tag>
            </Space>
          </div>
        }
      />

      {/* Section 1: 仓位限制 (US-047) */}
      <Card
        size="small"
        variant="borderless"
        className="modern-card"
        title={
          <Space>
            <SafetyOutlined />
            <span style={{ fontWeight: 600 }}>仓位限制 (Position Limits)</span>
            {plHasChanges && <Tag color="warning">未保存</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={pl.loading}
              onClick={() => void loadSection<PositionLimitsConfig>('/risk/position-limits', setPl)}
            >
              刷新
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<SaveOutlined />}
              loading={pl.saving}
              disabled={!plHasChanges}
              onClick={() =>
                void saveSection<PositionLimitsConfig>(
                  '/risk/position-limits',
                  pl.draft,
                  setPl,
                  '仓位限制'
                )
              }
            >
              保存
            </Button>
          </Space>
        }
      >
        {pl.error && (
          <Alert type="error" message={pl.error} showIcon style={{ marginBottom: 12 }} />
        )}
        {!pl.draft ? (
          pl.loading ? (
            <Alert type="info" message="加载中..." />
          ) : (
            <Empty description="未加载到仓位限制配置" />
          )
        ) : (
          <Form layout="vertical">
            <Row gutter={[16, 8]}>
              <Col xs={24} md={8}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>最大持仓数 (max_positions)</span>
                      <Tooltip title="同时持有的最大不同股票数。新开仓 BUY 会被阻断">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={1}
                    max={100}
                    value={pl.draft.max_positions}
                    onChange={v =>
                      setPl(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: { ...prev.draft, max_positions: Number(v ?? 20) },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="只"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>单股仓位上限</span>
                      <Tooltip title="(0-1) 单只票最大占总资产比例, e.g. 0.10 = 10%">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0.01}
                    max={1}
                    step={0.01}
                    value={pl.draft.max_single_stock_pct}
                    onChange={v =>
                      setPl(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: { ...prev.draft, max_single_stock_pct: Number(v ?? 0.1) },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="比例 (0-1)"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>单行业仓位上限</span>
                      <Tooltip title="(0-1) 单一行业最大占总资产比例, e.g. 0.30 = 30%">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={pl.draft.max_single_industry_pct}
                    onChange={v =>
                      setPl(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                max_single_industry_pct: Number(v ?? 0.3),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="比例 (0-1)"
                  />
                </Form.Item>
              </Col>
            </Row>
            <Text type="secondary" style={{ fontSize: 12 }}>
              backend: <code>PositionLimitGuard.evaluate</code> 在 PreTradeGate 调用 — 阻断 BUY。
            </Text>
          </Form>
        )}
      </Card>

      {/* Section 2: 追踪止损 (US-048) */}
      <Card
        size="small"
        variant="borderless"
        className="modern-card"
        title={
          <Space>
            <StopOutlined />
            <span style={{ fontWeight: 600 }}>追踪止损 (Trailing Stop)</span>
            {tsHasChanges && <Tag color="warning">未保存</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={ts.loading}
              onClick={() => void loadSection<TrailingStopConfig>('/risk/trailing-stop', setTs)}
            >
              刷新
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<SaveOutlined />}
              loading={ts.saving}
              disabled={!tsHasChanges}
              onClick={() =>
                void saveSection<TrailingStopConfig>(
                  '/risk/trailing-stop',
                  ts.draft,
                  setTs,
                  '追踪止损'
                )
              }
            >
              保存
            </Button>
          </Space>
        }
      >
        {ts.error && (
          <Alert type="error" message={ts.error} showIcon style={{ marginBottom: 12 }} />
        )}
        {!ts.draft ? (
          ts.loading ? (
            <Alert type="info" message="加载中..." />
          ) : (
            <Empty description="未加载到追踪止损配置" />
          )
        ) : (
          <Form layout="vertical">
            <Row gutter={[16, 8]}>
              <Col xs={24} md={8}>
                <Form.Item label="启用">
                  <Switch
                    checked={ts.draft.enabled}
                    onChange={v =>
                      setTs(prev =>
                        prev.draft ? { ...prev, draft: { ...prev.draft, enabled: v } } : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={16}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>回撤触发比例 (pct)</span>
                      <Tooltip title="(0-1) 高位回撤多少触发止损卖出, e.g. 0.10 = 10%">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0.01}
                    max={1}
                    step={0.01}
                    value={ts.draft.pct}
                    disabled={!ts.draft.enabled}
                    onChange={v =>
                      setTs(prev =>
                        prev.draft
                          ? { ...prev, draft: { ...prev.draft, pct: Number(v ?? 0.1) } }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="比例 (0-1)"
                  />
                </Form.Item>
              </Col>
            </Row>
            <Text type="secondary" style={{ fontSize: 12 }}>
              backend: <code>TrailingStopGuard</code> 每日盘后 cron 维护 highest_price + 触发卖出。
            </Text>
          </Form>
        )}
      </Card>

      {/* Section 3: 组合回撤熔断 (US-049) */}
      <Card
        size="small"
        variant="borderless"
        className="modern-card"
        title={
          <Space>
            <FundOutlined />
            <span style={{ fontWeight: 600 }}>组合回撤熔断 (Drawdown Circuit Breaker)</span>
            {dbHasChanges && <Tag color="warning">未保存</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={db.loading}
              onClick={() =>
                void loadSection<DrawdownBreakerConfig>('/risk/drawdown-breaker', setDb)
              }
            >
              刷新
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<SaveOutlined />}
              loading={db.saving}
              disabled={!dbHasChanges}
              onClick={() =>
                void saveSection<DrawdownBreakerConfig>(
                  '/risk/drawdown-breaker',
                  db.draft,
                  setDb,
                  '组合回撤熔断'
                )
              }
            >
              保存
            </Button>
          </Space>
        }
      >
        {db.error && (
          <Alert type="error" message={db.error} showIcon style={{ marginBottom: 12 }} />
        )}
        {!db.draft ? (
          db.loading ? (
            <Alert type="info" message="加载中..." />
          ) : (
            <Empty description="未加载到组合回撤熔断配置" />
          )
        ) : (
          <Form layout="vertical">
            <Row gutter={[16, 8]}>
              <Col xs={24} md={6}>
                <Form.Item label="启用">
                  <Switch
                    checked={db.draft.enabled}
                    onChange={v =>
                      setDb(prev =>
                        prev.draft ? { ...prev, draft: { ...prev.draft, enabled: v } } : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>LEVEL_1 (暂停 24h)</span>
                      <Tooltip title="(0-1) 触发后暂停新开仓 level1_pause_ms, e.g. 0.10 = 10%">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0.01}
                    max={1}
                    step={0.01}
                    value={db.draft.level1_pct}
                    disabled={!db.draft.enabled}
                    onChange={v =>
                      setDb(prev =>
                        prev.draft
                          ? { ...prev, draft: { ...prev.draft, level1_pct: Number(v ?? 0.1) } }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="比例"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>LEVEL_2 (减仓 50%)</span>
                      <Tooltip title="(0-1) 触发后减仓至 50%, e.g. 0.15 = 15%">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0.01}
                    max={1}
                    step={0.01}
                    value={db.draft.level2_pct}
                    disabled={!db.draft.enabled}
                    onChange={v =>
                      setDb(prev =>
                        prev.draft
                          ? { ...prev, draft: { ...prev.draft, level2_pct: Number(v ?? 0.15) } }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="比例"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>LEVEL_3 (清仓)</span>
                      <Tooltip title="(0-1) 触发后全部清仓, e.g. 0.20 = 20%">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0.01}
                    max={1}
                    step={0.01}
                    value={db.draft.level3_pct}
                    disabled={!db.draft.enabled}
                    onChange={v =>
                      setDb(prev =>
                        prev.draft
                          ? { ...prev, draft: { ...prev.draft, level3_pct: Number(v ?? 0.2) } }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="比例"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>LEVEL_1 暂停时长 (level1_pause_ms)</span>
                      <Tooltip title="毫秒, 默认 86400000 = 24h. 触发 LEVEL_1 后这段时间内不能新开仓">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={60_000}
                    step={3_600_000}
                    value={db.draft.level1_pause_ms}
                    disabled={!db.draft.enabled}
                    onChange={v =>
                      setDb(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: { ...prev.draft, level1_pause_ms: Number(v ?? 86_400_000) },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="毫秒"
                  />
                </Form.Item>
              </Col>
            </Row>
            <Text type="secondary" style={{ fontSize: 12 }}>
              backend: <code>DrawdownCircuitBreaker</code> + LEVEL_1 paused_until 写入 risk_config
              让下一次 BUY 检查能看到。
            </Text>
          </Form>
        )}
      </Card>

      {/* Section 4: 每股止损 (US-051) */}
      <Card
        size="small"
        variant="borderless"
        className="modern-card"
        title={
          <Space>
            <AlertOutlined />
            <span style={{ fontWeight: 600 }}>每股止损 (Per-Stock Stop Loss)</span>
            {pslHasChanges && <Tag color="warning">未保存</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={psl.loading}
              onClick={() =>
                void loadSection<PerStockStopLossConfig>('/risk/per-stock-stop-loss', setPsl)
              }
            >
              刷新
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<SaveOutlined />}
              loading={psl.saving}
              disabled={!pslHasChanges}
              onClick={() =>
                void saveSection<PerStockStopLossConfig>(
                  '/risk/per-stock-stop-loss',
                  psl.draft,
                  setPsl,
                  '每股止损'
                )
              }
            >
              保存
            </Button>
          </Space>
        }
      >
        {psl.error && (
          <Alert type="error" message={psl.error} showIcon style={{ marginBottom: 12 }} />
        )}
        {!psl.draft ? (
          psl.loading ? (
            <Alert type="info" message="加载中..." />
          ) : (
            <Empty description="未加载到每股止损配置" />
          )
        ) : (
          <Form layout="vertical">
            <Row gutter={[16, 8]}>
              <Col xs={24} md={6}>
                <Form.Item label="启用">
                  <Switch
                    checked={psl.draft.enabled}
                    onChange={v =>
                      setPsl(prev =>
                        prev.draft ? { ...prev, draft: { ...prev.draft, enabled: v } } : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={9}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>止损阈值 (pct)</span>
                      <Tooltip title="(0-1) 亏损多少触发止损, e.g. 0.07 = 7%">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0.01}
                    max={1}
                    step={0.01}
                    value={psl.draft.pct}
                    disabled={!psl.draft.enabled}
                    onChange={v =>
                      setPsl(prev =>
                        prev.draft
                          ? { ...prev, draft: { ...prev.draft, pct: Number(v ?? 0.07) } }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="比例"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={9}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>Mass 触发比例 (mass_threshold_ratio)</span>
                      <Tooltip title="(0-1) 多少比例持仓同时触发 → 升级到组合级 LEVEL_2 告警, e.g. 0.5 = 50%">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0}
                    max={1}
                    step={0.05}
                    value={psl.draft.mass_threshold_ratio}
                    disabled={!psl.draft.enabled}
                    onChange={v =>
                      setPsl(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                mass_threshold_ratio: Number(v ?? 0.5),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="比例"
                  />
                </Form.Item>
              </Col>
            </Row>
            <Text type="secondary" style={{ fontSize: 12 }}>
              backend: <code>PerStockStopLossGuard</code> 每日盘后 cron — 单股触发卖出 +
              过半同时触发升组合级告警。
            </Text>
          </Form>
        )}
      </Card>

      {/* Section 5: 行业集中度 (US-052) */}
      <Card
        size="small"
        variant="borderless"
        className="modern-card"
        title={
          <Space>
            <ApartmentOutlined />
            <span style={{ fontWeight: 600 }}>行业集中度 (Industry Concentration)</span>
            {icHasChanges && <Tag color="warning">未保存</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={ic.loading}
              onClick={() =>
                void loadSection<IndustryConcentrationConfig>('/risk/industry-concentration', setIc)
              }
            >
              刷新
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<SaveOutlined />}
              loading={ic.saving}
              disabled={!icHasChanges}
              onClick={() =>
                void saveSection<IndustryConcentrationConfig>(
                  '/risk/industry-concentration',
                  ic.draft,
                  setIc,
                  '行业集中度'
                )
              }
            >
              保存
            </Button>
          </Space>
        }
      >
        {ic.error && (
          <Alert type="error" message={ic.error} showIcon style={{ marginBottom: 12 }} />
        )}
        {!ic.draft ? (
          ic.loading ? (
            <Alert type="info" message="加载中..." />
          ) : (
            <Empty description="未加载到行业集中度配置" />
          )
        ) : (
          <Form layout="vertical">
            <Row gutter={[16, 8]}>
              <Col xs={24} md={6}>
                <Form.Item label="启用">
                  <Switch
                    checked={ic.draft.enabled}
                    onChange={v =>
                      setIc(prev =>
                        prev.draft ? { ...prev, draft: { ...prev.draft, enabled: v } } : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>告警阈值 (alert_pct)</span>
                      <Tooltip title="(0-1) 单一行业占总资产超过此比例触发告警, e.g. 0.35 = 35%">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={ic.draft.alert_pct}
                    disabled={!ic.draft.enabled}
                    onChange={v =>
                      setIc(prev =>
                        prev.draft
                          ? { ...prev, draft: { ...prev.draft, alert_pct: Number(v ?? 0.35) } }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="比例"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>再平衡目标 (rebalance_target_pct)</span>
                      <Tooltip title="(0-1) 一键再平衡时把行业占比调到此值, e.g. 0.30 = 30%">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={ic.draft.rebalance_target_pct}
                    disabled={!ic.draft.enabled}
                    onChange={v =>
                      setIc(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                rebalance_target_pct: Number(v ?? 0.3),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="比例"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>最多卖出 (max_sell_count)</span>
                      <Tooltip title="一键再平衡最多卖出几只 (AC 指定 1-2 只)">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={1}
                    max={10}
                    value={ic.draft.rebalance_max_sell_count}
                    disabled={!ic.draft.enabled}
                    onChange={v =>
                      setIc(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                rebalance_max_sell_count: Number(v ?? 2),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="只"
                  />
                </Form.Item>
              </Col>
            </Row>
            <Text type="secondary" style={{ fontSize: 12 }}>
              backend: <code>IndustryConcentrationGuard</code> 告警阈值触发后 UI
              一键再平衡至目标占比。
            </Text>
          </Form>
        )}
      </Card>

      {/* Section 6: 市场环境预警 (US-050 / US-132 PR-017) — US-135 新增 */}
      <Card
        size="small"
        variant="borderless"
        className="modern-card"
        title={
          <Space>
            <GlobalOutlined />
            <span style={{ fontWeight: 600 }}>市场环境预警 (Market Regime Alert)</span>
            {mrHasChanges && <Tag color="warning">未保存</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={mr.loading}
              onClick={() =>
                void loadSection<MarketRegimeAlertConfig>('/risk/market-regime', setMr)
              }
            >
              刷新
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<SaveOutlined />}
              loading={mr.saving}
              disabled={!mrHasChanges}
              onClick={() =>
                void saveSection<MarketRegimeAlertConfig>(
                  '/risk/market-regime',
                  mr.draft,
                  setMr,
                  '市场环境预警'
                )
              }
            >
              保存
            </Button>
          </Space>
        }
      >
        {mr.error && (
          <Alert type="error" message={mr.error} showIcon style={{ marginBottom: 12 }} />
        )}
        {!mr.draft ? (
          mr.loading ? (
            <Alert type="info" message="加载中..." />
          ) : (
            <Empty description="未加载到市场环境预警配置" />
          )
        ) : (
          <Form layout="vertical">
            <Row gutter={[16, 8]}>
              <Col xs={12} md={4}>
                <Form.Item label="启用">
                  <Switch
                    checked={mr.draft.enabled}
                    onChange={v =>
                      setMr(prev =>
                        prev.draft ? { ...prev, draft: { ...prev.draft, enabled: v } } : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>基准指数</span>
                      <Tooltip title="benchmark_symbol, e.g. sh.000001 (上证) / sh.000300 (沪深300)">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <Input
                    value={mr.draft.benchmark_symbol}
                    disabled={!mr.draft.enabled}
                    onChange={e =>
                      setMr(prev =>
                        prev.draft
                          ? { ...prev, draft: { ...prev.draft, benchmark_symbol: e.target.value } }
                          : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={7}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>3 日跌幅 → MEDIUM</span>
                      <Tooltip title="(0-1) 3 日累计跌幅触发 MEDIUM 告警, e.g. 0.05 = 5%">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0.01}
                    max={1}
                    step={0.01}
                    value={mr.draft.drop_3d_pct}
                    disabled={!mr.draft.enabled}
                    onChange={v =>
                      setMr(prev =>
                        prev.draft
                          ? { ...prev, draft: { ...prev.draft, drop_3d_pct: Number(v ?? 0.05) } }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="比例"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={7}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>20 日跌幅 → HIGH</span>
                      <Tooltip title="(0-1) 20 日累计跌幅触发 HIGH 告警, e.g. 0.15 = 15%">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0.01}
                    max={1}
                    step={0.01}
                    value={mr.draft.drop_20d_pct}
                    disabled={!mr.draft.enabled}
                    onChange={v =>
                      setMr(prev =>
                        prev.draft
                          ? { ...prev, draft: { ...prev.draft, drop_20d_pct: Number(v ?? 0.15) } }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="比例"
                  />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={[16, 8]}>
              <Col xs={12} md={6}>
                <Form.Item label="MA20/MA60 死叉 → MEDIUM">
                  <Switch
                    checked={mr.draft.enable_death_cross}
                    disabled={!mr.draft.enabled}
                    onChange={v =>
                      setMr(prev =>
                        prev.draft
                          ? { ...prev, draft: { ...prev.draft, enable_death_cross: v } }
                          : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>建议降仓比例</span>
                      <Tooltip title="(0-1) 触发后建议降仓比例, 仅写 message 不强制下单">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={mr.draft.reduce_position_pct}
                    disabled={!mr.draft.enabled}
                    onChange={v =>
                      setMr(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: { ...prev.draft, reduce_position_pct: Number(v ?? 0.3) },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="比例"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>跌停股 → CRITICAL</span>
                      <Tooltip title="US-132 PR-017: 启用 '连续 N 日跌停股 > 阈值 → 全市场暂停建仓' CRITICAL 信号">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <Switch
                    checked={mr.draft.enable_halt_buy_on_panic}
                    disabled={!mr.draft.enabled}
                    onChange={v =>
                      setMr(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: { ...prev.draft, enable_halt_buy_on_panic: v },
                            }
                          : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={3}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>跌停股数</span>
                      <Tooltip title="每日跌停股 > N 算 '恐慌日', 默认 100">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={1}
                    max={5000}
                    value={mr.draft.halt_buy_limit_down_count_threshold}
                    disabled={!mr.draft.enabled || !mr.draft.enable_halt_buy_on_panic}
                    onChange={v =>
                      setMr(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                halt_buy_limit_down_count_threshold: Number(v ?? 100),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="只"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={3}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>连续日数</span>
                      <Tooltip title="连续 ≥ N 日 '恐慌日' 触发, 默认 3">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={1}
                    max={30}
                    value={mr.draft.halt_buy_consecutive_days}
                    disabled={!mr.draft.enabled || !mr.draft.enable_halt_buy_on_panic}
                    onChange={v =>
                      setMr(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                halt_buy_consecutive_days: Number(v ?? 3),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="日"
                  />
                </Form.Item>
              </Col>
            </Row>
            <Text type="secondary" style={{ fontSize: 12 }}>
              backend: <code>MarketRegimeAlertService</code> 每日盘前 cron — 4 类信号 (3d 跌幅 / 20d
              跌幅 / 死叉 / 连续跌停股恐慌) 分级告警。
            </Text>
          </Form>
        )}
      </Card>

      {/* Section 7: 黑天鹅监控 (US-053) — US-135 新增 */}
      <Card
        size="small"
        variant="borderless"
        className="modern-card"
        title={
          <Space>
            <ThunderboltOutlined />
            <span style={{ fontWeight: 600 }}>黑天鹅监控 (Black Swan Watchdog)</span>
            {bsHasChanges && <Tag color="warning">未保存</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={bs.loading}
              onClick={() => void loadSection<BlackSwanWatchdogConfig>('/risk/black-swan', setBs)}
            >
              刷新
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<SaveOutlined />}
              loading={bs.saving}
              disabled={!bsHasChanges}
              onClick={() =>
                void saveSection<BlackSwanWatchdogConfig>(
                  '/risk/black-swan',
                  bs.draft,
                  setBs,
                  '黑天鹅监控'
                )
              }
            >
              保存
            </Button>
          </Space>
        }
      >
        {bs.error && (
          <Alert type="error" message={bs.error} showIcon style={{ marginBottom: 12 }} />
        )}
        {!bs.draft ? (
          bs.loading ? (
            <Alert type="info" message="加载中..." />
          ) : (
            <Empty description="未加载到黑天鹅监控配置" />
          )
        ) : (
          <Form layout="vertical">
            <Row gutter={[16, 8]}>
              <Col xs={12} md={4}>
                <Form.Item label="启用">
                  <Switch
                    checked={bs.draft.enabled}
                    onChange={v =>
                      setBs(prev =>
                        prev.draft ? { ...prev, draft: { ...prev.draft, enabled: v } } : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={4}>
                <Form.Item label="扫 ST / *ST">
                  <Switch
                    checked={bs.draft.scan_st}
                    disabled={!bs.draft.enabled}
                    onChange={v =>
                      setBs(prev =>
                        prev.draft ? { ...prev, draft: { ...prev.draft, scan_st: v } } : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={4}>
                <Form.Item label="扫停牌">
                  <Switch
                    checked={bs.draft.scan_suspended}
                    disabled={!bs.draft.enabled}
                    onChange={v =>
                      setBs(prev =>
                        prev.draft ? { ...prev, draft: { ...prev.draft, scan_suspended: v } } : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={4}>
                <Form.Item label="扫利空新闻">
                  <Switch
                    checked={bs.draft.scan_news}
                    disabled={!bs.draft.enabled}
                    onChange={v =>
                      setBs(prev =>
                        prev.draft ? { ...prev, draft: { ...prev.draft, scan_news: v } } : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={4}>
                <Form.Item label="扫股东减持">
                  <Switch
                    checked={bs.draft.scan_shareholder_reduction}
                    disabled={!bs.draft.enabled}
                    onChange={v =>
                      setBs(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: { ...prev.draft, scan_shareholder_reduction: v },
                            }
                          : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={4}>
                <Form.Item label="去重">
                  <Switch
                    checked={bs.draft.dedupe_enabled}
                    disabled={!bs.draft.enabled}
                    onChange={v =>
                      setBs(prev =>
                        prev.draft ? { ...prev, draft: { ...prev.draft, dedupe_enabled: v } } : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={[16, 8]}>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>新闻回看窗口</span>
                      <Tooltip title="news_lookback_hours, 默认 24h">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={1}
                    max={168}
                    value={bs.draft.news_lookback_hours}
                    disabled={!bs.draft.enabled || !bs.draft.scan_news}
                    onChange={v =>
                      setBs(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                news_lookback_hours: Number(v ?? 24),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="小时"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>单股新闻 cap</span>
                      <Tooltip title="news_per_stock_limit, 默认 50">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={1}
                    max={500}
                    value={bs.draft.news_per_stock_limit}
                    disabled={!bs.draft.enabled || !bs.draft.scan_news}
                    onChange={v =>
                      setBs(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                news_per_stock_limit: Number(v ?? 50),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="条"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>减持回看 (天)</span>
                      <Tooltip title="shareholder_reduction_lookback_days, 默认 30">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={1}
                    max={365}
                    value={bs.draft.shareholder_reduction_lookback_days}
                    disabled={!bs.draft.enabled || !bs.draft.scan_shareholder_reduction}
                    onChange={v =>
                      setBs(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                shareholder_reduction_lookback_days: Number(v ?? 30),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="天"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>减持金额阈值</span>
                      <Tooltip title="shareholder_reduction_amount_threshold (元), 默认 1 亿">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={1_000_000}
                    max={10_000_000_000}
                    step={10_000_000}
                    value={bs.draft.shareholder_reduction_amount_threshold}
                    disabled={!bs.draft.enabled || !bs.draft.scan_shareholder_reduction}
                    onChange={v =>
                      setBs(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                shareholder_reduction_amount_threshold: Number(v ?? 100_000_000),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="元"
                  />
                </Form.Item>
              </Col>
            </Row>
            <Text type="secondary" style={{ fontSize: 12 }}>
              backend: <code>BlackSwanWatchdog</code> 每日盘后/盘中 cron — 5 维度 (ST / 停牌 /
              利空新闻 / 减持暴增 / dedup) 触发持仓预警。关键词列表在配置后端调, 此面板仅暴露开关 +
              数值阈值。
            </Text>
          </Form>
        )}
      </Card>

      {/* Section 8: 开盘前体检 (US-054) — US-135 新增 */}
      <Card
        size="small"
        variant="borderless"
        className="modern-card"
        title={
          <Space>
            <ClockCircleOutlined />
            <span style={{ fontWeight: 600 }}>开盘前体检 (Morning Risk Checkup)</span>
            {mcHasChanges && <Tag color="warning">未保存</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={mc.loading}
              onClick={() =>
                void loadSection<MorningRiskCheckupConfig>('/risk/morning-checkup', setMc)
              }
            >
              刷新
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<SaveOutlined />}
              loading={mc.saving}
              disabled={!mcHasChanges}
              onClick={() =>
                void saveSection<MorningRiskCheckupConfig>(
                  '/risk/morning-checkup',
                  mc.draft,
                  setMc,
                  '开盘前体检'
                )
              }
            >
              保存
            </Button>
          </Space>
        }
      >
        {mc.error && (
          <Alert type="error" message={mc.error} showIcon style={{ marginBottom: 12 }} />
        )}
        {!mc.draft ? (
          mc.loading ? (
            <Alert type="info" message="加载中..." />
          ) : (
            <Empty description="未加载到开盘前体检配置" />
          )
        ) : (
          <Form layout="vertical">
            <Row gutter={[16, 8]}>
              <Col xs={12} md={6}>
                <Form.Item label="启用">
                  <Switch
                    checked={mc.draft.enabled}
                    onChange={v =>
                      setMc(prev =>
                        prev.draft ? { ...prev, draft: { ...prev.draft, enabled: v } } : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>周净值回看 (天)</span>
                      <Tooltip title="weekly_lookback_days, 默认 7 (1 自然周)">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={1}
                    max={30}
                    value={mc.draft.weekly_lookback_days}
                    disabled={!mc.draft.enabled}
                    onChange={v =>
                      setMc(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: { ...prev.draft, weekly_lookback_days: Number(v ?? 7) },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="天"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>回撤回看 (天)</span>
                      <Tooltip title="drawdown_lookback_days, 默认 365 (1 年, 与 US-049 对齐)">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={30}
                    max={3650}
                    value={mc.draft.drawdown_lookback_days}
                    disabled={!mc.draft.enabled}
                    onChange={v =>
                      setMc(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                drawdown_lookback_days: Number(v ?? 365),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="天"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>消息含明细</span>
                      <Tooltip title="include_breakdown_in_message — Web UI 推荐 ON, 飞书/邮件简洁推 OFF">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <Switch
                    checked={mc.draft.include_breakdown_in_message}
                    disabled={!mc.draft.enabled}
                    onChange={v =>
                      setMc(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: { ...prev.draft, include_breakdown_in_message: v },
                            }
                          : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
            </Row>
            <Text type="secondary" style={{ fontSize: 12 }}>
              backend: <code>MorningRiskCheckupService</code> 每日开盘前 cron — 6 核心 metric (持仓
              / 单股 / 行业 / 回撤 / 周收益 / 未读告警) 渲染中文 message 推给飞书/邮件。
            </Text>
          </Form>
        )}
      </Card>

      {/* Section 9: 对账告警阈值 (US-137 [EX-012]) */}
      <Card
        size="small"
        variant="borderless"
        className="modern-card"
        title={
          <Space>
            <AlertOutlined />
            <span style={{ fontWeight: 600 }}>对账告警阈值 (Reconciliation Alert)</span>
            {raHasChanges && <Tag color="warning">未保存</Tag>}
          </Space>
        }
        extra={
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={ra.loading}
              onClick={() =>
                void loadSection<ReconciliationAlertConfig>('/risk/reconciliation-alert', setRa)
              }
            >
              刷新
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<SaveOutlined />}
              loading={ra.saving}
              disabled={!raHasChanges}
              onClick={() =>
                void saveSection<ReconciliationAlertConfig>(
                  '/risk/reconciliation-alert',
                  ra.draft,
                  setRa,
                  '对账告警阈值'
                )
              }
            >
              保存
            </Button>
          </Space>
        }
      >
        {ra.error && (
          <Alert type="error" message={ra.error} showIcon style={{ marginBottom: 12 }} />
        )}
        {!ra.draft ? (
          ra.loading ? (
            <Alert type="info" message="加载中..." />
          ) : (
            <Empty description="未加载到对账告警配置" />
          )
        ) : (
          <Form layout="vertical">
            <Row gutter={[16, 8]}>
              <Col xs={12} md={4}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>启用</span>
                      <Tooltip title="关闭后整 user 跳过对账告警 (不会写 RiskAlert)">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <Switch
                    checked={ra.draft.enabled}
                    onChange={v =>
                      setRa(prev =>
                        prev.draft ? { ...prev, draft: { ...prev.draft, enabled: v } } : prev
                      )
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={5}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>HIGH alignment_score 阈值</span>
                      <Tooltip title="alignment_score 严格小于此值 → HIGH 级告警. 默认 70 (即 < 70 触发 HIGH)">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0}
                    max={100}
                    step={1}
                    value={ra.draft.alignment_score_high_threshold}
                    disabled={!ra.draft.enabled}
                    onChange={v =>
                      setRa(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                alignment_score_high_threshold: Number(v ?? 70),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="< 触发 HIGH"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={5}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>MEDIUM alignment_score 阈值</span>
                      <Tooltip title="alignment_score 严格小于此值 → MEDIUM. 默认 85 (即 [HIGH阈值, 85) 触发 MEDIUM)">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0}
                    max={100}
                    step={1}
                    value={ra.draft.alignment_score_medium_threshold}
                    disabled={!ra.draft.enabled}
                    onChange={v =>
                      setRa(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                alignment_score_medium_threshold: Number(v ?? 85),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="< 触发 MEDIUM"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={5}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>HIGH 漂移仓位数阈值</span>
                      <Tooltip title="live_only + paper_only 严格大于此值 → HIGH. 默认 3 (即 ≥ 4 仓漂移触发 HIGH)">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0}
                    max={100}
                    step={1}
                    precision={0}
                    value={ra.draft.drift_count_high_threshold}
                    disabled={!ra.draft.enabled}
                    onChange={v =>
                      setRa(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                drift_count_high_threshold: Number(v ?? 3),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="> 触发 HIGH"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={5}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>MEDIUM 漂移仓位数阈值</span>
                      <Tooltip title="live_only + paper_only ≥ 此值 → MEDIUM. 默认 1 (即 1 仓漂移触发 MEDIUM)">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={0}
                    max={100}
                    step={1}
                    precision={0}
                    value={ra.draft.drift_count_medium_threshold}
                    disabled={!ra.draft.enabled}
                    onChange={v =>
                      setRa(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                drift_count_medium_threshold: Number(v ?? 1),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="≥ 触发 MEDIUM"
                  />
                </Form.Item>
              </Col>
              <Col xs={12} md={5}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>Dedup 窗口 (分钟)</span>
                      <Tooltip title="同 (symbols_hash, severity) signature 多久内不重复告警, 默认 30 min. 调仓后 symbols 变 → signature 变 → 重新告警">
                        <QuestionCircleOutlined style={{ color: 'var(--text-muted)' }} />
                      </Tooltip>
                    </Space>
                  }
                >
                  <InputNumber
                    min={1}
                    max={1440}
                    step={1}
                    precision={0}
                    value={ra.draft.dedupe_window_minutes}
                    disabled={!ra.draft.enabled}
                    onChange={v =>
                      setRa(prev =>
                        prev.draft
                          ? {
                              ...prev,
                              draft: {
                                ...prev.draft,
                                dedupe_window_minutes: Number(v ?? 30),
                              },
                            }
                          : prev
                      )
                    }
                    style={{ width: '100%' }}
                    addonAfter="分钟"
                  />
                </Form.Item>
              </Col>
            </Row>
            <Text type="secondary" style={{ fontSize: 12 }}>
              backend: <code>ReconciliationAlertService</code> 定时对账 live vs paper 仓位, 漂移触发
              RiskAlert (HIGH 写入即推飞书+邮件+SMS 三通道). 调高阈值降低噪声; 调低提升敏感度. 修改
              后下一次 runForUser 调用即生效 (无需重启 cron). MEDIUM &lt; HIGH 阈值时 backend 静默
              swap 防止 MEDIUM 永远先被 HIGH 决策覆盖.
            </Text>
          </Form>
        )}
      </Card>

      <Paragraph style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        所有配置存于 <code>User.risk_config.&lt;guard_name&gt;</code> JSONB。修改后{' '}
        <strong>下一次 guard cron / pre-trade 检查时生效</strong> (不影响当前已在 loop
        中的批次)。前端不做 strict 校验, 非法值被 backend normalizeXxxConfig 静默退到 default —
        不会污染 risk_config。
      </Paragraph>
    </Space>
  );
};

export default RiskParametersCenterTab;
