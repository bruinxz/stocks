import React, { useState } from 'react';
import { Form, Input, Button, message, Typography } from 'antd';
import { UserOutlined, LockOutlined, BarChartOutlined } from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../services/api';

const { Text } = Typography;

const Login: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const onFinish = async (values: any) => {
    setLoading(true);
    try {
      const { username, password } = values;

      // 发送真实登录请求到后端
      const response = await api.post('/auth/login', { username, password });

      if (response.data.success) {
        // 从响应中获取 token 和 用户名
        const { tokens, user } = response.data.data;

        localStorage.setItem('token', tokens.accessToken);
        localStorage.setItem('refreshToken', tokens.refreshToken);
        localStorage.setItem('username', user.username);

        message.success('登录成功！');

        // 获取之前想访问的页面，或者默认跳到 dashboard
        const from = (location.state as any)?.from?.pathname || '/dashboard';
        navigate(from, { replace: true });
      }
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || '网络错误，登录失败';
      message.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-left">
        <div
          style={{
            color: 'white',
            padding: '40px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            height: '100%',
          }}
        >
          <h1 style={{ fontSize: '28px', marginBottom: '12px', fontWeight: 700 }}>
            <BarChartOutlined style={{ marginRight: 12 }} />
            A股回测系统
          </h1>
          <p style={{ fontSize: '14px', opacity: 0.7, maxWidth: '400px', lineHeight: 1.6 }}>
            高保真模拟，事件驱动，专业量化交易流程。为策略研究员与基金经理提供最真实的交易反馈。
          </p>
        </div>
      </div>
      <div className="login-right">
        <div className="login-box">
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6, color: '#1a1a1a' }}>
              欢迎回来
            </h2>
            <Text type="secondary" style={{ fontSize: 13 }}>
              请登录您的账号
            </Text>
          </div>
          <Form name="login" initialValues={{ remember: true }} onFinish={onFinish} size="large">
            <Form.Item name="username" rules={[{ required: true, message: '请输入用户名！' }]}>
              <Input prefix={<UserOutlined style={{ color: '#bfbfbf' }} />} placeholder="用户名" />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码！' }]}>
              <Input.Password
                prefix={<LockOutlined style={{ color: '#bfbfbf' }} />}
                placeholder="密码"
              />
            </Form.Item>
            <Form.Item style={{ marginBottom: 12 }}>
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                block
                style={{ height: 40, fontSize: 14, borderRadius: 8 }}
              >
                登录系统
              </Button>
            </Form.Item>
          </Form>
        </div>
      </div>
    </div>
  );
};

export default Login;
