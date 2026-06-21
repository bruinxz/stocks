/**
 * LabWorkspace.WalkForwardTab — Phase 1 walk-forward 验证 UI
 *
 * 2 个子视图:
 *   - 列表: 最近 30 个 walk-forward run，含 DSR/PBO/verdict KPI 列
 *   - 详情: 点击某个 run 展开 fold 表 (window_index / train 区间 / test 区间 /
 *           train_sharpe / test_sharpe / dsr / verdict 等)
 *   - 表单: 新建一个 walk-forward 验证 (策略 + grid/bounds + 区间 + 高级选项)
 *
 * 与 LeaderboardTab 同文件级 module 设计：
 *   - 独立 file, 默认 export
 *   - 数据自己拉，不依赖 LabWorkspace 的 strategies/tasks
 *   - 表单提交后等待响应 (验证可能 1-5 分钟，request timeout 设大)
 *   - 复用 labService.runWalkForwardValidation / listWalkForwardRuns
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  PlayCircleOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  labService,
  QuantStrategyItem,
  WalkForwardRunRow,
  WalkForwardWindowResult,
  RunWalkForwardPayload,
} from '../../services/labService';
import {
  listAllGridTemplates,
  paramGridToJsonString,
  countGridCombinations,
  GridTemplate,
} from './walkForwardGridTemplateHelpers';

const { Text } = Typography;
const { RangePicker } = DatePicker;

interface WalkForwardTabProps {
  strategies: QuantStrategyItem[];
}

const WalkForwardTab: React.FC<WalkForwardTabProps> = ({ strategies }) => {
  const [runs, setRuns] = useState<WalkForwardRunRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<WalkForwardRunRow | null>(null);
  const [windows, setWindows] = useState<WalkForwardWindowResult[]>([]);
  const [windowsLoading, setWindowsLoading] = useState(false);
  const [windowsError, setWindowsError] = useState<string | null>(null);

  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [formVisible, setFormVisible] = useState(false);

  // -------- load --------
  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await labService.listWalkForwardRuns({ limit: 30 });
      setRuns(list);
    } catch (err: any) {
      setLoadError(err?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // -------- select run --------
  const onSelectRun = useCallback(async (run: WalkForwardRunRow) => {
    setSelectedRun(run);
    setWindows([]);
    setWindowsError(null);
    setWindowsLoading(true);
    try {
      const ws = await labService.getWalkForwardWindows(run.id);
      setWindows(ws);
    } catch (err: any) {
      setWindowsError(err?.message || '加载窗口失败');
    } finally {
      setWindowsLoading(false);
    }
  }, []);

  // -------- delete --------
  const onDelete = useCallback(
    async (run: WalkForwardRunRow) => {
      try {
        await labService.deleteWalkForwardRun(run.id);
        message.success(`已删除 run #${run.id}`);
        if (selectedRun?.id === run.id) {
          setSelectedRun(null);
          setWindows([]);
        }
        refresh();
      } catch (err: any) {
        message.error(err?.message || '删除失败');
      }
    },
    [refresh, selectedRun]
  );

  // -------- submit --------
  const onSubmit = useCallback(
    async (values: any) => {
      const payload: RunWalkForwardPayload = {
        strategy_key: values.strategy_key,
        train_months: values.train_months ?? 12,
        test_months: values.test_months ?? 3,
        start_date: values.dateRange[0].format('YYYY-MM-DD'),
        end_date: values.dateRange[1].format('YYYY-MM-DD'),
        base_config: {
          initial_capital: values.initial_capital ?? 1_000_000,
          benchmark_symbol: values.benchmark ?? 'sh.000300',
          universe: values.universe ?? 'market',
        },
        scheme: values.scheme,
        optimizer_type: values.optimizer_type,
        purging: values.enable_purging
          ? {
              label_horizon_days: values.purge_days ?? 5,
              embargo_days: values.embargo_days ?? 2,
            }
          : null,
        max_combos: values.max_combos ?? 256,
      };
      // grid_search vs bayesian 必填二选一
      if (values.optimizer_type === 'bayesian') {
        try {
          payload.param_bounds = JSON.parse(values.param_bounds_json || '{}');
        } catch (err: any) {
          message.error(`param_bounds JSON 解析失败: ${err.message}`);
          return;
        }
      } else {
        try {
          payload.param_grid = JSON.parse(values.param_grid_json || '{}');
        } catch (err: any) {
          message.error(`param_grid JSON 解析失败: ${err.message}`);
          return;
        }
      }
      if (values.scheme === 'cpcv') {
        payload.cpcv = {
          n_groups: values.cpcv_n ?? 6,
          k_test_groups: values.cpcv_k ?? 2,
        };
      }

      setSubmitting(true);
      try {
        message.loading({
          content: '提交 walk-forward 验证 (可能 1-5 分钟)...',
          key: 'wf',
          duration: 0,
        });
        const result = await labService.runWalkForwardValidation(payload);
        message.success({
          content: `验证完成 verdict=${result.summary.verdict}; ${result.summary.completed_windows}/${result.summary.total_windows} 窗口通过`,
          key: 'wf',
          duration: 5,
        });
        setFormVisible(false);
        form.resetFields();
        refresh();
      } catch (err: any) {
        message.error({ content: err?.message || '验证失败', key: 'wf', duration: 5 });
      } finally {
        setSubmitting(false);
      }
    },
    [form, refresh]
  );

  // -------- columns --------
  const runColumns = useMemo(
    () => [
      {
        title: 'ID',
        dataIndex: 'id',
        key: 'id',
        width: 60,
      },
      {
        title: '策略',
        dataIndex: 'strategy_name',
        key: 'strategy_name',
        width: 200,
      },
      {
        title: '状态',
        dataIndex: 'status',
        key: 'status',
        width: 80,
        render: (s: string) => {
          const colorMap: any = {
            completed: 'success',
            running: 'processing',
            failed: 'error',
          };
          return <Tag color={colorMap[s] || 'default'}>{s}</Tag>;
        },
      },
      {
        title: '进度',
        key: 'progress',
        width: 90,
        render: (_: any, r: WalkForwardRunRow) => `${r.completed_combos}/${r.total_combos}`,
      },
      {
        title: 'DSR',
        key: 'dsr',
        width: 90,
        render: (_: any, r: WalkForwardRunRow) => {
          const dsr = r.metadata_json?.wf_summary?.dsr;
          if (dsr === null || dsr === undefined) return <Text type="secondary">—</Text>;
          const color = dsr >= 0.95 ? 'green' : dsr >= 0.8 ? 'orange' : 'red';
          return <Tag color={color}>{dsr.toFixed(3)}</Tag>;
        },
      },
      {
        title: 'PBO',
        key: 'pbo',
        width: 90,
        render: (_: any, r: WalkForwardRunRow) => {
          const pbo = r.metadata_json?.wf_summary?.pbo;
          if (pbo === null || pbo === undefined) return <Text type="secondary">—</Text>;
          const color = pbo < 0.5 ? 'green' : 'red';
          return <Tag color={color}>{pbo.toFixed(3)}</Tag>;
        },
      },
      {
        title: '判定',
        key: 'verdict',
        width: 100,
        render: (_: any, r: WalkForwardRunRow) => {
          const v = r.metadata_json?.wf_summary?.verdict;
          if (!v) return <Text type="secondary">—</Text>;
          const colorMap: any = { PASS: 'success', FAIL: 'error', INSUFFICIENT: 'warning' };
          const iconMap: any = {
            PASS: <CheckCircleOutlined />,
            FAIL: <CloseCircleOutlined />,
            INSUFFICIENT: <WarningOutlined />,
          };
          return (
            <Tag color={colorMap[v] || 'default'} icon={iconMap[v]}>
              {v}
            </Tag>
          );
        },
      },
      {
        title: '平均 test sharpe',
        key: 'mean_test_sharpe',
        width: 130,
        render: (_: any, r: WalkForwardRunRow) => {
          const v = r.metadata_json?.wf_summary?.mean_test_sharpe;
          return v !== null && v !== undefined ? v.toFixed(3) : <Text type="secondary">—</Text>;
        },
      },
      {
        title: '完成于',
        key: 'finished_at',
        width: 160,
        render: (_: any, r: WalkForwardRunRow) =>
          r.finished_at ? dayjs(r.finished_at).format('YYYY-MM-DD HH:mm') : '—',
      },
      {
        title: '操作',
        key: 'actions',
        width: 140,
        render: (_: any, r: WalkForwardRunRow) => (
          <Space size={4}>
            <Button size="small" onClick={() => onSelectRun(r)}>
              查看
            </Button>
            <Popconfirm title="确认删除？" onConfirm={() => onDelete(r)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [onSelectRun, onDelete]
  );

  const windowColumns = useMemo(
    () => [
      {
        title: '#',
        dataIndex: 'window_index',
        key: 'window_index',
        width: 50,
      },
      {
        title: '状态',
        dataIndex: 'status',
        key: 'status',
        width: 100,
        render: (s: string) => {
          const colorMap: any = {
            completed: 'success',
            train_failed: 'error',
            test_failed: 'warning',
          };
          return <Tag color={colorMap[s] || 'default'}>{s}</Tag>;
        },
      },
      {
        title: 'Train 区间',
        key: 'train_range',
        width: 200,
        render: (_: any, w: WalkForwardWindowResult) =>
          `${w.train_start_date} ~ ${w.train_end_date}`,
      },
      {
        title: 'Test 区间',
        key: 'test_range',
        width: 200,
        render: (_: any, w: WalkForwardWindowResult) => `${w.test_start_date} ~ ${w.test_end_date}`,
      },
      {
        title: 'Train Sharpe',
        dataIndex: 'train_sharpe',
        key: 'train_sharpe',
        width: 100,
        render: (v: number | null) => (v !== null ? v.toFixed(3) : '—'),
      },
      {
        title: 'Test Sharpe',
        dataIndex: 'test_sharpe',
        key: 'test_sharpe',
        width: 100,
        render: (v: number | null) => {
          if (v === null) return '—';
          const color = v >= 1 ? 'green' : v >= 0 ? undefined : 'red';
          return <Text style={{ color }}>{v.toFixed(3)}</Text>;
        },
      },
      {
        title: 'Test Return',
        dataIndex: 'test_return',
        key: 'test_return',
        width: 100,
        render: (v: number | null) => (v !== null ? `${(v * 100).toFixed(2)}%` : '—'),
      },
      {
        title: 'Test DD',
        dataIndex: 'test_drawdown',
        key: 'test_drawdown',
        width: 100,
        render: (v: number | null) => (v !== null ? `${(v * 100).toFixed(2)}%` : '—'),
      },
      {
        title: 'DSR',
        dataIndex: 'dsr',
        key: 'dsr',
        width: 80,
        render: (v: number | null | undefined) => {
          if (v === null || v === undefined) return '—';
          const color = v >= 0.95 ? 'green' : v >= 0.8 ? 'orange' : 'red';
          return <Tag color={color}>{v.toFixed(3)}</Tag>;
        },
      },
      {
        title: '判定',
        dataIndex: 'verdict',
        key: 'verdict',
        width: 110,
        render: (v: string | null | undefined) => {
          if (!v) return '—';
          const colorMap: any = { PASS: 'success', FAIL: 'error', INSUFFICIENT: 'warning' };
          return <Tag color={colorMap[v]}>{v}</Tag>;
        },
      },
      {
        title: '最佳参数',
        dataIndex: 'best_params_json',
        key: 'best_params_json',
        render: (params: any) =>
          params && Object.keys(params).length ? (
            <Text code style={{ fontSize: 11 }}>
              {JSON.stringify(params)}
            </Text>
          ) : (
            '—'
          ),
      },
    ],
    []
  );

  // -------- render --------
  const summary = selectedRun?.metadata_json?.wf_summary;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* Header bar */}
      <Card size="small" className="modern-card">
        <Row align="middle" gutter={16}>
          <Col flex="auto">
            <Space>
              <ExperimentOutlined style={{ color: 'var(--primary)' }} />
              <Text strong>Walk-Forward 验证</Text>
              <Text type="secondary">
                通过过拟合检测 (DSR/PBO) 后才能 promote 参数版本 — Phase 1 学术严谨性升级
              </Text>
            </Space>
          </Col>
          <Col>
            <Space>
              <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
                刷新
              </Button>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={() => setFormVisible(true)}
              >
                新建验证
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {loadError && <Alert type="error" message={loadError} showIcon />}

      {/* Runs table */}
      <Card size="small" className="modern-card" title="最近的 walk-forward run">
        {runs.length === 0 && !loading ? (
          <Empty
            description="还没跑过 walk-forward 验证。点 “新建验证” 触发第一次。"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <Table
            rowKey="id"
            dataSource={runs}
            columns={runColumns as any}
            loading={loading}
            pagination={{ pageSize: 10 }}
            size="small"
            scroll={{ x: 1180 }}
          />
        )}
      </Card>

      {/* Run detail */}
      {selectedRun && (
        <Card
          size="small"
          className="modern-card"
          title={
            <Space>
              <Text strong>Run #{selectedRun.id}</Text>
              <Text type="secondary">{selectedRun.strategy_name}</Text>
              {summary?.verdict && (
                <Tag
                  color={
                    summary.verdict === 'PASS'
                      ? 'success'
                      : summary.verdict === 'FAIL'
                      ? 'error'
                      : 'warning'
                  }
                >
                  {summary.verdict}
                </Tag>
              )}
            </Space>
          }
          extra={
            <Button size="small" onClick={() => setSelectedRun(null)}>
              关闭
            </Button>
          }
        >
          {/* KPI strip */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={4}>
              <Statistic
                title="DSR (Deflated Sharpe)"
                value={summary?.dsr ?? (null as any)}
                precision={3}
                valueStyle={{
                  fontSize: 18,
                  color:
                    summary?.dsr !== null && summary?.dsr !== undefined
                      ? summary.dsr >= 0.95
                        ? '#3f8600'
                        : summary.dsr >= 0.8
                        ? '#fa8c16'
                        : '#cf1322'
                      : undefined,
                }}
                suffix={
                  <Tooltip title="DSR ≥ 0.95 = 大概率非过拟合；< 0.95 = 警惕">
                    <QuestionCircleOutlined style={{ fontSize: 12, color: '#999' }} />
                  </Tooltip>
                }
              />
            </Col>
            <Col span={4}>
              <Statistic
                title="PBO (CPCV)"
                value={summary?.pbo ?? (null as any)}
                precision={3}
                valueStyle={{
                  fontSize: 18,
                  color:
                    summary?.pbo !== null && summary?.pbo !== undefined
                      ? summary.pbo < 0.5
                        ? '#3f8600'
                        : '#cf1322'
                      : undefined,
                }}
                suffix={
                  <Tooltip title="仅 CPCV scheme 才计算；PBO < 0.5 = 通过">
                    <QuestionCircleOutlined style={{ fontSize: 12, color: '#999' }} />
                  </Tooltip>
                }
              />
            </Col>
            <Col span={4}>
              <Statistic
                title="平均 test sharpe"
                value={summary?.mean_test_sharpe ?? (null as any)}
                precision={3}
                valueStyle={{ fontSize: 18 }}
              />
            </Col>
            <Col span={4}>
              <Statistic
                title="胜率"
                value={
                  summary?.win_ratio !== null && summary?.win_ratio !== undefined
                    ? summary.win_ratio * 100
                    : (null as any)
                }
                precision={1}
                suffix="%"
                valueStyle={{ fontSize: 18 }}
              />
            </Col>
            <Col span={4}>
              <Statistic
                title="样本外衰减"
                value={summary?.out_of_sample_decay ?? (null as any)}
                precision={3}
                valueStyle={{
                  fontSize: 18,
                  color:
                    summary?.out_of_sample_decay !== null &&
                    summary?.out_of_sample_decay !== undefined
                      ? summary.out_of_sample_decay <= 0
                        ? '#3f8600'
                        : '#fa8c16'
                      : undefined,
                }}
              />
            </Col>
            <Col span={4}>
              <Statistic
                title="窗口"
                value={summary?.completed_windows ?? 0}
                suffix={`/${summary?.total_windows ?? 0}`}
                valueStyle={{ fontSize: 18 }}
              />
            </Col>
          </Row>

          {windowsError && (
            <Alert type="error" message={windowsError} showIcon style={{ marginBottom: 12 }} />
          )}

          <Table
            rowKey="window_index"
            dataSource={windows}
            columns={windowColumns as any}
            loading={windowsLoading}
            pagination={false}
            size="small"
            scroll={{ x: 1280 }}
          />
        </Card>
      )}

      {/* New WF run modal */}
      <Modal
        title="新建 walk-forward 验证"
        open={formVisible}
        onCancel={() => setFormVisible(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        width={720}
        okText="提交验证"
        cancelText="取消"
      >
        <Alert
          type="info"
          showIcon
          message="验证会跑多个窗口的 train + test backtest，可能 1-5 分钟。提交后请耐心等待。"
          style={{ marginBottom: 12 }}
        />
        <Form
          form={form}
          layout="vertical"
          onFinish={onSubmit}
          initialValues={{
            train_months: 12,
            test_months: 3,
            initial_capital: 1_000_000,
            benchmark: 'sh.000300',
            universe: 'market',
            scheme: 'rolling',
            optimizer_type: 'grid_search',
            enable_purging: false,
            purge_days: 5,
            embargo_days: 2,
            cpcv_n: 6,
            cpcv_k: 2,
            max_combos: 256,
            param_grid_json: '{\n  "topN": [10, 20, 30],\n  "stopLossPct": [-5, -7]\n}',
            param_bounds_json:
              '{\n  "topN": { "min": 10, "max": 50, "integer": true },\n  "stopLossPct": { "min": -15, "max": -3 }\n}',
          }}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="strategy_key"
                label="策略"
                rules={[{ required: true, message: '请选择策略' }]}
              >
                <Select
                  showSearch
                  placeholder="选择策略"
                  options={strategies.map(s => ({
                    label: `${s.strategy_key} — ${s.name || s.strategy_key}`,
                    value: s.strategy_key,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="dateRange"
                label="总区间"
                rules={[{ required: true, message: '请选择区间' }]}
              >
                <RangePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item name="train_months" label="train 月数">
                <InputNumber min={1} max={60} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="test_months" label="test 月数">
                <InputNumber min={1} max={24} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="initial_capital" label="初始资金">
                <InputNumber min={10000} step={100000} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="benchmark" label="基准代码">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="scheme" label="验证 scheme">
                <Select
                  options={[
                    { value: 'rolling', label: 'Rolling (顺序滚动)' },
                    { value: 'cpcv', label: 'CPCV (组合路径; 可算 PBO)' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="optimizer_type" label="参数搜索方法">
                <Select
                  options={[
                    { value: 'grid_search', label: 'GridSearch (离散网格)' },
                    { value: 'bayesian', label: 'Bayesian (连续 EI)' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>

          {/* grid_search 参数 */}
          <Form.Item
            noStyle
            shouldUpdate={(prev, curr) =>
              prev.optimizer_type !== curr.optimizer_type || prev.strategy_key !== curr.strategy_key
            }
          >
            {({ getFieldValue, setFieldsValue }) =>
              getFieldValue('optimizer_type') === 'bayesian' ? (
                <Form.Item
                  name="param_bounds_json"
                  label="param_bounds (JSON)"
                  rules={[{ required: true, message: '必填' }]}
                >
                  <Input.TextArea rows={5} placeholder="{ topN: { min, max, integer? } }" />
                </Form.Item>
              ) : (
                <>
                  {/* US-053 (FE-014) 快速 grid 模板 — 内置 4 套预设 + 用户保存. 选中自动覆盖
                      下方 param_grid (JSON) 字段, 用户也可手改后再提交. */}
                  <Form.Item
                    label={
                      <Space size={4}>
                        <Text>快速 grid 模板</Text>
                        <Tooltip title="选一个预设填充下方 param_grid; 也可手动编辑覆盖. 列表已按当前所选策略排序, 命中策略的预设上浮.">
                          <QuestionCircleOutlined style={{ color: '#999' }} />
                        </Tooltip>
                      </Space>
                    }
                    data-testid="grid-template-picker"
                  >
                    <Select
                      allowClear
                      showSearch
                      placeholder="选择内置预设或已保存模板"
                      data-testid="grid-template-select"
                      filterOption={(input, option) =>
                        String(option?.label || '')
                          .toLowerCase()
                          .includes(input.toLowerCase())
                      }
                      onChange={(value: string | undefined) => {
                        if (!value) return;
                        const all = listAllGridTemplates(getFieldValue('strategy_key'));
                        const tpl = all.find(t => t.name === value);
                        if (!tpl) return;
                        setFieldsValue({ param_grid_json: paramGridToJsonString(tpl.paramGrid) });
                        const combos = countGridCombinations(tpl.paramGrid);
                        message.success(
                          `已加载模板 "${tpl.name}" — 共 ${combos} 个 GridSearch 组合`
                        );
                      }}
                      options={listAllGridTemplates(getFieldValue('strategy_key')).map(
                        (t: GridTemplate) => ({
                          value: t.name,
                          label:
                            (t.source === 'builtin' ? '📋 ' : '⭐ ') +
                            t.name +
                            ` (${countGridCombinations(t.paramGrid)} 组合)`,
                        })
                      )}
                    />
                  </Form.Item>
                  <Form.Item
                    name="param_grid_json"
                    label="param_grid (JSON)"
                    rules={[{ required: true, message: '必填' }]}
                  >
                    <Input.TextArea rows={5} placeholder="{ topN: [10, 20, 30] }" />
                  </Form.Item>
                </>
              )
            }
          </Form.Item>

          {/* CPCV 子配置 */}
          <Form.Item noStyle shouldUpdate={(prev, curr) => prev.scheme !== curr.scheme}>
            {({ getFieldValue }) =>
              getFieldValue('scheme') === 'cpcv' ? (
                <Row gutter={16}>
                  <Col span={12}>
                    <Form.Item
                      name="cpcv_n"
                      label="CPCV n_groups"
                      tooltip="把总区间切成 N 个 group"
                    >
                      <InputNumber min={2} max={20} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item
                      name="cpcv_k"
                      label="CPCV k_test_groups"
                      tooltip="每条路径取 k 个 group 作 test，共 C(n,k) 条路径"
                    >
                      <InputNumber min={1} max={10} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>
              ) : null
            }
          </Form.Item>

          {/* Purging 高级选项 */}
          <Form.Item name="enable_purging" valuePropName="checked">
            <Space>
              <Switch />
              <Text>启用 purging + embargo (推荐)</Text>
              <Tooltip title="purging 去除 train 中 label 跨入 test 的样本；embargo 给 train/test 之间留缓冲日">
                <QuestionCircleOutlined style={{ color: '#999' }} />
              </Tooltip>
            </Space>
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, curr) => prev.enable_purging !== curr.enable_purging}
          >
            {({ getFieldValue }) =>
              getFieldValue('enable_purging') ? (
                <Row gutter={16}>
                  <Col span={12}>
                    <Form.Item name="purge_days" label="label_horizon_days (推荐 5)">
                      <InputNumber min={1} max={30} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="embargo_days" label="embargo_days (推荐 2)">
                      <InputNumber min={0} max={30} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>
              ) : null
            }
          </Form.Item>

          <Form.Item name="max_combos" label="train 最多 combo 数">
            <InputNumber min={1} max={1024} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
};

export default WalkForwardTab;
