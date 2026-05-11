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
} from 'antd';
import {
  UserOutlined,
  UploadOutlined,
  PhoneOutlined,
  MailOutlined,
  EditOutlined,
  CloudSyncOutlined,
} from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../store/rootReducer';
import { updateUser } from '../store/authSlice';
import { authService } from '../services/authService';
import { API_DOMAIN_URL } from '../services/api';

const { Title, Text } = Typography;

const Profile: React.FC = () => {
  const { user } = useSelector((state: RootState) => state.auth);
  const dispatch = useDispatch();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  React.useEffect(() => {
    if (user) {
      form.setFieldsValue({
        username: user.username,
        email: user.email,
        nickname: user.nickname,
        phone: user.phone,
      });
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
                <CloudSyncOutlined style={{ color: '#1677ff' }} /> 飞书开放平台同步
              </>
            }
          >
            <div style={{ lineHeight: 2 }}>
              <div style={{ marginTop: 8 }}>
                <Text type="secondary">
                  系统已切换为飞书开放平台：AI
                  分析结果和定时任务执行结果会自动写入指定飞书多维表格。
                  <br />
                  你可以在飞书 Base 中查看任务日志、队列状态、个股评级、评分和核心理由。
                  <br />
                  <span style={{ color: '#1677ff' }}>* 无需个人绑定，应用凭证由后端统一托管。</span>
                </Text>

                <div
                  style={{
                    marginTop: 24,
                    padding: 18,
                    borderRadius: 16,
                    background:
                      'linear-gradient(135deg, rgba(22,119,255,0.08), rgba(20,184,166,0.08))',
                    border: '1px solid rgba(22,119,255,0.16)',
                  }}
                >
                  <Text strong>写入目标</Text>
                  <div style={{ marginTop: 12 }}>
                    <a
                      href="https://my.feishu.cn/base/FOT8bXz5daxZQqszBqecrCAKnbc?table=tblxGh9uXavoj9zR&view=vewaYpA1L3"
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开飞书任务结果表
                    </a>
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
