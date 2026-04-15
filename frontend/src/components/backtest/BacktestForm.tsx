import React, { useState } from 'react';
import {
  Form,
  Input,
  InputNumber,
  Select,
  DatePicker,
  Button,
  Card,
  Row,
  Col,
  Space,
  message,
} from 'antd';
import { backtestService } from '../../services/backtestService';
import dayjs from 'dayjs';

const { Option } = Select;
const { RangePicker } = DatePicker;

interface BacktestFormProps {
  onSuccess: () => void;
}

const BacktestForm: React.FC<BacktestFormProps> = ({ onSuccess }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [strategyType, setStrategyType] = useState('moving_average_crossover');

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

  // 股票代码选项（模拟数据）
  const symbolOptions = [
    { value: '000001.SZ', label: '平安银行 (000001.SZ)' },
    { value: '000002.SZ', label: '万科A (000002.SZ)' },
    { value: '000858.SZ', label: '五粮液 (000858.SZ)' },
    { value: '600519.SH', label: '贵州茅台 (600519.SH)' },
    { value: '000333.SZ', label: '美的集团 (000333.SZ)' },
    { value: '300750.SZ', label: '宁德时代 (300750.SZ)' },
  ];

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
    <Card title="新建回测">
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
                placeholder="请选择股票"
                optionFilterProp="label"
                options={symbolOptions}
              />
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
          <Col span={12}>
            <Form.Item
              label="策略类型"
              name="strategyType"
              rules={[{ required: true, message: '请选择策略类型' }]}
            >
              <Select options={strategyOptions} onChange={value => setStrategyType(value)} />
            </Form.Item>
          </Col>
        </Row>

        <Card type="inner" title="策略参数" style={{ marginBottom: 24 }}>
          {renderStrategyParams()}
        </Card>

        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={loading}>
              创建回测
            </Button>
            <Button onClick={() => form.resetFields()}>重置</Button>
          </Space>
        </Form.Item>
      </Form>
    </Card>
  );
};

export default BacktestForm;
