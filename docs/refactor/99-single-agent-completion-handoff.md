# 七 Tab release candidate 最终交接

日期：2026-07-16（Asia/Shanghai）

## 结论

七个 CatDesk Tab、typed replay、durable refresh session 与相关发布门禁已在指定开发机完成验收。验证过程中没有在本机运行测试，没有连接、导入或修改生产数据，也没有执行生产部署。

已验证代码提交：`0d8fc15cddc7dbb9fe38c44b9de87f4eff902c02`

基线：`origin/main@43c7bf0f74f1bdf8edbca928d315a2ddfd8a73d6`

分支：`codex/typed-replay-adapters`

## 精确候选与环境

- 开发机：`liyiming.709@10.37.88.144`
- 候选目录：`/home/liyiming.709/stocks-release-0d8fc15c`
- 候选归档：`/home/liyiming.709/stocks-release-0d8fc15c.tar.gz`
- 归档 SHA-256：`7a557993005fd4155794333e64541c73f859412126a75db3045374d45cbb1ed6`
- Node.js：20.20.2（固定用户级工具链）
- Python：CPython 3.11（hash-locked release venv）
- PostgreSQL：14.22
- PostgreSQL transport：私有 Unix socket `/tmp/stocks-pg-55432-1001`，端口 55432，`inet_server_addr() IS NULL`

## 开发机门禁证据

### Disposable PostgreSQL 全链

`backend/tests/e2e/release-all-live.pg.sh`：`ALL PASS`

- recommendation replay：9/9，通过鉴权、持久化、物理 fingerprint、重启恢复与幂等写入
- Tab1/2 recommendation：PG → HTTP → 两个真实 React 容器通过
- Tab3 JP/KR：受控 JP fixture、推荐与真实 React 容器通过
- Tab4 multibagger：物化、provenance、无效请求防线与真实 React 容器通过
- Tab5 six-month PIT：1024 evaluations、216 snapshots、648 holdings；440 HTTP、216 details、216 holdings 通过
- Tab6/7 total：跨进程 replay/report artifact、HTTP adapter、hook 与真实 React 容器通过
- auth refresh-session migration：forward、rotation、reuse revoke、rollback、tampered ownership 与幂等 runner 通过

### Python

- `ai/tests`：192 tests，全部通过，6 skipped
- `strategy/tests`：57/57 通过
- `datapipeline/tests`：6/6 通过

### Frontend

- Jest：28 suites 通过，6 skipped；222 tests 通过，7 skipped
- TypeScript：`npx tsc --noEmit` 通过
- ESLint：0 errors，577 warnings
- Production build：通过

### Backend

- TypeScript build：通过
- ESLint：0 errors，254 warnings
- OpenAPI byte drift：通过
- 全量 runner：290/290 files 通过，耗时 710.9s
- diagnostic baseline regression guard：通过
- architecture strict drift：4 个既有 SCC、6 个既有跨层项，新增均为 0

### Security

- weak-secret scan：通过；7 个已泄漏 fingerprint 均处于阻断注册表
- live audit event enumeration：通过
- legacy internal IP lint：通过
- 工作树中的 legacy 地址正文残留已替换为占位符；未执行 Git 历史重写

## 验证期间关闭的发布阻断项

- 解除 snapshot/replay PostgreSQL adapter 的包初始化循环导入
- 让 live HTTP harness 在 Unix socket 上正确使用非默认 PostgreSQL 端口
- 让 Tab4 disposable 写入 guard 校验并使用显式端口
- 将 PostgreSQL `name[]` schema probe 规范化为驱动可解析的 `text[]`
- 前端 refresh transport 失败后 fail-closed 清理并返回登录页
- replay supervisor 测试与 worker/control 共享全局子进程上限保持一致
- security scanner 正确识别 Jest `__tests__` 目录
- 直接执行已编译 migration entrypoint，保持 diagnostic baseline 的 package config authority

## 发布边界

- 本候选尚未导入正式数据，也未部署或上线。
- 生产 migration 只在部署脚本中以显式 `APPLY_AUTH_REFRESH_SESSION_MIGRATION=1` 执行，并位于服务重启之前。
- 前端/后端现有 warning 为非阻断存量；本候选没有新增 lint error。
- React Router v7 future-flag 与 SSR `useLayoutEffect` 信息为测试日志 warning，不影响门禁退出码。
- 下一步仅为推送分支、创建 PR、等待 GitHub Actions 全绿并合并；生产导入/部署需另行在正式服务器执行。
