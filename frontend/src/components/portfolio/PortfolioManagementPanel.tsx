/**
 * PortfolioManagementPanel (Batch AT-2 2026-06-21) — 模拟盘完整 CRUD UI.
 *
 * 嵌入 PortfolioWorkspace 的 "模拟盘管理" tab. 解决用户原话:
 *   "现在的模拟盘我都不知道它是什么策略，用的是什么因子,
 *    而且我也没法自己新建、更新、删除模拟盘等操作"
 *
 * 功能:
 *   - 表格列出所有模拟盘 + 当前总值 / 7d 收益 / 策略 chip / 因子 chip / 自动跟单开关
 *   - "新建" 按钮 → Modal (mode='create'): 盘名 / 描述 / 初始资金 / Transfer 选策略 + 因子
 *   - 行操作: 查看 (Drawer 展示净值曲线 + 最近 10 trades) / 编辑 (Modal mode='edit', 不可改资金) /
 *            重置 (Popconfirm + 二次确认) / 删除 (Popconfirm 软删)
 *   - 保存成功后调 onAfterMutate 让父组件 (workspace) 刷新数据 + PortfolioContext.refresh
 *
 * Service: portfolioCrudService (8 endpoints, 与后端 PaperTradingController 扩展对应).
 *
 * 与 [[Draft/view 双状态 + 矩阵格批量保存 pattern]] 不同, 这里直接 Modal 表单
 * 双向绑定即可 — 不存在多 cell 协同编辑场景.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Transfer,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { TransferProps } from 'antd';
import {
  CheckCircleTwoTone,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import dayjs from 'dayjs';
import {
  portfolioCrudService,
  AvailableFactor,
  AvailableStrategy,
  PortfolioDetail,
  PortfolioListItem,
  CreatePortfolioInput,
  UpdatePortfolioInput,
} from '../../services/portfolioCrudService';
import { usePortfolio } from '../../contexts/PortfolioContext';
import { useSelector } from 'react-redux';
import { RootState } from '../../store/rootReducer';

const { Title, Text, Paragraph } = Typography;

type ModalMode = 'create' | 'edit' | null;

interface FormValues {
  name: string;
  description?: string;
  initial_capital: number;
  auto_trade_enabled: boolean;
  strategy_keys: string[];
  enabled_factors: string[];
}

const DEFAULT_INITIAL_CAPITAL = 1_000_000;

const PortfolioManagementPanel: React.FC = () => {
  // ---- 顶层 data state ----
  const [list, setList] = useState<PortfolioListItem[]>([]);
  const [strategies, setStrategies] = useState<AvailableStrategy[]>([]);
  const [factors, setFactors] = useState<AvailableFactor[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- Modal + Drawer state ----
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [drawerData, setDrawerData] = useState<PortfolioDetail | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  // Phase 2 (2026-06-27) — 模拟盘统一为 1 个综合主盘. 新建/重置/删除 仅 admin
  // 可见, 避免普通用户绕过统一主盘.
  const currentUser = useSelector((s: RootState) => s.auth.user);
  const isAdmin = currentUser?.role === 'admin';

  // Form
  const [form] = Form.useForm<FormValues>();

  // PortfolioContext - refresh after CRUD so 全局选盘下拉同步
  const { refresh: refreshPortfolioContext } = usePortfolio();

  // ---- 加载列表 + 可用策略 / 因子 ----
  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [l, s, f] = await Promise.all([
        portfolioCrudService.listPortfolios(),
        portfolioCrudService.listAvailableStrategies(),
        portfolioCrudService.listAvailableFactors(),
      ]);
      setList(l);
      setStrategies(s);
      setFactors(f);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // ---- 打开 Modal ----
  const openCreate = useCallback(() => {
    setEditingId(null);
    setModalMode('create');
    form.resetFields();
    form.setFieldsValue({
      name: '',
      description: '',
      initial_capital: DEFAULT_INITIAL_CAPITAL,
      auto_trade_enabled: false,
      strategy_keys: [],
      enabled_factors: [],
    });
  }, [form]);

  const openEdit = useCallback(
    (row: PortfolioListItem) => {
      setEditingId(row.id);
      setModalMode('edit');
      form.resetFields();
      form.setFieldsValue({
        name: row.name,
        description: row.description || '',
        initial_capital: row.initial_capital,
        auto_trade_enabled: row.auto_trade_enabled,
        strategy_keys: row.strategy_keys || [],
        enabled_factors: row.enabled_factors || [],
      });
    },
    [form]
  );

  const closeModal = useCallback(() => {
    setModalMode(null);
    setEditingId(null);
  }, []);

  // ---- 提交 Create / Update ----
  const handleSubmit = useCallback(async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      if (modalMode === 'create') {
        const payload: CreatePortfolioInput = {
          name: values.name.trim(),
          description: values.description?.trim() || undefined,
          initial_capital: values.initial_capital,
          strategy_keys: values.strategy_keys,
          enabled_factors: values.enabled_factors,
          auto_trade_enabled: values.auto_trade_enabled,
        };
        const created = await portfolioCrudService.createPortfolio(payload);
        message.success(`已新建模拟盘 "${created.name}" (id=${created.id})`);
      } else if (modalMode === 'edit' && editingId != null) {
        const patch: UpdatePortfolioInput = {
          name: values.name.trim(),
          description: values.description?.trim() || null,
          strategy_keys: values.strategy_keys,
          enabled_factors: values.enabled_factors,
          auto_trade_enabled: values.auto_trade_enabled,
        };
        await portfolioCrudService.updatePortfolio(editingId, patch);
        message.success('已保存模拟盘修改');
      }

      closeModal();
      await loadAll();
      await refreshPortfolioContext();
    } catch (err: unknown) {
      // antd validate 错误自带提示, 走到这里通常是 API 失败
      const msg = err instanceof Error ? err.message : String(err);
      // 表单校验失败本身 throw errorFields, 不显示 message.error 避免误导
      const isAntdValidation = typeof err === 'object' && err && 'errorFields' in (err as object);
      if (!isAntdValidation) {
        message.error(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }, [closeModal, editingId, form, loadAll, modalMode, refreshPortfolioContext]);

  // ---- 删除 ----
  const handleDelete = useCallback(
    async (row: PortfolioListItem) => {
      try {
        await portfolioCrudService.deletePortfolio(row.id, false);
        message.success(`已软删除模拟盘 "${row.name}" — trades / snapshots 保留`);
        await loadAll();
        await refreshPortfolioContext();
      } catch (err: unknown) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [loadAll, refreshPortfolioContext]
  );

  // ---- 重置 ----
  const handleReset = useCallback(
    async (row: PortfolioListItem) => {
      try {
        await portfolioCrudService.resetPortfolio(row.id);
        message.success(
          `已重置模拟盘 "${row.name}" — 所有持仓清空, 资金恢复到 ¥${row.initial_capital.toLocaleString()}`
        );
        await loadAll();
        await refreshPortfolioContext();
      } catch (err: unknown) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [loadAll, refreshPortfolioContext]
  );

  // ---- 切自动跟单开关 (行内直接 PATCH) ----
  const handleToggleAutoTrade = useCallback(
    async (row: PortfolioListItem, next: boolean) => {
      try {
        // 乐观更新 (UX: Switch 立即拨动)
        setList(prev =>
          prev.map(p => (p.id === row.id ? { ...p, auto_trade_enabled: next } : p))
        );
        await portfolioCrudService.updatePortfolio(row.id, { auto_trade_enabled: next });
        message.success(
          `"${row.name}" 自动跟单已${next ? '开启' : '关闭'} — 14:35 cron 将${next ? '' : '不'}下单`
        );
        await refreshPortfolioContext();
      } catch (err: unknown) {
        // 回滚
        setList(prev =>
          prev.map(p => (p.id === row.id ? { ...p, auto_trade_enabled: !next } : p))
        );
        message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshPortfolioContext]
  );

  // ---- 打开详情 Drawer ----
  const openDrawer = useCallback(async (id: number) => {
    setDrawerId(id);
    setDrawerData(null);
    setDrawerError(null);
    setDrawerLoading(true);
    try {
      const detail = await portfolioCrudService.getPortfolioDetail(id);
      setDrawerData(detail);
    } catch (err: unknown) {
      setDrawerError(err instanceof Error ? err.message : String(err));
    } finally {
      setDrawerLoading(false);
    }
  }, []);
  const closeDrawer = useCallback(() => {
    setDrawerId(null);
    setDrawerData(null);
    setDrawerError(null);
  }, []);

  // ---- Transfer 数据源 ----
  const strategyDataSource = useMemo<TransferProps<{ key: string }>['dataSource']>(
    () =>
      strategies.map(s => ({
        key: s.key,
        title: s.name,
        description: s.brief,
      })),
    [strategies]
  );
  const factorDataSource = useMemo<TransferProps<{ key: string }>['dataSource']>(
    () =>
      factors.map(f => ({
        key: f.key,
        title: `${f.name}`,
        description: f.category,
      })),
    [factors]
  );

  // ---- 表格列 ----
  const columns: ColumnsType<PortfolioListItem> = [
    {
      title: '盘名',
      dataIndex: 'name',
      key: 'name',
      width: 160,
      fixed: 'left',
      render: (name: string, row) => (
        <Space direction="vertical" size={2}>
          <Text strong>{name}</Text>
          {!row.is_active && <Tag color="default">已停用</Tag>}
          {row.auto_trade_enabled && (
            <Tag color="purple" icon={<ThunderboltOutlined />}>
              自动跟单
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      ellipsis: { showTitle: true },
      width: 180,
      render: (d: string | null) => d || <Text type="secondary">—</Text>,
    },
    {
      title: '初始资金',
      dataIndex: 'initial_capital',
      key: 'initial_capital',
      width: 110,
      align: 'right',
      render: (v: number) => `¥${Number(v).toLocaleString()}`,
    },
    {
      title: '当前总值',
      dataIndex: 'total_value',
      key: 'total_value',
      width: 120,
      align: 'right',
      render: (v: number) => (
        <Text strong>{`¥${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</Text>
      ),
    },
    {
      title: '7d 收益',
      dataIndex: 'recent_7d_return_pct',
      key: 'recent_7d_return_pct',
      width: 100,
      align: 'right',
      render: (pct: number | null) => {
        if (pct == null) return <Text type="secondary">—</Text>;
        const color = pct > 0 ? '#cf1322' : pct < 0 ? '#3f8600' : undefined;
        return <Text style={{ color }}>{`${pct.toFixed(2)}%`}</Text>;
      },
    },
    {
      title: '持仓数',
      dataIndex: 'position_count',
      key: 'position_count',
      width: 80,
      align: 'right',
    },
    {
      title: '策略 / 因子',
      dataIndex: 'strategy_display',
      key: 'strategy_display',
      width: 280,
      // Batch BB (2026-06-22): 列表挤 — 改紧凑展示, 策略前 2 个 + 总数 chip; 因子合并进同列
      // 详细列表在右侧 Drawer (点 "详情" 看完整 22 因子 + 全部策略 + brief).
      render: (chips: PortfolioListItem['strategy_display'], row) => {
        const factors = row.factor_display || [];
        if ((!chips || chips.length === 0) && factors.length === 0)
          return <Text type="secondary">— 未配置 (用全局默认)</Text>;
        const previewCount = 2;
        const stratPreview = (chips || []).slice(0, previewCount);
        const stratExtra = (chips || []).length - previewCount;
        const factorsTotal = factors.length;
        return (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Space size={[4, 4]} wrap>
              {stratPreview.map(c => (
                <Tooltip key={c.key} title={c.brief || c.key}>
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>{c.name}</Tag>
                </Tooltip>
              ))}
              {stratExtra > 0 && (
                <Tooltip title={(chips || []).slice(previewCount).map(c => c.name).join(' · ')}>
                  <Tag color="default">+{stratExtra} 策略</Tag>
                </Tooltip>
              )}
            </Space>
            {factorsTotal > 0 && (
              <Tooltip title={factors.map(f => f.name).slice(0, 8).join(' · ') + (factors.length > 8 ? ` …+${factors.length - 8}` : '')}>
                <Tag color="geekblue" style={{ marginInlineEnd: 0, fontSize: 11 }}>
                  共 {factorsTotal} 因子 (详情可见)
                </Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: '自动跟单',
      dataIndex: 'auto_trade_enabled',
      key: 'auto_trade_enabled',
      width: 100,
      align: 'center',
      render: (v: boolean, row) => (
        <Tooltip title={v ? '14:35 cron 按 score>75 + 8 道风控自动下单' : '需要手工应用信号'}>
          <Switch
            checked={v}
            checkedChildren="开"
            unCheckedChildren="关"
            onChange={next => void handleToggleAutoTrade(row, next)}
          />
        </Tooltip>
      ),
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      width: 80,
      align: 'center',
      render: (active: boolean) =>
        active ? (
          <CheckCircleTwoTone twoToneColor="#52c41a" />
        ) : (
          <Tag color="default">停用</Tag>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      fixed: 'right',
      render: (_, row) => (
        <Space size={4} wrap>
          <Tooltip title="查看详情">
            <Button
              size="small"
              type="text"
              icon={<EyeOutlined />}
              onClick={() => void openDrawer(row.id)}
            />
          </Tooltip>
          {isAdmin && (
            <Tooltip title="编辑">
              <Button
                size="small"
                type="text"
                icon={<EditOutlined />}
                onClick={() => openEdit(row)}
              />
            </Tooltip>
          )}
          {isAdmin && (
            <Popconfirm
              title={`确认重置 "${row.name}"?`}
              description={
                <Paragraph style={{ marginBottom: 0 }}>
                  所有持仓将清空, 资金恢复到 <Text strong>¥{row.initial_capital.toLocaleString()}</Text>
                  . <Text type="danger">不可撤销</Text>.
                </Paragraph>
              }
              okText="确认重置"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => void handleReset(row)}
            >
              <Tooltip title="重置 (清仓 + 重置 cash)">
                <Button size="small" type="text" icon={<ReloadOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
          {isAdmin && (
            <Popconfirm
              title={`确认软删除 "${row.name}"?`}
              description="已成交的 trades / snapshots 会保留, 列表中不再显示."
              okText="确认删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => void handleDelete(row)}
            >
            <Tooltip title="删除">
              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  // ---- 渲染 ----
  if (loading && list.length === 0) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin tip="加载模拟盘列表中..." />
        </div>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Alert
        type="error"
        showIcon
        message="加载失败"
        description={loadError}
        action={
          <Button size="small" onClick={() => void loadAll()}>
            重试
          </Button>
        }
      />
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={
          <Space>
            <Title level={5} style={{ margin: 0 }}>
              模拟盘管理
            </Title>
            <Text type="secondary">
              {list.length} 个盘 ({list.filter(p => p.is_active).length} 启用)
            </Text>
          </Space>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void loadAll()} loading={loading}>
              刷新
            </Button>
            {isAdmin && (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新建模拟盘
              </Button>
            )}
          </Space>
        }
      >
        {!isAdmin && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="Phase 2 (2026-06-27): 已统一为 1 个『综合策略主盘』, 新建 / 编辑 / 重置 / 删除 仅管理员可见."
          />
        )}
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="自动跟单 = 每日 14:35 cron 按选中策略 + 风控 8 道闸门自动下单. 关闭时仍需手工 '应用到模拟盘'."
        />
        <Table
          rowKey="id"
          columns={columns}
          dataSource={list}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ x: 1500 }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  isAdmin
                    ? "还没有模拟盘 — 点 '新建模拟盘' 创建你的第一个"
                    : '当前账号下没有模拟盘 (请联系管理员)'
                }
              />
            ),
          }}
        />
      </Card>

      {/* Create / Edit Modal */}
      <Modal
        open={modalMode !== null}
        title={modalMode === 'create' ? '新建模拟盘' : '编辑模拟盘'}
        width={920}
        okText={modalMode === 'create' ? '创建' : '保存'}
        cancelText="取消"
        confirmLoading={submitting}
        onCancel={closeModal}
        onOk={() => void handleSubmit()}
        destroyOnClose
        maskClosable={false}
      >
        <Form
          layout="vertical"
          form={form}
          requiredMark="optional"
          initialValues={{
            initial_capital: DEFAULT_INITIAL_CAPITAL,
            auto_trade_enabled: false,
            strategy_keys: [],
            enabled_factors: [],
          }}
        >
          <Form.Item
            name="name"
            label="盘名"
            rules={[
              { required: true, message: '盘名必填' },
              // AT-2-FIX (2026-06-22 二轮 review): 与后端 MAX_NAME_LENGTH=100 对齐.
              // 之前 FE 32 字, 用户输入 33-100 字会被前端拒, 但后端实际接受.
              { max: 100, message: '盘名最多 100 字' },
            ]}
          >
            <Input placeholder="例如: 因子组合 1 / 龙头打板 / 财报反转" />
          </Form.Item>
          <Form.Item name="description" label="描述 (可选)" rules={[{ max: 1000, message: '描述最多 1000 字' }]}>
            <Input.TextArea
              placeholder="这个模拟盘的用途 / 选股逻辑 / 风控偏好"
              autoSize={{ minRows: 2, maxRows: 4 }}
              maxLength={1000}
              showCount
            />
          </Form.Item>
          <Form.Item
            name="initial_capital"
            label={
              modalMode === 'edit' ? (
                <Space>
                  初始资金{' '}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    (不可修改 — 改了对账会乱)
                  </Text>
                </Space>
              ) : (
                '初始资金'
              )
            }
            rules={[
              { required: true, message: '初始资金必填' },
              {
                type: 'number',
                min: 10000,
                max: 100_000_000,
                message: '初始资金需在 1 万 ~ 1 亿之间',
              },
            ]}
          >
            <InputNumber
              style={{ width: 220 }}
              min={10000}
              max={100_000_000}
              step={100000}
              addonAfter="元"
              disabled={modalMode === 'edit'}
              formatter={v => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
              parser={v => {
                const n = Number((v || '').replace(/,/g, ''));
                return (Number.isFinite(n) ? n : 0) as any;
              }}
            />
          </Form.Item>
          <Form.Item
            name="auto_trade_enabled"
            label="自动跟单 (14:35 cron 按所选策略自动下单)"
            valuePropName="checked"
          >
            <Switch checkedChildren="开启" unCheckedChildren="关闭" />
          </Form.Item>
          <Form.Item
            name="strategy_keys"
            label={`策略选择 (共 ${strategies.length} 个)`}
            tooltip="选中的策略会在 cron / 手工应用信号时贡献候选标的"
          >
            <TransferShim dataSource={strategyDataSource} placeholder="选策略" />
          </Form.Item>
          <Form.Item
            name="enabled_factors"
            label={`因子选择 (共 ${factors.length} 个)`}
            tooltip="选中的因子会进入综合打分; 不选 = 全部默认权重"
          >
            <TransferShim dataSource={factorDataSource} placeholder="选因子" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 详情 Drawer */}
      <Drawer
        open={drawerId != null}
        title={drawerData ? `模拟盘详情 · ${drawerData.name}` : '模拟盘详情'}
        width={720}
        onClose={closeDrawer}
        destroyOnClose
      >
        {drawerLoading && (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin tip="加载详情..." />
          </div>
        )}
        {drawerError && <Alert type="error" showIcon message="加载失败" description={drawerError} />}
        {drawerData && !drawerLoading && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card size="small" title="基本信息">
              <Space direction="vertical" size={6}>
                <Text>
                  <strong>盘名:</strong> {drawerData.name}
                </Text>
                <Text>
                  <strong>描述:</strong> {drawerData.description || '—'}
                </Text>
                <Text>
                  <strong>初始资金:</strong> ¥{drawerData.initial_capital.toLocaleString()}
                </Text>
                <Text>
                  <strong>当前总值:</strong> ¥{drawerData.total_value.toLocaleString()}
                </Text>
                <Text>
                  <strong>持仓数:</strong> {drawerData.position_count}
                </Text>
                <Text>
                  <strong>自动跟单:</strong>{' '}
                  {drawerData.auto_trade_enabled ? (
                    <Tag color="purple">开启</Tag>
                  ) : (
                    <Tag>关闭</Tag>
                  )}
                </Text>
                <Text>
                  <strong>创建时间:</strong>{' '}
                  {dayjs(drawerData.created_at).format('YYYY-MM-DD HH:mm')}
                </Text>
              </Space>
            </Card>

            <Card size="small" title="使用中的策略">
              {drawerData.strategy_display && drawerData.strategy_display.length > 0 ? (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {drawerData.strategy_display.map(s => (
                    <Card key={s.key} size="small" type="inner" title={s.name}>
                      <Text type="secondary">{s.brief || s.key}</Text>
                    </Card>
                  ))}
                </Space>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="未配置策略 — 系统默认使用全部"
                />
              )}
            </Card>

            <Card size="small" title="启用的因子">
              {drawerData.factor_display && drawerData.factor_display.length > 0 ? (
                <Space wrap>
                  {drawerData.factor_display.map(f => (
                    <Tooltip key={f.key} title={`${f.category} · ${f.key}`}>
                      <Tag color="geekblue">{f.name}</Tag>
                    </Tooltip>
                  ))}
                </Space>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="未配置因子 — 默认全部权重"
                />
              )}
            </Card>

            <Card size="small" title="最近 7 日净值曲线">
              {drawerData.recent_snapshots && drawerData.recent_snapshots.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={drawerData.recent_snapshots}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis
                      tickFormatter={v => `¥${(Number(v) / 10000).toFixed(1)}w`}
                      domain={['dataMin', 'dataMax']}
                    />
                    <RechartsTooltip
                      formatter={(v: number) =>
                        `¥${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                      }
                    />
                    <Line type="monotone" dataKey="total_value" stroke="#1677ff" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有快照 — 跑过一天交易日 cron 后才有"
                />
              )}
            </Card>

            <Card size="small" title="最近 10 笔交易">
              {drawerData.recent_trades && drawerData.recent_trades.length > 0 ? (
                <Table
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={drawerData.recent_trades}
                  columns={[
                    {
                      title: '时间',
                      dataIndex: 'created_at',
                      width: 130,
                      render: (v: string) => dayjs(v).format('MM-DD HH:mm'),
                    },
                    { title: '股票', dataIndex: 'symbol', width: 90 },
                    {
                      title: '方向',
                      dataIndex: 'direction',
                      width: 60,
                      render: (d: 'BUY' | 'SELL') => (
                        <Tag color={d === 'BUY' ? 'red' : 'green'}>
                          {d === 'BUY' ? '买入' : '卖出'}
                        </Tag>
                      ),
                    },
                    {
                      title: '数量',
                      dataIndex: 'quantity',
                      width: 70,
                      align: 'right',
                      render: (q: number) => q.toLocaleString(),
                    },
                    {
                      title: '价格',
                      dataIndex: 'execute_price',
                      width: 80,
                      align: 'right',
                      render: (p: number) => `¥${Number(p).toFixed(2)}`,
                    },
                    {
                      title: '盈亏',
                      dataIndex: 'realized_pnl',
                      width: 100,
                      align: 'right',
                      render: (v: number | null) => {
                        if (v == null) return <Text type="secondary">—</Text>;
                        const color = v > 0 ? '#cf1322' : v < 0 ? '#3f8600' : undefined;
                        return (
                          <Text style={{ color }}>
                            {v > 0 ? '+' : ''}
                            {`¥${Number(v).toFixed(2)}`}
                          </Text>
                        );
                      },
                    },
                  ]}
                />
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有交易 — 自动跟单未开 / 未应用信号"
                />
              )}
            </Card>
          </Space>
        )}
      </Drawer>
    </Space>
  );
};

/**
 * TransferShim — antd Transfer 的 controlled 包装,
 * 把 targetKeys (实际选中的) 暴露为 Form.Item value, 这样
 * value={string[]} / onChange={(keys)=>void} 与 antd Form 兼容.
 */
interface TransferShimProps {
  value?: string[];
  onChange?: (val: string[]) => void;
  dataSource: TransferProps<{ key: string }>['dataSource'];
  placeholder?: string;
}
const TransferShim: React.FC<TransferShimProps> = ({ value, onChange, dataSource, placeholder }) => {
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  return (
    <Transfer
      dataSource={dataSource}
      targetKeys={value || []}
      selectedKeys={selectedKeys}
      onChange={(nextTargetKeys: React.Key[]) => {
        onChange?.(nextTargetKeys.map(String));
      }}
      onSelectChange={(srcSel, tgtSel) => {
        setSelectedKeys([...srcSel, ...tgtSel].map(String));
      }}
      render={(item: any) => (
        <Tooltip title={item.description} placement="right">
          <span>{item.title}</span>
        </Tooltip>
      )}
      titles={[`可选 (${placeholder || ''})`, '已选']}
      showSearch
      listStyle={{ width: 360, height: 280 }}
      locale={{
        itemUnit: '项',
        itemsUnit: '项',
        searchPlaceholder: '搜索...',
        notFoundContent: '无',
      }}
    />
  );
};

export default PortfolioManagementPanel;
