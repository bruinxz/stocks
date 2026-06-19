# backend/src/jobs — Bull queue 入队抽象

## aiPollingEnqueue.ts — US-019 / EX-005 aiPollingQueue dedup 持久化统一入口

### 背景
BETA-3 (2026-06-18, audit M-15) 给 `aiPollingQueue.add` 加了 `jobId: ai-poll-${task_id}` 实现 Bull 自动 dedup, 但 4 处 caller (QuantRecommendationController / AutomatedRecommendationLoopService / SchedulerService / QuantFusionService) 各自内联了相同的 add options 块:

```
{ jobId: `ai-poll-${task_id}`, attempts: 10,
  backoff: { type: 'fixed', delay: 3 * 60 * 1000 },
  removeOnComplete: { count: 1000 }, removeOnFail: { count: 500 } }
```

4 处复制粘贴 → 任何 ops 调参 (attempts / retention / backoff) 都要同步 4 处, 漏改即偏移. 本 helper 抽出 `buildAIPollingJobOptions(taskId)` 让默认值有单一事实源.

### 持久化的本质
"dedup 持久化" 不是写进程内 Map 或额外 Redis Set — 而是 Bull 内置 `customJobId` 机制走 Redis Lua 原子操作:

参考 `node_modules/bull/lib/commands/addJob-6.lua` (line 56-59):
```lua
if rcall("EXISTS", jobIdKey) == 1 then
    rcall("PUBLISH", ARGV[1] .. "duplicated@" .. ARGV[11], jobId)
    return jobId .. "" -- convert to string
end
```

同 `jobId` 二次入队 → Redis `EXISTS` 命中 → 直接返已存在的 `jobId` 不创建新任务. Redis 本身是事实源, 跨进程/跨 worker/跨重启全局唯一. 不需要也不应该再加任何进程内缓存 (会与 Redis 真相漂移).

caller 显式传 `jobId` + 让 Bull/Redis 兜底 = "重复 enqueue 被合并" PRD AC 的全部实现.

### API
```ts
import { buildAIPollingJobOptions } from '@/jobs/aiPollingEnqueue';

const opts = buildAIPollingJobOptions({ taskId: result.task_id });
if (!opts) { /* task_id 非法, 自行 fallback */ }
await aiPollingQueue.add(data, opts);
```

可选 override (ops 极少数 case 用, 普通 caller 留空):
```ts
buildAIPollingJobOptions({ taskId, override: { attempts: 5 } });
```

### 接入清单 (4 个 caller, 必须全接)
- `src/api/controllers/QuantRecommendationController.ts` — 多因子候选 manual recommendation
- `src/services/AutomatedRecommendationLoopService.ts` — recommendation loop cron
- `src/services/SchedulerService.ts` — AI_DAILY_SCREENER cron
- `src/quant/engine/internal/QuantFusionService.ts` — quant fusion → agent review

漏一处 = 该路径退回到 inline 复刻 (或忘传 jobId 让 Bull 自动生成数字 ID, dedup 失效). 单测 META-GUARD (tests/jobs/ai-polling-enqueue.test.ts [5]) 用 fs+regex 守这 4 处必须 import helper + 不再 inline 写 `jobId: \`ai-poll-...\``.

### 新增 caller 步骤
1. import `buildAIPollingJobOptions`;
2. `const opts = buildAIPollingJobOptions({ taskId: response.task_id })`;
3. `if (!opts) { /* 记日志/失败计数, 不入队 */ }`;
4. `await aiPollingQueue.add(data, opts)`;
5. 在 META-GUARD 的 callers 数组里添新文件路径让它持续守护.

### 测试入口
```
cd backend && npx ts-node --transpile-only tests/jobs/ai-polling-enqueue.test.ts
```
76 ok 覆盖纯函数 + 主入口 + 重复入队 dedup 行为 + 4 caller META-GUARD.
