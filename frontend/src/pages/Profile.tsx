import React, { useState } from 'react';
import {
  Card,
  Form,
  Input,
  Button,
  Upload,
  message,
  Avatar,
  Typography,
  Row,
  Col,
  Divider,
  Switch,
  Modal,
  Tag,
  Alert,
  Space,
} from 'antd';
import {
  UserOutlined,
  UploadOutlined,
  PhoneOutlined,
  MailOutlined,
  EditOutlined,
  WechatOutlined,
  BellOutlined,
  SendOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../store/rootReducer';
import { updateUser } from '../store/authSlice';
import { authService } from '../services/authService';
import { API_DOMAIN_URL } from '../services/api';
import api from '../services/api';

const { Title, Text, Paragraph } = Typography;

const PUSHPLUS_TOKEN_URL = 'https://www.pushplus.plus/push1.html';

const Profile: React.FC = () => {
  const { user } = useSelector((state: RootState) => state.auth);
  const dispatch = useDispatch();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  // 微信通知相关
  const [notifyEnabled, setNotifyEnabled] = useState<boolean>(false);
  const [pushplusToken, setPushplusToken] = useState<string | null>(null);
  const [bindModalOpen, setBindModalOpen] = useState(false);
  const [bindInput, setBindInput] = useState('');
  const [bindLoading, setBindLoading] = useState(false);
  const [testLoading, setTestLoading] = useState(false);

  React.useEffect(() => {
    if (user) {
      form.setFieldsValue({
        username: user.username,
        email: user.email,
        nickname: user.nickname,
        phone: user.phone,
      });
      setNotifyEnabled(!!(user as any).wechat_notify_enabled);
      setPushplusToken((user as any).pushplus_token || null);
    }
  }, [user, form]);

  const onFinish = async (values: any) => {
    setLoading(true);
    try {
      const response = await authService.updateProfile({
        nickname: values.nickname,
        phone: values.phone,
      });
      if (response.success) {
        message.success('个人资料更新成功');
        dispatch(updateUser(response.data.user));
      } else {
        message.error(response.message || '更新失败');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '更新失败');
    } finally {
      setLoading(false);
    }
  };

  const uploadProps: UploadProps = {
    name: 'avatar',
    showUploadList: false,
    customRequest: async options => {
      const { file, onSuccess, onError } = options;
      setUploading(true);
      try {
        const response = await authService.uploadAvatar(file as File);
        if (response.success) {
          message.success('头像上传成功');
          dispatch(updateUser(response.data.user));
          onSuccess && onSuccess('ok');
        } else {
          message.error(response.message || '上传失败');
          onError && onError(new Error(response.message));
        }
      } catch (error: any) {
        message.error(error.response?.data?.message || '上传失败');
        onError && onError(error);
      } finally {
        setUploading(false);
      }
    },
    beforeUpload: file => {
      const isJpgOrPng =
        file.type === 'image/jpeg' || file.type === 'image/png' || file.type === 'image/webp';
      if (!isJpgOrPng) {
        message.error('只允许上传 JPG/PNG/WEBP 格式的图片!');
      }
      const isLt5M = file.size / 1024 / 1024 < 5;
      if (!isLt5M) {
        message.error('图片必须小于 5MB!');
      }
      return isJpgOrPng && isLt5M;
    },
  };

  const avatarSrc = user?.avatar_url
    ? user.avatar_url.startsWith('http')
      ? user.avatar_url
      : `${API_DOMAIN_URL}${user.avatar_url}`
    : undefined;

  const handleToggleNotify = async (checked: boolean) => {
    try {
      const resp = await api.put('/auth/wechat/notify', { enabled: checked });
      if (resp.data.success) {
        setNotifyEnabled(checked);
        message.success(checked ? '已开启微信通知' : '已关闭微信通知');
        dispatch(updateUser({ ...user, wechat_notify_enabled: checked } as any));
      }
    } catch {
      message.error('更新失败');
    }
  };

  const handleUnbind = async () => {
    Modal.confirm({
      title: '确认解绑微信？',
      content: '解绑后将不再收到任务完成的微信推送',
      onOk: async () => {
        try {
          await api.post('/auth/wechat/unbind');
          setPushplusToken(null);
          setNotifyEnabled(false);
          dispatch(
            updateUser({
              ...user,
              pushplus_token: null,
              wechat_notify_enabled: false,
            } as any)
          );
          message.success('已解绑微信');
        } catch {
          message.error('解绑失败');
        }
      },
    });
  };

  const openBindModal = () => {
    setBindInput('');
    setBindModalOpen(true);
  };

  const handleBindSubmit = async () => {
    const token = bindInput.trim();
    if (!token) {
      message.warning('请先粘贴您的 PushPlus Token');
      return;
    }
    if (!/^[a-f0-9]{32}$/i.test(token)) {
      message.warning('Token 格式不正确（应为 32 位十六进制字符串）');
      return;
    }
    setBindLoading(true);
    try {
      const resp = await api.post('/auth/wechat/bind', { token });
      if (resp.data.success) {
        setPushplusToken(token);
        setNotifyEnabled(true);
        dispatch(
          updateUser({
            ...user,
            pushplus_token: token,
            wechat_notify_enabled: true,
          } as any)
        );
        message.success('绑定成功，请到微信查收测试推送');
        setBindModalOpen(false);
      } else {
        message.error(resp.data.message || '绑定失败');
      }
    } catch (err: any) {
      message.error(err.response?.data?.message || '绑定失败');
    } finally {
      setBindLoading(false);
    }
  };

  const handleTestPush = async () => {
    setTestLoading(true);
    try {
      const resp = await api.post('/auth/wechat/test');
      if (resp.data.success) {
        message.success('测试推送已发送，请在微信查收');
      } else {
        message.error(resp.data.message || '发送失败');
      }
    } catch (err: any) {
      message.error(err.response?.data?.message || '发送失败');
    } finally {
      setTestLoading(false);
    }
  };

  const maskToken = (t: string) => (t.length > 8 ? `${t.slice(0, 4)}****${t.slice(-4)}` : t);

  return (
    <div className="fade-in-up">
      <div className="page-header-modern">
        <div>
          <h1 className="page-title-modern">个人中心</h1>
          <p className="page-subtitle-modern">管理您的基本信息和偏好设置</p>
        </div>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <Card
            className="modern-card"
            bordered={false}
            style={{ textAlign: 'center', height: '100%' }}
          >
            <div style={{ marginBottom: 24 }}>
              <Avatar
                size={120}
                icon={<UserOutlined />}
                src={avatarSrc}
                style={{ border: '2px solid #f0f0f0' }}
              />
            </div>
            <Title level={4} style={{ margin: 0 }}>
              {user?.nickname || user?.username}
            </Title>
            <Text type="secondary">{user?.role === 'admin' ? '管理员' : '普通用户'}</Text>
            <Divider />
            <Upload {...uploadProps}>
              <Button icon={<UploadOutlined />} loading={uploading}>
                更换头像
              </Button>
            </Upload>
          </Card>
        </Col>

        <Col xs={24} md={16}>
          <Card
            className="modern-card"
            bordered={false}
            title={
              <>
                <EditOutlined /> 基本资料
              </>
            }
            style={{ marginBottom: 16 }}
          >
            <Form form={form} layout="vertical" onFinish={onFinish}>
              <Form.Item label="用户名" name="username">
                <Input disabled prefix={<UserOutlined />} />
              </Form.Item>

              <Form.Item label="邮箱地址" name="email">
                <Input disabled prefix={<MailOutlined />} />
              </Form.Item>

              <Form.Item
                label="昵称"
                name="nickname"
                rules={[{ max: 50, message: '昵称最多50个字符' }]}
              >
                <Input placeholder="设置一个好听的昵称" />
              </Form.Item>

              <Form.Item
                label="手机号"
                name="phone"
                rules={[{ max: 20, message: '手机号最多20个字符' }]}
              >
                <Input prefix={<PhoneOutlined />} placeholder="您的联系电话" />
              </Form.Item>

              <Form.Item style={{ marginTop: 16 }}>
                <Button type="primary" htmlType="submit" loading={loading} block>
                  保存修改
                </Button>
              </Form.Item>
            </Form>
          </Card>

          <Card
            className="modern-card"
            bordered={false}
            title={
              <>
                <WechatOutlined style={{ color: '#07c160' }} /> 微信通知（PushPlus）
              </>
            }
          >
            <div style={{ lineHeight: 2 }}>
              <div>
                <Text>绑定状态：</Text>
                {pushplusToken ? (
                  <Tag color="green">已绑定</Tag>
                ) : (
                  <Tag color="default">未绑定</Tag>
                )}
                {pushplusToken && (
                  <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                    Token: {maskToken(pushplusToken)}
                  </Text>
                )}
              </div>
              <div>
                <BellOutlined /> <Text>接收 AI 定时任务结果推送：</Text>
                <Switch
                  checked={notifyEnabled}
                  disabled={!pushplusToken}
                  onChange={handleToggleNotify}
                  style={{ marginLeft: 8 }}
                />
              </div>
              <div style={{ marginTop: 8, color: '#999', fontSize: 12 }}>
                定时任务（早盘/午盘/收盘分析）完成后，AI 对您收藏股票的评级会通过
                <b style={{ color: '#07c160', margin: '0 4px' }}>PushPlus 公众号</b>
                自动推送到微信
              </div>
              <div style={{ marginTop: 16 }}>
                <Space>
                  {pushplusToken ? (
                    <>
                      <Button
                        type="primary"
                        icon={<SendOutlined />}
                        loading={testLoading}
                        onClick={handleTestPush}
                      >
                        发送测试推送
                      </Button>
                      <Button danger onClick={handleUnbind}>
                        解绑
                      </Button>
                    </>
                  ) : (
                    <Button type="primary" icon={<WechatOutlined />} onClick={openBindModal}>
                      绑定 PushPlus
                    </Button>
                  )}
                </Space>
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      <Modal
        open={bindModalOpen}
        title="绑定 PushPlus（微信推送）"
        onCancel={() => setBindModalOpen(false)}
        onOk={handleBindSubmit}
        confirmLoading={bindLoading}
        okText="验证并绑定"
        cancelText="取消"
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="如何获取 PushPlus Token？"
          description={
            <ol style={{ paddingLeft: 20, marginBottom: 0 }}>
              <li>
                打开{' '}
                <a href={PUSHPLUS_TOKEN_URL} target="_blank" rel="noopener noreferrer">
                  PushPlus 官网 <LinkOutlined />
                </a>{' '}
                并使用微信扫码登录
              </li>
              <li>首次登录会自动关注「pushplus推送加」公众号</li>
              <li>在页面顶部即可看到您的 Token，点击复制</li>
              <li>回到本页面粘贴到下方输入框，点击「验证并绑定」</li>
            </ol>
          }
        />
        <Paragraph style={{ marginBottom: 8 }}>
          <Text strong>粘贴您的 PushPlus Token：</Text>
        </Paragraph>
        <Input.TextArea
          rows={2}
          placeholder="例如：abcd1234... （32 位十六进制字符串）"
          value={bindInput}
          onChange={e => setBindInput(e.target.value)}
          autoFocus
        />
        <div style={{ marginTop: 8, color: '#999', fontSize: 12 }}>
          提交后系统会先发送一条测试消息到您的微信，确认 Token 有效后再保存绑定关系
        </div>
      </Modal>
    </div>
  );
};

export default Profile;
