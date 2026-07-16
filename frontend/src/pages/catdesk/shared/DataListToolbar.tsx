import React from 'react';
import { Input } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

interface DataListToolbarProps {
  value: string;
  onChange: (value: string) => void;
  total: number;
  label?: string;
  placeholder?: string;
}

export function DataListToolbar({
  value,
  onChange,
  total,
  label = '条数据',
  placeholder = '搜索代码或名称',
}: DataListToolbarProps) {
  return (
    <div className="catdesk-data-toolbar">
      <Input
        allowClear
        value={value}
        prefix={<SearchOutlined />}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={event => onChange(event.target.value)}
      />
      <span>
        找到 <strong>{total.toLocaleString()}</strong> {label}
      </span>
    </div>
  );
}
