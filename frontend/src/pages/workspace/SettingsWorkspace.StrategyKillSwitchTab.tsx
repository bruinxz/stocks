/**
 * SettingsWorkspace.StrategyKillSwitchTab — US-069 [FE-030]
 *
 * **策略 kill-switch tab** — 让操盘手在一个面板里看到所有量化策略, 并 **单独**
 * disable / enable 任何一只. 每个 Switch toggle 立刻 PATCH 落库 (单字段,
 * 原子), 与批量保存形态的 [[push-channels-tab]] / [[analysis-engine-tab]]
 * 形成对照: 这里强调 "出事时一键拉闸", 多 cell 批量 diff 会让用户多点一次
 * 保存按钮, 是错配的 UX.
 *
 * 与既有 dry-run 切换 ([[setStrategyDryRun]]) 互补: 启用 dry-run 是 "策略
 * 还产信号, 但不下单"; 这里彻底 disable 是 "策略明天根本不扫描". 建议升级
 * 路径: 出问题先 dry-run 隔离观察 → 跑一段时间确认有问题 → 再走本 tab
 * 整体 kill.
 *
 * 数据流:
 *   1) GET /api/quant/strategies → listQuantStrategies() (复用 labService);
 *   2) PATCH /api/quant/strategies/:key {enabled: bool} → setStrategyEnabled();
 *   3) UI 用 [[strategyKillSwitchHelpers]] 把后端模型映射成 KillSwitchRowItem.
 *
 * Optimistic update 范式 — 切换瞬间在 client 端先 applyEnabledPatch 让 UI
 * 反应迅速; PATCH 成功用 server 返回的最新 row 覆盖; 失败 message.error +
 * 自动回滚回 prevEnabled. 这与 dry-run toggle 的 LabWorkspace 实现同款.
 *
 * 高风险策略 (risk_level=high) 禁用时 Modal.confirm 二次确认 — 复用
 * [[buildKillSwitchConfirmConfig]] 让"是否弹"的决策完全在 helper 里, 单测
 * 可以盖住. 启用任何策略 / 禁用 low/medium 不弹 (出事时拉闸要快).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ExclamationCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  SafetyOutlined,
} from '@ant-design/icons';
import {
  listQuantStrategies,
  setStrategyEnabled,
  type QuantStrategyItem,
} from '../../services/labService';
import {
  applyEnabledPatch,
  buildKillSwitchConfirmConfig,
  buildKillSwitchKpi,
  buildKillSwitchRows,
  type KillSwitchRowItem,
  type StrategyRiskLevel,
} from './strategyKillSwitchHelpers';

const { Text, Paragraph } = Typography;

/** risk_level → Tag tone (与 [[risk-level-color-map]] 跨 workspace 对齐). */
const RISK_TAG_COLOR: Record<StrategyRiskLevel, string> = {
  low: 'green',
  medium: 'gold',
  high: 'red',
};
const RISK_TAG_LABEL: Record<StrategyRiskLevel, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

