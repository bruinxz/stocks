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
            variant="borderless"
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
            variant="borderless"
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
            variant="borderless"
            title={
              <>
                <WechatOutlined style={{ color: '#07c160' }} /> 微信通知（PushPlus）
              </>
            }
          >
            <div style={{ lineHeight: 2 }}>
              <div style={{ marginTop: 8 }}>
                <Text type="secondary">
                  我们使用 PushPlus (推送加) 的「群组通知」功能提供服务。
                  <br />
                  您只需要使用微信扫描下方二维码，关注公众号并加入群组，即可每天接收 AI 选股分析报告。
                  <br />
                  <span style={{ color: '#ff4d4f' }}>* 无需注册，无需实名，随时可退订</span>
                </Text>
                
                <div style={{ marginTop: 24, textAlign: 'center' }}>
                  <img 
                    src={process.env.REACT_APP_PUSHPLUS_QRCODE_URL || 'https://www.pushplus.plus/api/common/qrcode/group/261ae301eaf34c8ba4e0c67c8cd5ca78'} 
                    alt="PushPlus 群组二维码" 
                    style={{ width: 200, height: 200, border: '1px solid #f0f0f0', borderRadius: 8, padding: 8 }}
                  />
                  <div style={{ marginTop: 12 }}>
                    <Text strong>微信扫一扫，加入通知群组</Text>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Profile;
