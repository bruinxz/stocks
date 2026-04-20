-- 创建数据更新日志表
CREATE TABLE IF NOT EXISTS data_update_logs (
    id SERIAL PRIMARY KEY,
    type VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    date DATE NOT NULL,
    result JSONB,
    error TEXT,
    affected_stocks INTEGER,
    inserted_records INTEGER,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_data_update_logs_type_status ON data_update_logs(type, status);
CREATE INDEX IF NOT EXISTS idx_data_update_logs_created_at ON data_update_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_data_update_logs_date ON data_update_logs(date);

-- 添加注释
COMMENT ON TABLE data_update_logs IS '数据更新日志表';
COMMENT ON COLUMN data_update_logs.type IS '更新类型';
COMMENT ON COLUMN data_update_logs.status IS '更新状态';
COMMENT ON COLUMN data_update_logs.date IS '更新日期（用于检查当天是否已更新）';
COMMENT ON COLUMN data_update_logs.result IS '更新结果详情';
COMMENT ON COLUMN data_update_logs.error IS '错误信息';
COMMENT ON COLUMN data_update_logs.affected_stocks IS '影响的股票数量';
COMMENT ON COLUMN data_update_logs.inserted_records IS '插入的数据条数';
COMMENT ON COLUMN data_update_logs.started_at IS '开始时间';
COMMENT ON COLUMN data_update_logs.completed_at IS '完成时间';

-- 输出创建结果
SELECT '数据更新日志表创建成功' as message;