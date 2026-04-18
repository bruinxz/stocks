import React, { useState, useEffect } from 'react';
import {
  Form,
  Input,
  Select,
  DatePicker,
  InputNumber,
  Button,
  Card,
  Row,
  Col,
  message,
  Radio,
  Spin,
} from 'antd';
import { backtestService } from '../../services/backtestService';
import { marketService, Stock } from '../../services/marketService';
import dayjs from 'dayjs';

const { RangePicker } = DatePicker;

interface BacktestFormProps {
  onSuccess: () => void;
}

const BacktestForm: React.FC<BacktestFormProps> = ({ onSuccess }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [strategyType, setStrategyType] = useState('moving_average_crossover');

  // 股票搜索状态
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [fetchingStocks, setFetchingStocks] = useState(false);

  // 初始化加载股票列表
  useEffect(() => {
    fetchStocks('');
  }, []);

  const fetchStocks = async (query: string) => {
    setFetchingStocks(true);
    try {
      const response = await marketService.searchStocks(query, 100);
      setStocks(response.data.stocks);
    } catch (error) {
      console.error('获取股票列表失败:', error);
      message.error('获取股票列表失败');
    } finally {
      setFetchingStocks(false);
    }
  };

  const handleSearch = (value: string) => {
    if (value) {
      fetchStocks(value);
    } else {
      fetchStocks('');
    }
  };

  const handleSubmit = async (values: any) => {
    setLoading(true);
    try {
      const [startDate, endDate] = values.dateRange;

      const backtestData = {
        name: values.name,
        symbol: values.symbol,
        startDate: startDate.format('YYYY-MM-DD'),
        endDate: endDate.format('YYYY-MM-DD'),
        strategyType: values.strategyType,
        strategyParams: values.strategyParams || {},
        initialCapital: values.initialCapital,
      };

      await backtestService.createBacktest(backtestData);
      message.success('回测创建成功！');
      form.resetFields();
      onSuccess();
    } catch (error) {
      console.error('创建回测失败:', error);
      message.error('创建回测失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  // 策略类型选项
  const strategyOptions = [
    { value: 'moving_average_crossover', label: '移动平均线交叉策略' },
    { value: 'rsi', label: 'RSI策略' },
    { value: 'macd', label: 'MACD策略' },
    { value: 'bollinger_bands', label: '布林带策略' },
  ];

  // 策略参数表单
  const renderStrategyParams = () => {
    switch (strategyType) {
      case 'moving_average_crossover':
        return (
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="短期均线周期"
                name={['strategyParams', 'shortWindow']}
                initialValue={10}
              >
                <InputNumber min={5} max={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="长期均线周期"
                name={['strategyParams', 'longWindow']}
                initialValue={30}
              >
                <InputNumber min={10} max={200} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="信号阈值" name={['strategyParams', 'threshold']} initialValue={0}>
                <InputNumber min={0} max={1} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        );
      case 'rsi':
        return (
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="RSI周期" name={['strategyParams', 'period']} initialValue={14}>
                <InputNumber min={5} max={30} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="超买线" name={['strategyParams', 'overbought']} initialValue={70}>
                <InputNumber min={50} max={90} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="超卖线" name={['strategyParams', 'oversold']} initialValue={30}>
                <InputNumber min={10} max={50} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        );
      case 'macd':
        return (
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="快线周期" name={['strategyParams', 'fastPeriod']} initialValue={12}>
                <InputNumber min={5} max={30} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="慢线周期" name={['strategyParams', 'slowPeriod']} initialValue={26}>
                <InputNumber min={10} max={50} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="信号线周期"
                name={['strategyParams', 'signalPeriod']}
                initialValue={9}
              >
                <InputNumber min={5} max={20} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        );
      case 'bollinger_bands':
        return (
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="均线周期" name={['strategyParams', 'period']} initialValue={20}>
                <InputNumber min={10} max={50} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="标准差倍数" name={['strategyParams', 'stdDev']} initialValue={2}>
                <InputNumber min={1} max={3} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        );
      default:
        return null;
    }
  };

  return (
    <Card className="modern-card" bordered={false} title="新建回测">
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          strategyType: 'moving_average_crossover',
          initialCapital: 100000,
        }}
      >
        <Row gutter={24}>
          <Col span={12}>
            <Form.Item
              label="回测名称"
              name="name"
              rules={[{ required: true, message: '请输入回测名称' }]}
            >
              <Input placeholder="例如：沪深300均线策略回测" />
            </Form.Item>
          </Col>

          <Col span={12}>
            <Form.Item
              label="股票代码"
              name="symbol"
              rules={[{ required: true, message: '请选择股票代码' }]}
            >
              <Select
                showSearch
                placeholder="搜索并选择股票"
                optionFilterProp="children"
                onSearch={handleSearch}
                filterOption={false}
                notFoundContent={fetchingStocks ? <Spin size="small" /> : '未找到股票'}
              >
                {stocks.map(stock => (
                  <Select.Option key={stock.symbol} value={stock.symbol}>
                    {stock.name} ({stock.symbol})
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={24}>
          <Col span={12}>
            <Form.Item
              label="回测日期范围"
              name="dateRange"
              rules={[{ required: true, message: '请选择回测日期范围' }]}
            >
              <RangePicker
                style={{ width: '100%' }}
                disabledDate={current => current && current > dayjs().endOf('day')}
                ranges={{
                  最近一年: [dayjs().subtract(1, 'year'), dayjs()],
                  最近两年: [dayjs().subtract(2, 'year'), dayjs()],
                  最近五年: [dayjs().subtract(5, 'year'), dayjs()],
                }}
              />
            </Form.Item>
          </Col>

          <Col span={12}>
            <Form.Item
              label="初始资金"
              name="initialCapital"
              rules={[{ required: true, message: '请输入初始资金' }]}
            >
              <InputNumber
                style={{ width: '100%' }}
                min={10000}
                max={10000000}
                step={10000}
                formatter={(value: number | undefined): string =>
                  value ? `¥ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''
                }
                parser={(value): number => (value ? Number(value.replace(/¥\s?|(,*)/g, '')) : 0)}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={24}>
          <Col span={24}>
            <Form.Item
              label="策略类型"
              name="strategyType"
              rules={[{ required: true, message: '请选择策略类型' }]}
            >
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                options={strategyOptions}
                onChange={e => setStrategyType(e.target.value)}
              />
            </Form.Item>
          </Col>
        </Row>

        <Card
          className="modern-card"
          bordered={false}
          type="inner"
          title={<span style={{ fontSize: 13, fontWeight: 600, color: '#6b7280' }}>策略参数</span>}
          style={{ marginBottom: 24, background: '#f9fafb', border: '1px solid #f3f4f6' }}
          headStyle={{ minHeight: 38, borderBottom: '1px solid #f3f4f6' }}
        >
          {renderStrategyParams()}
        </Card>

        <div
          style={{
            marginTop: 32,
            paddingTop: 24,
            borderTop: '1px solid #f3f4f6',
            display: 'flex',
            gap: 12,
          }}
        >
          <Button type="primary" htmlType="submit" loading={loading} style={{ padding: '0 32px' }}>
            创建回测
          </Button>
          <Button type="text" onClick={() => form.resetFields()}>
            重置
          </Button>
        </div>
      </Form>
    </Card>
  );
};

export default BacktestForm;
