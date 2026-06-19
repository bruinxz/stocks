/**
 * SettingsWorkspace.RiskParametersCenterTab — US-066 / FE-027
 *
 * **风控参数中心** — 把 5 个 backend risk guard 的阈值合并到一个 tab,
 * 让用户在同一个面板内编辑所有"挡 BUY / 触发减仓 / 全清仓"类阈值,
 * 不用在多个隐藏入口之间跳。
 *
 * 接入的 5 个 backend endpoint (全部沿用 RiskController 既有 GET/PUT):
 *   1. /api/risk/position-limits         (US-047 PositionLimitGuard)
 *   2. /api/risk/trailing-stop           (US-048 TrailingStopGuard)
 *   3. /api/risk/drawdown-breaker        (US-049 DrawdownCircuitBreaker)
 *   4. /api/risk/per-stock-stop-loss     (US-051 PerStockStopLossGuard)
 *   5. /api/risk/industry-concentration  (US-052 IndustryConcentrationGuard)
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

  /** 并行拉 5 个 endpoint — 某一路失败仅 set 自己的 error, 其它 section 照常 */
  const loadAll = useCallback(async (): Promise<void> => {
    await Promise.allSettled([
      loadSection<PositionLimitsConfig>('/risk/position-limits', setPl),
      loadSection<TrailingStopConfig>('/risk/trailing-stop', setTs),
      loadSection<DrawdownBreakerConfig>('/risk/drawdown-breaker', setDb),
      loadSection<PerStockStopLossConfig>('/risk/per-stock-stop-loss', setPsl),
      loadSection<IndustryConcentrationConfig>('/risk/industry-concentration', setIc),
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

  // ---- 派生 hasChanges (5 个独立) -----------------------------------------
  const plHasChanges = useMemo(() => hasSectionChanges(pl), [pl]);
  const tsHasChanges = useMemo(() => hasSectionChanges(ts), [ts]);
  const dbHasChanges = useMemo(() => hasSectionChanges(db), [db]);
  const pslHasChanges = useMemo(() => hasSectionChanges(psl), [psl]);
  const icHasChanges = useMemo(() => hasSectionChanges(ic), [ic]);

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
  ].filter(Boolean).length;
  const enabledGuards = [
    ts.view?.enabled,
    db.view?.enabled,
    psl.view?.enabled,
    ic.view?.enabled,
  ].filter(v => v === true).length;
  // position_limits 永远 enabled (没有 enabled 字段) — 算进总数
  const totalGuards = 5;

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
