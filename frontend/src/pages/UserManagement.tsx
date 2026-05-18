import React, { useState, useEffect } from 'react';
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  Space,
  Popconfirm,
  message,
  Tag,
  Card,
  Row,
  Col,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  KeyOutlined,
  UserOutlined,
  TeamOutlined,
  SafetyCertificateOutlined,
  CheckCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  getUsers,
  createUser,
  updateUser,
  changePassword,
  deleteUser,
} from '../services/userService';
import dayjs from 'dayjs';

const { Option } = Select;

interface User {
  id: number;
  username: string;
  email: string;
  role: string;
  is_active: boolean;
  password?: string;
  created_at: string;
}

const UserManagement: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isPasswordModalVisible, setIsPasswordModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  const [form] = Form.useForm();
  const [passwordForm] = Form.useForm();

  const activeUserCount = users.filter(user => user.is_active).length;
  const adminUserCount = users.filter(user => user.role === 'admin').length;
  const disabledUserCount = users.length - activeUserCount;

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const response = await getUsers();
      if (response.data.success) {
        setUsers(response.data.data);
      }
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || '获取用户列表失败';
      message.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleAdd = () => {
    setEditingUser(null);
    form.resetFields();
    form.setFieldsValue({ role: 'user', is_active: true });
    setIsModalVisible(true);
  };

  const handleEdit = (record: User) => {
    setEditingUser(record);
    form.setFieldsValue(record);
    setIsModalVisible(true);
  };

  const handleDelete = async (id: number) => {
    try {
      const res = await deleteUser(id);
      if (res.data.success) {
        message.success('删除成功');
        fetchUsers();
      }
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || '删除失败';
      message.error(errorMsg);
    }
  };

  const handleModalOk = () => {
    form
      .validateFields()
      .then(async values => {
        try {
          if (editingUser) {
            // 编辑时不提交用户名和密码
            const updateData = {
              email: values.email,
              role: values.role,
              is_active: values.is_active,
            };
            const res = await updateUser(editingUser.id, updateData);
            if (res.data.success) {
              message.success('更新成功');
              setIsModalVisible(false);
              fetchUsers();
            }
          } else {
            // 新增
            const res = await createUser(values);
            if (res.data.success) {
              message.success('创建成功');
              setIsModalVisible(false);
              fetchUsers();
            }
          }
        } catch (error: any) {
          const errorMsg = error.response?.data?.message || '操作失败';
          message.error(errorMsg);
        }
      })
      .catch(info => {
        console.log('Validate Failed:', info);
      });
  };

  const handlePasswordChange = (record: User) => {
    setEditingUser(record);
    passwordForm.resetFields();
    setIsPasswordModalVisible(true);
  };

  const handlePasswordModalOk = () => {
    passwordForm.validateFields().then(async values => {
      if (!editingUser) return;
      try {
        const res = await changePassword(editingUser.id, { newPassword: values.newPassword });
        if (res.data.success) {
          message.success('密码修改成功');
          setIsPasswordModalVisible(false);
        }
      } catch (error: any) {
        const errorMsg = error.response?.data?.message || '密码修改失败';
        message.error(errorMsg);
      }
    });
  };

  const columns = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 80,
    },
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
      render: (text: string) => (
        <>
          <UserOutlined style={{ marginRight: 8 }} />
          {text}
        </>
      ),
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      key: 'email',
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      render: (role: string) => (
        <Tag className={`modern-tag ${role === 'admin' ? 'tag-warning' : 'tag-info'}`}>
          {role === 'admin' ? '管理员' : '普通用户'}
        </Tag>
      ),
    },
    {
      title: '密码',
      dataIndex: 'password',
      key: 'password',
      render: (pwd: string) => <Tag className="modern-tag tag-default">{pwd || '已加密'}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      render: (is_active: boolean) => (
        <Tag className={`modern-tag ${is_active ? 'tag-success' : 'tag-error'}`}>
          {is_active ? '启用' : '禁用'}
        </Tag>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (date: string) => dayjs(date).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: User) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Button type="text" icon={<KeyOutlined />} onClick={() => handlePasswordChange(record)} />
          <Popconfirm
            title="确定要删除这个用户吗？"
            onConfirm={() => handleDelete(record.id)}
            okText="确定"
            cancelText="取消"
          >
            <Button type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="fade-in-up">
      <div className="page-header-modern">
        <div>
          <h1 className="page-title-modern">
            <UserOutlined /> 用户管理
          </h1>
          <p className="page-subtitle-modern">
            统一维护系统账号、角色权限与登录状态，确保量化平台访问安全可控。
          </p>
        </div>
        <div className="page-actions-modern">
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            新增用户
          </Button>
        </div>
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card className="stat-card stat-card-blue modern-card" variant="borderless">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div className="metric-title">账号总数</div>
                <div className="metric-value">{users.length}</div>
              </div>
              <div className="icon-wrapper icon-blue">
                <TeamOutlined />
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="stat-card stat-card-green modern-card" variant="borderless">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div className="metric-title">启用账号</div>
                <div className="metric-value">{activeUserCount}</div>
              </div>
              <div className="icon-wrapper icon-green">
                <CheckCircleOutlined />
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="stat-card stat-card-orange modern-card" variant="borderless">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div className="metric-title">管理员</div>
                <div className="metric-value">{adminUserCount}</div>
              </div>
              <div className="icon-wrapper icon-orange">
                <SafetyCertificateOutlined />
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="stat-card stat-card-red modern-card" variant="borderless">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div className="metric-title">禁用账号</div>
                <div className="metric-value">{disabledUserCount}</div>
              </div>
              <div className="icon-wrapper icon-red">
                <StopOutlined />
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      <Card
        title="账号列表"
        className="modern-card table-card-no-padding"
        variant="borderless"
        extra={
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            最近创建优先 · 共 {users.length} 个账号
          </span>
        }
      >
        <Table
          columns={columns}
          dataSource={users}
          rowKey="id"
          loading={loading}
          pagination={{
            defaultPageSize: 10,
            showSizeChanger: true,
            showTotal: total => `共 ${total} 个账号`,
          }}
          scroll={{ x: 'max-content' }}
        />
      </Card>

      <Modal
        title={editingUser ? '编辑用户' : '新增用户'}
        open={isModalVisible}
        onOk={handleModalOk}
        onCancel={() => setIsModalVisible(false)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" preserve={false}>
          {!editingUser && (
            <>
              <Form.Item
                name="username"
                label="用户名"
                rules={[
                  { required: true, message: '请输入用户名' },
                  { min: 3, message: '至少3个字符' },
                ]}
              >
                <Input prefix={<UserOutlined />} placeholder="请输入用户名" />
              </Form.Item>
              <Form.Item
                name="password"
                label="密码"
                rules={[
                  { required: true, message: '请输入密码' },
                  { min: 6, message: '至少6个字符' },
                ]}
              >
                <Input.Password placeholder="请输入初始密码" />
              </Form.Item>
            </>
          )}

          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '请输入有效的邮箱地址' },
            ]}
          >
            <Input placeholder="name@example.com" />
          </Form.Item>

          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select>
              <Option value="user">普通用户</Option>
              <Option value="admin">管理员</Option>
            </Select>
          </Form.Item>

          <Form.Item name="is_active" label="状态" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="禁用" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`修改密码 - ${editingUser?.username}`}
        open={isPasswordModalVisible}
        onOk={handlePasswordModalOk}
        onCancel={() => setIsPasswordModalVisible(false)}
        destroyOnHidden
      >
        <Form form={passwordForm} layout="vertical" preserve={false}>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, message: '至少6个字符' },
            ]}
          >
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default UserManagement;
