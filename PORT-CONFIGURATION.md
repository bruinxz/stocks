# 端口配置说明

## 问题原因分析

端口频繁变化的主要原因是：

### 1. 端口冲突
- 系统中已有进程占用3000、3001、3002端口
- 每次启动时Node.js/React自动尝试下一个可用端口

### 2. 配置不一致
- **前端**：`.env`配置为`3003`，但`api.ts`硬编码`3000`
- **后端**：`.env`配置为`3003`，但之前尝试过其他端口
- **缺少统一管理**：没有中心化端口配置

### 3. 进程管理问题
- 之前的调试进程未正确终止
- 没有统一的启动/停止脚本

## 解决方案

### 1. 固定端口配置

| 服务 | 端口 | 配置文件 |
|------|------|----------|
| 后端API | 3003 | `backend/.env`, `config.json` |
| 前端开发服务器 | 4001 | `frontend/.env`, `config.json` |
| PostgreSQL | 5432 | `docker-compose.yml` |
| Redis | 6379 | `docker-compose.yml` |

### 2. 统一配置管理

已创建中心化配置文件 `config.json`：
```json
{
  "ports": {
    "backend": 3003,
    "frontend": 4001,
    "postgres": 5432,
    "redis": 6379
  }
}
```

### 3. 前端API配置修复

已修复 `frontend/src/services/api.ts`：
```typescript
// 修复前（错误）：
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:3000/api';

// 修复后（正确）：
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:3003/api';
```

### 4. 提供启动脚本

创建 `start-all.bat` 启动脚本：
- 检查端口占用
- 自动终止冲突进程
- 顺序启动后端和前端
- 提供统一的访问地址

## 使用说明

### 启动完整系统
```bash
# 方法1：使用启动脚本（推荐）
start-all.bat

# 方法2：手动启动
cd backend && npm run dev
cd frontend && npm start
```

### 访问地址
- 后端API：http://localhost:3003
- 前端界面：http://localhost:4001
- 投资组合模拟：http://localhost:4001/portfolio

### 停止系统
```bash
# 使用停止脚本
stop-all.bat

# 或手动终止进程
taskkill /F /IM node.exe
```

## 故障排除

### 1. 端口被占用
```
错误：端口3003已被占用
```
**解决方案**：
- 运行 `stop-all.bat`
- 或手动终止进程：`taskkill /F /IM node.exe`

### 2. 前端无法连接后端
```
POST http://localhost:3000/api/... net::ERR_CONNECTION_REFUSED
```
**原因**：前端仍使用旧的硬编码端口3000
**解决方案**：
1. 确认 `frontend/src/services/api.ts` 已修复
2. 重启前端：`cd frontend && npm start`

### 3. 配置文件不生效
**原因**：环境变量未正确加载
**解决方案**：
1. 检查 `.env` 文件是否存在
2. 重启开发服务器
3. 确保没有缓存的旧版本

## 长期维护建议

1. **避免硬编码端口**：始终使用环境变量或配置文件
2. **统一配置管理**：所有端口配置集中在 `config.json`
3. **提供启动脚本**：确保一致的启动顺序
4. **文档记录**：维护端口配置文档

## 当前状态

✅ 端口配置已统一
✅ 前端API配置已修复  
✅ 启动脚本已创建
✅ 配置文件已标准化

现在系统应该能够稳定运行在固定端口上。