const StrategyKillSwitchTab: React.FC = () => {
  const [rows, setRows] = useState<KillSwitchRowItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 正在切换的 strategy_key — 让该行 Switch 进入 loading 状态,
   * 同时禁用同一行其它操作避免重复 PATCH.
   */
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await listQuantStrategies();
      setRows(buildKillSwitchRows(items));
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 实际 PATCH 调用 — 单字段 enabled, optimistic UI, 失败回滚.
   * 不在这里直接弹确认 — 入口 handleToggle 已经决定好是否弹.
   */
  const doToggle = useCallback(
    async (row: KillSwitchRowItem, nextEnabled: boolean): Promise<void> => {
      const prev = row.enabled;
      setTogglingKey(row.strategy_key);
      // optimistic
      setRows(curr => applyEnabledPatch(curr, row.strategy_key, nextEnabled));
      try {
        const updated: QuantStrategyItem = await setStrategyEnabled(row.strategy_key, nextEnabled);
        // 用 server 返回的真值再 reconcile 一次 (理论上等于 nextEnabled, 但
        // 防止后端因为 dry-run / kill-switch monitor 拒绝改某些状态)
        setRows(curr => applyEnabledPatch(curr, row.strategy_key, updated?.enabled !== false));
        Modal.destroyAll();
        // 不弹 message — 频繁切换会刷屏, Switch 状态变化自身已经有反馈
      } catch (err: any) {
        // 回滚
        setRows(curr => applyEnabledPatch(curr, row.strategy_key, prev));
        Modal.error({
          title: '更新失败',
          content: err?.response?.data?.message || err?.message || '未知错误',
        });
      } finally {
        setTogglingKey(null);
      }
    },
    []
  );

  /**
   * Switch onChange 入口 — 用 helper 决定要不要弹确认.
   * confirm 后调 doToggle; 不需要确认时直接调.
   */
  const handleToggle = useCallback(
    (row: KillSwitchRowItem, nextEnabled: boolean): void => {
      const cfg = buildKillSwitchConfirmConfig(row, nextEnabled);
      if (!cfg.needsConfirm) {
        void doToggle(row, nextEnabled);
        return;
      }
      Modal.confirm({
        title: cfg.title,
        content: cfg.content,
        okText: cfg.okText,
        okButtonProps: { danger: cfg.danger },
        cancelText: '取消',
        icon: <ExclamationCircleOutlined style={{ color: '#f5222d' }} />,
        onOk: () => doToggle(row, nextEnabled),
      });
    },
    [doToggle]
  );

  const kpi = useMemo(() => buildKillSwitchKpi(rows), [rows]);

  /** 搜索框: strategy_key / display_name / category 任一命中即留. */
  const filteredRows = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      r =>
        r.strategy_key.toLowerCase().includes(q) ||
        r.display_name.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q)
    );
  }, [rows, searchText]);

  return (
    <Card
      className="modern-card"
      variant="borderless"
      size="small"
      title={
        <Space>
          <ThunderboltOutlined />
          <span style={{ fontWeight: 600 }}>策略 kill-switch (启用 / 禁用)</span>
          {kpi.disabledCount > 0 && (
            <Tag color="warning" data-testid="ks-disabled-tag">
              {kpi.disabledCount} 已禁用
            </Tag>
          )}
        </Space>
      }
      extra={
        <Space>
          <Input.Search
            placeholder="按 key / 名称 / category 搜索"
            allowClear
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            style={{ width: 240 }}
            size="small"
          />
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={refresh}>
            刷新
          </Button>
        </Space>
      }
    >
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} />}

      <Space size={32} style={{ marginBottom: 12, width: '100%' }} data-testid="ks-kpi-strip">
        <Statistic title="策略总数" value={kpi.total} suffix="只" />
        <Statistic
          title="启用中"
          value={kpi.enabledCount}
          suffix="只"
          valueStyle={{ color: '#3f8600' }}
        />
        <Statistic
          title="已禁用"
          value={kpi.disabledCount}
          suffix="只"
          valueStyle={{ color: kpi.disabledCount > 0 ? '#cf1322' : '#999' }}
        />
        <Statistic
          title="高风险启用中"
          value={kpi.highRiskEnabled}
          suffix="只"
          valueStyle={{ color: kpi.highRiskEnabled > 0 ? '#fa8c16' : '#999' }}
        />
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        icon={<SafetyOutlined />}
        message="单独 disable / enable 任一只策略"
        description={
          <div>
            <Paragraph style={{ marginBottom: 4 }}>
              拨动右侧 Switch 立即 PATCH <code>quant_strategies.enabled</code>, 后端
              <code>strategyEngine.resolveStrategyKeys()</code>
              下一次 daily pipeline 即按新状态过滤. 已存仓位不会自动卖出 — 请在{' '}
              <strong>PortfolioWorkspace · 持仓</strong> tab 手动平仓.
            </Paragraph>
            <Paragraph style={{ marginBottom: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              与 <strong>dry-run</strong> (LabWorkspace · 策略实验) 互补: dry-run 是
              「产信号不下单」, 本 tab 是「整体停摆 (信号都不出)」. 出问题先 dry-run 隔离,
              真要下线再走本 tab. 与后端自动熔断 <code>KillSwitchService</code> 解耦.
            </Paragraph>
          </div>
        }
      />

      {!loading && rows.length === 0 ? (
        <Empty description="暂无策略 — 请确认后端 quant_strategies 表已 sync registry" />
      ) : (
        <Table<KillSwitchRowItem>
          size="small"
          rowKey="strategy_key"
          loading={loading}
          dataSource={filteredRows}
          pagination={{ defaultPageSize: 30, showSizeChanger: false, hideOnSinglePage: true }}
          data-testid="ks-strategy-table"
          columns={[
            {
              title: '策略',
              dataIndex: 'display_name',
              key: 'display_name',
              render: (_: unknown, row) => (
                <Space direction="vertical" size={0}>
                  <Text strong>{row.display_name}</Text>
                  <Text type="secondary" code style={{ fontSize: 12 }}>
                    {row.strategy_key}
                  </Text>
                </Space>
              ),
            },
            {
              title: 'Category',
              dataIndex: 'category',
              key: 'category',
              width: 160,
              render: (v: string) => <Tag>{v}</Tag>,
            },
            {
              title: '风险等级',
              dataIndex: 'risk_level',
              key: 'risk_level',
              width: 110,
              align: 'center',
              render: (v: StrategyRiskLevel) => (
                <Tag color={RISK_TAG_COLOR[v]} data-testid={`ks-risk-tag-${v}`}>
                  {RISK_TAG_LABEL[v]}
                </Tag>
              ),
            },
            {
              title: '标签',
              dataIndex: 'tags',
              key: 'tags',
              render: (tags: string[]) =>
                tags.length > 0 ? (
                  <Space size={4} wrap>
                    {tags.map(t => (
                      <Tag key={t} color="default">
                        {t}
                      </Tag>
                    ))}
                  </Space>
                ) : (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    —
                  </Text>
                ),
            },
            {
              title: (
                <Space size={4}>
                  <span>启用</span>
                  <Tooltip title="拨动立即落库. 高风险策略禁用时会二次确认.">
                    <span style={{ color: 'var(--text-muted)', cursor: 'help' }}>?</span>
                  </Tooltip>
                </Space>
              ),
              dataIndex: 'enabled',
              key: 'enabled',
              width: 120,
              align: 'center',
              fixed: 'right',
              render: (_: unknown, row) => (
                <Switch
                  checked={row.enabled}
                  loading={togglingKey === row.strategy_key}
                  disabled={togglingKey !== null && togglingKey !== row.strategy_key}
                  onChange={next => handleToggle(row, next)}
                  data-testid={`ks-switch-${row.strategy_key}`}
                  checkedChildren="启用"
                  unCheckedChildren="禁用"
                />
              ),
            },
          ]}
        />
      )}

      <Paragraph style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
        操作落地: <code>PATCH /api/quant/strategies/:key {`{enabled: bool}`}</code> →
        <code>backend/src/quant/engine/internal/QuantStrategyService.updateStrategyConfig</code>.
        下次 <code>resolveStrategyKeys()</code> 调用时生效 (大约 1 个 daily-pipeline 周期).
      </Paragraph>
    </Card>
  );
};

export default StrategyKillSwitchTab;
