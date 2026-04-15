import React, { useState, useEffect } from 'react';
import {
  Card,
  Form,
  Input,
  Button,
  DatePicker,
  Select,
  Row,
  Col,
  Table,
  Statistic,
  Alert,
  Spin,
  Empty,
  Modal,
  message,
  Tabs,
  Space,
  Tag,
} from 'antd';
import {
  LineChartOutlined,
  StockOutlined,
  CalendarOutlined,
  DollarOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  StarOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { portfolioApi } from '../services/portfolioService';
import api from '../services/api';

const { RangePicker } = DatePicker;
const { Option } = Select;
const { TabPane } = Tabs;

// 股票收益数据接口
interface StockReturnData {
  symbol: string;
  name: string;
  buyPrice: number;
  allocationAmount: number;
  shares: number;
  finalValue: number;
  totalReturn: number;
}

// 每日收益数据接口
interface DailyReturnData {
  date: string;
  totalValue: number;
  dailyReturn: number;
  cumulativeReturn: number;
}

// 性能指标接口
interface PerformanceMetrics {
  sharpeRatio: number;
  maxDrawdown: number;
  volatility: number;
  winDays: number;
  lossDays: number;
  avgDailyReturn: number;
  bestDay: { date: string; return: number };
  worstDay: { date: string; return: number };
}

// 模拟结果接口
interface SimulationResult {
  config: {
    symbols: string[];
    buyDate: string;
    days: number;
    initialCapital: number;
    allocationStrategy: string;
  };
  summary: {
    initialCapital: number;
    finalCapital: number;
    totalReturn: number;
    annualizedReturn: number;
    totalDays: number;
    startDate: string;
    endDate: string;
  };
  performanceMetrics: PerformanceMetrics;
  dailyReturns: DailyReturnData[];
  stockReturns: StockReturnData[];
}

const Portfolio: React.FC = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [activeTab, setActiveTab] = useState('config');
  const [favorites, setFavorites] = useState<any[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [isFavoriteModalOpen, setIsFavoriteModalOpen] = useState(false);
  const [stockOptions, setStockOptions] = useState<{value: string, label: string}[]>([
    {value: 'sh.600000', label: 'sh.600000 (浦发银行)'},
    {value: 'sh.600036', label: 'sh.600036 (招商银行)'},
    {value: 'sh.601398', label: 'sh.601398 (工商银行)'},
    {value: 'sz.000001', label: 'sz.000001 (平安银行)'},
    {value: 'sh.600519', label: 'sh.600519 (贵州茅台)'},
    {value: 'sz.000858', label: 'sz.000858 (五粮液)'},
  ]);
  const [stockNameMap, setStockNameMap] = useState<Record<string, string>>({
    'sh.600000': '浦发银行',
    'sh.600036': '招商银行',
    'sh.601398': '工商银行',
    'sz.000001': '平安银行',
    'sh.600519': '贵州茅台',
    'sz.000858': '五粮液',
  });
  const [simulationHistory, setSimulationHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // 加载收藏列表和历史记录
  useEffect(() => {
    fetchFavorites();
    fetchSimulationHistory();
  }, []);

  // 热门股票组合
  const popularCombinations = [
    {
      name: '银行股组合',
      symbols: ['sh.600000', 'sh.601398', 'sz.000001'],
      description: '稳健的银行股投资组合',
    },
    {
      name: '消费龙头',
      symbols: ['sh.600519', 'sz.000858', 'sz.002415'],
      description: '消费行业龙头企业',
    },
    {
      name: '科技成长',
      symbols: ['sz.300750', 'sz.000063', 'sz.002415'],
      description: '科技成长型股票',
    },
  ];

  // 表单提交处理
  const handleSubmit = async (values: any) => {
    try {
      console.log('表单提交数据:', values);
      setLoading(true);
      const config = {
        symbols: values.symbols,
        buyDate: values.buyDate ? values.buyDate.format('YYYY-MM-DD') : null,
        days: parseInt(values.days, 10),
        initialCapital: parseFloat(values.initialCapital) || 100000,
        allocationStrategy: values.allocationStrategy || 'equal',
        includeDividends: false,
        reinvest: false,
      };
      console.log('发送到API的数据:', config);

      const response = await portfolioApi.simulate(config);
      console.log('API响应:', response);

      if (response.success) {
        const simulation = response.data.simulation;
        setResult(simulation);
        setActiveTab('results');
        message.success('投资组合收益模拟完成！');

        // 更新股票名称映射
        if (simulation.stockReturns) {
          const newNameMap = {...stockNameMap};
          let updated = false;
          simulation.stockReturns.forEach((stock: StockReturnData) => {
            if (stock.name && stock.name !== stock.symbol && !stock.name.includes('.')) {
              if (newNameMap[stock.symbol] !== stock.name) {
                newNameMap[stock.symbol] = stock.name;
                updated = true;
              }
            }
          });
          if (updated) {
            setStockNameMap(newNameMap);

            // 同时更新股票选项
            const newOptions = [...stockOptions];
            simulation.stockReturns.forEach((stock: StockReturnData) => {
              if (!newOptions.find(opt => opt.value === stock.symbol)) {
                const label = `${stock.symbol} (${stock.name})`;
                newOptions.push({ value: stock.symbol, label });
              }
            });
            setStockOptions(newOptions);
          }
        }
      } else {
        console.error('API返回失败:', response);
        message.error(response.message || '模拟失败');
      }
    } catch (error: any) {
      console.error('模拟失败:', error);
      console.error('错误详情:', error.response?.data);
      let errorMessage = error.message || '模拟失败，请检查配置';

      if (error.response?.data?.errors) {
        errorMessage = error.response.data.errors.map((err: any) => err.msg).join(', ');
      } else if (error.response?.data?.message) {
        errorMessage = error.response.data.message;
      }

      // 针对特定错误提供更友好的提示
      if (errorMessage.includes('没有买入日数据') || errorMessage.includes('没有数据')) {
        errorMessage = '选择的买入日期没有股票数据。请选择更早的历史日期（如2024-01-01）';
      }

      message.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  // 获取模拟历史记录
  const fetchSimulationHistory = async () => {
    setHistoryLoading(true);
    try {
      const response = await portfolioApi.getSimulationHistory({ limit: 10 });
      if (response.success) {
        setSimulationHistory(response.data.simulations || []);
      }
    } catch (error) {
      console.error('获取模拟历史记录失败:', error);
      // 不显示错误，可能API不存在或未登录
    } finally {
      setHistoryLoading(false);
    }
  };

  // 获取收藏列表
  const fetchFavorites = async () => {
    setFavoritesLoading(true);
    try {
      const response = await api.get('/market/favorites');
      if (response.data.success) {
        const favoritesData = response.data.data.favorites || [];
        setFavorites(favoritesData);

        // 将收藏股票添加到选项和映射中
        const newOptions = [...stockOptions];
        const newNameMap = {...stockNameMap};
        let updated = false;

        favoritesData.forEach((fav: any) => {
          const symbol = fav.stock.symbol;
          const name = fav.stock.name || symbol;
          const label = `${symbol} (${name})`;

          if (!newNameMap[symbol]) {
            newNameMap[symbol] = name;
            updated = true;
          }

          if (!newOptions.find(opt => opt.value === symbol)) {
            newOptions.push({ value: symbol, label });
            updated = true;
          }
        });

        if (updated) {
          setStockOptions(newOptions);
          setStockNameMap(newNameMap);
        }
      } else {
        message.error('获取收藏列表失败：' + response.data.error);
      }
    } catch (error: any) {
      console.error('获取收藏列表失败:', error);
      // 不显示错误，因为可能用户未登录
    } finally {
      setFavoritesLoading(false);
    }
  };

  // 应用热门组合
  const applyPopularCombination = async (combination: any) => {
    form.setFieldsValue({
      symbols: combination.symbols,
      buyDate: dayjs().subtract(1, 'year'), // 设置为一年前，使用新生成的两年数据
      days: 30,
      initialCapital: 100000,
    });
    // 触发验证
    try {
      await form.validateFields(['symbols', 'buyDate']);
    } catch (error) {
      // 验证可能失败，但我们已经设置了值
    }
    message.info(`已应用 ${combination.name} 配置，买入日期设置为一年前`);
  };

  // 应用历史组合
  const applyHistoryCombination = async (history: any) => {
    form.setFieldsValue({
      symbols: history.symbols || history.config?.symbols || [],
      buyDate: history.buyDate ? dayjs(history.buyDate) : dayjs().subtract(1, 'year'),
      days: history.days || history.config?.days || 30,
      initialCapital: history.initialCapital || history.config?.initialCapital || 100000,
      allocationStrategy: history.allocationStrategy || history.config?.allocationStrategy || 'equal',
    });
    // 触发验证
    try {
      await form.validateFields(['symbols', 'buyDate']);
    } catch (error) {
      // 验证可能失败，但我们已经设置了值
    }
    message.info(`已应用历史组合配置`);
  };

  // 验证股票
  const handleValidateStocks = async () => {
    const symbols = form.getFieldValue('symbols') || [];
    if (symbols.length === 0) {
      message.warning('请先选择股票');
      return;
    }

    try {
      const response = await portfolioApi.validateStocks(symbols);
      if (response.success) {
        const { validCount, invalidCount } = response.data;
        if (invalidCount === 0) {
          message.success(`所有 ${validCount} 只股票验证通过`);
        } else {
          message.warning(`${validCount} 只股票有效，${invalidCount} 只股票无效`);
        }
      }
    } catch (error) {
      console.error('验证股票失败:', error);
      message.error('验证股票失败');
    }
  };

  // 股票收益表格列定义
  const stockColumns: ColumnsType<StockReturnData> = [
    {
      title: '股票代码',
      dataIndex: 'symbol',
      key: 'symbol',
      render: (text) => <Tag color="blue">{text}</Tag>,
    },
    {
      title: '股票名称',
      dataIndex: 'name',
      key: 'name',
      render: (name, record) => {
        // 如果name看起来像股票代码（包含"."），或者没有提供名称，则使用映射
        const symbol = record.symbol;
        if ((!name || name.includes('.')) && stockNameMap[symbol]) {
          return stockNameMap[symbol];
        }
        return name || symbol;
      },
    },
    {
      title: '买入价格',
      dataIndex: 'buyPrice',
      key: 'buyPrice',
      render: (value) => `¥${value.toFixed(2)}`,
      align: 'right',
    },
    {
      title: '分配金额',
      dataIndex: 'allocationAmount',
      key: 'allocationAmount',
      render: (value) => `¥${value.toFixed(2)}`,
      align: 'right',
    },
    {
      title: '买入股数',
      dataIndex: 'shares',
      key: 'shares',
      align: 'right',
    },
    {
      title: '最终市值',
      dataIndex: 'finalValue',
      key: 'finalValue',
      render: (value) => `¥${value.toFixed(2)}`,
      align: 'right',
    },
    {
      title: '总收益率',
      dataIndex: 'totalReturn',
      key: 'totalReturn',
      render: (value) => (
        <span style={{ color: value >= 0 ? '#3f8600' : '#cf1322' }}>
          {value >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
          {value.toFixed(2)}%
        </span>
      ),
      align: 'right',
    },
  ];

  // 每日收益表格列定义
  const dailyReturnColumns: ColumnsType<DailyReturnData> = [
    {
      title: '日期',
      dataIndex: 'date',
      key: 'date',
      render: (text) => dayjs(text).format('YYYY-MM-DD'),
    },
    {
      title: '总市值',
      dataIndex: 'totalValue',
      key: 'totalValue',
      render: (value) => `¥${value.toFixed(2)}`,
      align: 'right',
    },
    {
      title: '日收益率',
      dataIndex: 'dailyReturn',
      key: 'dailyReturn',
      render: (value) => (
        <span style={{ color: value >= 0 ? '#3f8600' : '#cf1322' }}>
          {value >= 0 ? '+' : ''}{value.toFixed(2)}%
        </span>
      ),
      align: 'right',
    },
    {
      title: '累计收益率',
      dataIndex: 'cumulativeReturn',
      key: 'cumulativeReturn',
      render: (value) => (
        <span style={{ color: value >= 0 ? '#3f8600' : '#cf1322' }}>
          {value >= 0 ? '+' : ''}{value.toFixed(2)}%
        </span>
      ),
      align: 'right',
    },
  ];

  return (
    <div>
      <h1 style={{ marginBottom: 24 }}>
        <LineChartOutlined /> 投资组合收益模拟
      </h1>

      <Tabs activeKey={activeTab} onChange={setActiveTab}>
        <TabPane tab="配置模拟" key="config">
          <Row gutter={24}>
            <Col span={16}>
              <Card title="模拟配置" style={{ marginBottom: 24 }}>
                <Form
                  form={form}
                  layout="vertical"
                  onFinish={handleSubmit}
                  initialValues={{
                    symbols: [],
                    buyDate: dayjs().subtract(1, 'year'), // 默认设置为一年前，使用新生成的两年数据
                    days: 30,
                    initialCapital: 100000,
                    allocationStrategy: 'equal',
                  }}
                >
                  <Row gutter={16}>
                    <Col span={24}>
                      <Form.Item
                        label="选择股票"
                        name="symbols"
                        validateTrigger={['onChange', 'onBlur']}
                        rules={[
                          {
                            type: 'array',
                            required: true,
                            min: 1,
                            message: '请选择至少一只股票',
                          },
                        ]}
                      >
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <Select
                            mode="multiple"
                            placeholder="输入或选择股票代码，如 sh.600000"
                            style={{ width: '100%' }}
                            allowClear
                            options={stockOptions}
                            filterOption={(input, option) => {
                              if (option && typeof option.label === 'string') {
                                return option.label.toLowerCase().indexOf(input.toLowerCase()) >= 0;
                              }
                              return false;
                            }}
                            optionLabelProp="label"
                          />
                          <Space>
                            <Button
                              type="dashed"
                              onClick={handleValidateStocks}
                            >
                              验证股票
                            </Button>
                            <Button
                              type="dashed"
                              onClick={() => setIsFavoriteModalOpen(true)}
                              icon={<StarOutlined />}
                            >
                              从收藏夹选择
                            </Button>
                          </Space>
                        </Space>
                      </Form.Item>
                    </Col>

                    <Col span={12}>
                      <Form.Item
                        label="买入日期"
                        name="buyDate"
                        rules={[{ required: true, message: '请选择买入日期' }]}
                        extra="请选择历史日期（建议2024年及以前）"
                      >
                        <DatePicker
                          style={{ width: '100%' }}
                          placeholder="选择买入日期"
                          disabledDate={(current) => {
                            // 不能选择未来日期
                            return current && current > dayjs().endOf('day');
                          }}
                        />
                      </Form.Item>
                    </Col>

                    <Col span={12}>
                      <Form.Item
                        label="持有天数"
                        name="days"
                        rules={[{ required: true, message: '请输入持有天数' }]}
                      >
                        <Space.Compact style={{ width: '100%' }}>
                          <Input
                            type="number"
                            min={1}
                            max={365 * 5}
                            placeholder="输入持有天数"
                          />
                          <span style={{
                            padding: '0 11px',
                            border: '1px solid #d9d9d9',
                            borderLeft: 0,
                            backgroundColor: '#fafafa',
                            display: 'flex',
                            alignItems: 'center',
                            borderRadius: '0 6px 6px 0'
                          }}>
                            天
                          </span>
                        </Space.Compact>
                      </Form.Item>
                    </Col>

                    <Col span={12}>
                      <Form.Item
                        label="初始资金"
                        name="initialCapital"
                        rules={[{ required: true, message: '请输入初始资金' }]}
                      >
                        <Input
                          type="number"
                          min={1000}
                          max={10000000}
                          placeholder="输入初始资金"
                          prefix={<DollarOutlined />}
                        />
                      </Form.Item>
                    </Col>

                    <Col span={12}>
                      <Form.Item
                        label="资金分配策略"
                        name="allocationStrategy"
                      >
                        <Select placeholder="选择分配策略">
                          <Option value="equal">等权重分配</Option>
                          <Option value="weighted" disabled>
                            加权分配 (开发中)
                          </Option>
                        </Select>
                      </Form.Item>
                    </Col>
                  </Row>

                  <Form.Item>
                    <Space>
                      <Button
                        type="primary"
                        htmlType="submit"
                        loading={loading}
                        icon={<LineChartOutlined />}
                      >
                        开始模拟
                      </Button>
                      <Button
                        onClick={() => form.resetFields()}
                        disabled={loading}
                      >
                        重置
                      </Button>
                    </Space>
                  </Form.Item>
                </Form>
              </Card>
            </Col>

            <Col span={8}>
              <Card title="热门组合推荐" style={{ marginBottom: 24 }}>
                {popularCombinations.map((combo, index) => (
                  <Card
                    key={index}
                    type="inner"
                    title={combo.name}
                    style={{ marginBottom: 12 }}
                    extra={
                      <Button
                        size="small"
                        type="link"
                        onClick={() => applyPopularCombination(combo)}
                      >
                        应用
                      </Button>
                    }
                  >
                    <p>{combo.description}</p>
                    <div>
                      {combo.symbols.map((symbol) => (
                        <Tag key={symbol} color="blue" style={{ marginRight: 4 }}>
                          {symbol}
                        </Tag>
                      ))}
                    </div>
                  </Card>
                ))}
              </Card>

              <Card title="历史组合记录" style={{ marginBottom: 24 }}>
                {historyLoading ? (
                  <div style={{ textAlign: 'center', padding: '20px' }}>
                    <Spin />
                  </div>
                ) : simulationHistory.length > 0 ? (
                  simulationHistory.map((history, index) => (
                    <Card
                      key={index}
                      type="inner"
                      title={`模拟 ${history.name || history.config?.name || `#${history.id || index}`}`}
                      style={{ marginBottom: 12 }}
                      extra={
                        <Button
                          size="small"
                          type="link"
                          onClick={() => applyHistoryCombination(history)}
                        >
                          应用
                        </Button>
                      }
                    >
                      <p>
                        <strong>日期:</strong> {dayjs(history.createdAt || history.config?.createdAt || new Date()).format('YYYY-MM-DD HH:mm')}
                      </p>
                      <p>
                        <strong>收益率:</strong>
                        <span style={{ color: (history.totalReturn || history.summary?.totalReturn || 0) >= 0 ? '#3f8600' : '#cf1322' }}>
                          {(history.totalReturn || history.summary?.totalReturn || 0) >= 0 ? '+' : ''}
                          {(history.totalReturn || history.summary?.totalReturn || 0)?.toFixed(2) || '0.00'}%
                        </span>
                      </p>
                      <div>
                        {(history.symbols || history.config?.symbols || []).map((symbol: string) => (
                          <Tag key={symbol} color="green" style={{ marginRight: 4 }}>
                            {symbol}
                          </Tag>
                        ))}
                      </div>
                    </Card>
                  ))
                ) : (
                  <Empty description="暂无历史模拟记录" />
                )}
              </Card>

              <Card title="使用说明">
                <ul style={{ paddingLeft: 20, margin: 0 }}>
                  <li>选择1-10只A股股票进行模拟</li>
                  <li><strong>设定买入日期</strong>：系统已生成过去两年（2024-04-04 到 2026-04-04）的模拟数据</li>
                  <li>设定持有天数（1-1825天）</li>
                  <li>系统将计算买入持有策略的收益走势</li>
                  <li>支持等权重资金分配</li>
                  <li>可查看详细收益数据和性能指标</li>
                  <li><strong>注意</strong>：日期选择器已限制不能选择未来日期</li>
                </ul>
              </Card>
            </Col>
          </Row>
        </TabPane>

        <TabPane tab="模拟结果" key="results" disabled={!result}>
          {result ? (
            <div>
              <Card title="模拟摘要" style={{ marginBottom: 24 }}>
                <Row gutter={16}>
                  <Col span={6}>
                    <Statistic
                      title="初始资金"
                      value={result.summary.initialCapital}
                      prefix="¥"
                      valueStyle={{ color: '#3f8600' }}
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title="最终资金"
                      value={result.summary.finalCapital}
                      prefix="¥"
                      valueStyle={{ color: '#3f8600' }}
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title="总收益率"
                      value={result.summary.totalReturn}
                      suffix="%"
                      valueStyle={{
                        color: result.summary.totalReturn >= 0 ? '#3f8600' : '#cf1322',
                      }}
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title="年化收益率"
                      value={result.summary.annualizedReturn}
                      suffix="%"
                      valueStyle={{
                        color: result.summary.annualizedReturn >= 0 ? '#3f8600' : '#cf1322',
                      }}
                    />
                  </Col>
                </Row>
                <Row gutter={16} style={{ marginTop: 16 }}>
                  <Col span={6}>
                    <Statistic title="持有天数" value={result.summary.totalDays} />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title="开始日期"
                      value={dayjs(result.summary.startDate).format('YYYY-MM-DD')}
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title="结束日期"
                      value={dayjs(result.summary.endDate).format('YYYY-MM-DD')}
                    />
                  </Col>
                  <Col span={6}>
                    <Statistic
                      title="股票数量"
                      value={result.config.symbols.length}
                    />
                  </Col>
                </Row>
              </Card>

              <Row gutter={24} style={{ marginBottom: 24 }}>
                <Col span={12}>
                  <Card title="性能指标">
                    <Row gutter={16}>
                      <Col span={12}>
                        <Statistic
                          title="夏普比率"
                          value={result.performanceMetrics.sharpeRatio.toFixed(2)}
                        />
                      </Col>
                      <Col span={12}>
                        <Statistic
                          title="最大回撤"
                          value={result.performanceMetrics.maxDrawdown.toFixed(2)}
                          suffix="%"
                        />
                      </Col>
                      <Col span={12}>
                        <Statistic
                          title="波动率"
                          value={result.performanceMetrics.volatility.toFixed(2)}
                          suffix="%"
                        />
                      </Col>
                      <Col span={12}>
                        <Statistic
                          title="胜率"
                          value={`${(
                            (result.performanceMetrics.winDays /
                              (result.performanceMetrics.winDays + result.performanceMetrics.lossDays)) *
                            100
                          ).toFixed(1)}%`}
                        />
                      </Col>
                      <Col span={12}>
                        <Statistic
                          title="最佳交易日"
                          value={result.performanceMetrics.bestDay.return.toFixed(2)}
                          suffix="%"
                          valueStyle={{ color: '#3f8600' }}
                        />
                        <div style={{ fontSize: '12px', color: '#666' }}>
                          {dayjs(result.performanceMetrics.bestDay.date).format('YYYY-MM-DD')}
                        </div>
                      </Col>
                      <Col span={12}>
                        <Statistic
                          title="最差交易日"
                          value={result.performanceMetrics.worstDay.return.toFixed(2)}
                          suffix="%"
                          valueStyle={{ color: '#cf1322' }}
                        />
                        <div style={{ fontSize: '12px', color: '#666' }}>
                          {dayjs(result.performanceMetrics.worstDay.date).format('YYYY-MM-DD')}
                        </div>
                      </Col>
                    </Row>
                  </Card>
                </Col>

                <Col span={12}>
                  <Card title="配置详情">
                    <p>
                      <strong>股票列表：</strong>
                      {result.config.symbols.map((symbol) => (
                        <Tag key={symbol} color="blue" style={{ marginRight: 4 }}>
                          {symbol}
                        </Tag>
                      ))}
                    </p>
                    <p>
                      <strong>买入日期：</strong>
                      {dayjs(result.config.buyDate).format('YYYY-MM-DD')}
                    </p>
                    <p>
                      <strong>持有天数：</strong>
                      {result.config.days} 天
                    </p>
                    <p>
                      <strong>分配策略：</strong>
                      {result.config.allocationStrategy === 'equal' ? '等权重' : '加权'}
                    </p>
                  </Card>
                </Col>
              </Row>

              <Card title="股票收益详情" style={{ marginBottom: 24 }}>
                <Table
                  columns={stockColumns}
                  dataSource={result.stockReturns}
                  rowKey="symbol"
                  pagination={false}
                />
              </Card>

              <Card title="每日收益走势">
                <Table
                  columns={dailyReturnColumns}
                  dataSource={result.dailyReturns}
                  rowKey="date"
                  pagination={{ pageSize: 10 }}
                />
              </Card>

              <div style={{ textAlign: 'center', marginTop: 24 }}>
                <Button
                  type="primary"
                  onClick={() => setActiveTab('config')}
                  icon={<CalendarOutlined />}
                >
                  开始新的模拟
                </Button>
              </div>
            </div>
          ) : (
            <Alert
              message="暂无模拟结果"
              description="请先配置并运行一次投资组合模拟"
              type="info"
              showIcon
            />
          )}
        </TabPane>
      </Tabs>

      {/* 从收藏夹选择股票模态框 */}
      <Modal
        title="从收藏夹选择股票"
        open={isFavoriteModalOpen}
        onOk={() => setIsFavoriteModalOpen(false)}
        onCancel={() => setIsFavoriteModalOpen(false)}
        okText="确认"
        cancelText="取消"
        width={800}
      >
        {favoritesLoading ? (
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <Spin />
          </div>
        ) : favorites.length > 0 ? (
          <Table
            dataSource={favorites}
            rowKey={(record) => record.stock.symbol}
            columns={[
              {
                title: '股票',
                dataIndex: 'stock',
                key: 'stock',
                render: (stock) => (
                  <div>
                    <div><strong>{stock.symbol}</strong></div>
                    <div style={{ fontSize: '12px', color: '#666' }}>{stock.name}</div>
                  </div>
                ),
              },
              {
                title: '市场',
                dataIndex: 'stock',
                key: 'market',
                render: (stock) => {
                  const marketMap: Record<string, string> = {
                    SH: '上海',
                    SZ: '深圳',
                    BJ: '北京',
                  };
                  return marketMap[stock.market || ''] || stock.market;
                },
              },
              {
                title: '分组',
                dataIndex: 'groupId',
                key: 'groupId',
                render: (groupId) => groupId || '默认',
              },
              {
                title: '操作',
                key: 'action',
                render: (_, record) => (
                  <Button
                    type="primary"
                    size="small"
                    onClick={() => {
                      const currentSymbols = form.getFieldValue('symbols') || [];
                      if (!currentSymbols.includes(record.stock.symbol)) {
                        form.setFieldsValue({
                          symbols: [...currentSymbols, record.stock.symbol],
                        });
                        message.success(`已添加 ${record.stock.symbol}`);
                      } else {
                        message.info(`股票 ${record.stock.symbol} 已存在`);
                      }
                    }}
                  >
                    添加
                  </Button>
                ),
              },
            ]}
            pagination={false}
            scroll={{ y: 300 }}
          />
        ) : (
          <Empty description="暂无收藏股票，请先在大盘视图页面收藏股票" />
        )}
      </Modal>
    </div>
  );
};

export default Portfolio;