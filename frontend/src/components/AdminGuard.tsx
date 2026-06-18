/**
 * AdminGuard — Batch U (2026-06-17, front-2 fix)
 *
 * 前端路由级 admin role guard. 后端是真正的安全防线 (Batch H 已加多处 admin gate),
 * 但前端 UI 也加一道, 避免:
 *  (a) UI 误展示 admin-only 表单/按钮造成用户困惑;
 *  (b) 后端任一处漏 gate 时立即穿透;
 *  (c) 操作执行后才 403 报错的 UX.
 *
 * 用法: <AdminGuard><UserManagement /></AdminGuard> 或直接 wrap router element.
 */

import React from 'react';
import { useSelector } from 'react-redux';
import { Result, Button } from 'antd';
import { useNavigate } from 'react-router-dom';
import { RootState } from '../store/rootReducer';

interface Props {
  children: React.ReactNode;
}

const AdminGuard: React.FC<Props> = ({ children }) => {
  const navigate = useNavigate();
  const user = useSelector((s: RootState) => s.auth.user);
  if (!user) {
    // 未登录 — App.tsx 的 ProtectedRoute 应该已经处理, 这里兜底.
    return (
      <Result
        status="403"
        title="未登录"
        subTitle="请先登录"
        extra={
          <Button type="primary" onClick={() => navigate('/login')}>
            去登录
          </Button>
        }
      />
    );
  }
  if (user.role !== 'admin') {
    return (
      <Result
        status="403"
        title="403"
        subTitle="此页面仅管理员可访问"
        extra={
          <Button type="primary" onClick={() => navigate('/')}>
            返回首页
          </Button>
        }
      />
    );
  }
  return <>{children}</>;
};

export default AdminGuard;
