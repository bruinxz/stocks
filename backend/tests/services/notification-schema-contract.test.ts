import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

let failed = 0;
function assert(name: string, condition: boolean, detail = '') {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

const root = join(__dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function main() {
  const migration = read(
    'backend/scripts/migrations/2026-07-19-feishu-notification-closed-loop.sql'
  );
  for (const table of ['feishu_notification_outbox', 'notification_incident_states']) {
    assert(`migration creates ${table}`, migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  for (const retired of [
    'SNOWBALL_HOT_KEYWORD_SYNC',
    'BLACK_SWAN_DETECT',
    'WEBHOOK_FALLBACK_RETRY',
    'WEEKLY_QA_STAT_AGGREGATE',
  ]) {
    assert(`migration retires ${retired}`, migration.includes(`'${retired}'`));
  }
  assert(
    'migration removes secret-bearing old fallback table',
    migration.includes('DROP TABLE IF EXISTS webhook_fallback_logs')
  );
  assert(
    'migration persists risk alert dispatch owner metadata',
    migration.includes("ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb")
  );
  assert(
    'migration removes obsolete morning checkup pseudo delivery status',
    migration.includes('DROP COLUMN IF EXISTS dispatch_status')
  );

  const runtimeMigration = read('scripts/deployment/runtime_schema_migration.js');
  assert(
    'deployment runtime migration creates outbox',
    runtimeMigration.includes('CREATE TABLE IF NOT EXISTS feishu_notification_outbox')
  );
  assert(
    'deployment runtime migration creates incident state',
    runtimeMigration.includes('CREATE TABLE IF NOT EXISTS notification_incident_states')
  );

  const runtimeTables = read('backend/src/constants/runtimeSchemaTables.ts');
  assert('runtime health includes outbox', runtimeTables.includes("'feishu_notification_outbox'"));
  assert(
    'runtime health includes incident state',
    runtimeTables.includes("'notification_incident_states'")
  );
  assert(
    'runtime health checks outbox idempotency key',
    runtimeTables.includes("'idempotency_key'")
  );
  assert(
    'outbox schema never persists webhook secrets',
    !/feishu_notification_outbox[\s\S]*?webhook_url[\s\S]*?CREATE TABLE IF NOT EXISTS notification_incident_states/.test(
      migration
    )
  );

  const scheduler = read('backend/src/services/SchedulerService.ts');
  assert(
    'scheduler dispatches unified outbox',
    scheduler.includes("task.type === 'FEISHU_NOTIFICATION_DISPATCH'")
  );
  assert(
    'scheduler no longer imports old retry service',
    !scheduler.includes("require('./webhookFailOpen')")
  );
  assert(
    'queued cron dispatch returns before synchronous success finalization',
    scheduler.includes('queued: true')
  );

  const dataUpdateQueue = read('backend/src/jobs/dataUpdateQueue.ts');
  assert(
    'queue completion owns cron lifecycle finalization',
    dataUpdateQueue.includes('finalizeQueuedScheduledTask')
  );
  assert(
    'queue failures enter incident lifecycle',
    dataUpdateQueue.includes('cronNotificationLifecycleService.recordFailure')
  );
  assert(
    'queue recoveries enter incident lifecycle',
    dataUpdateQueue.includes('cronNotificationLifecycleService.recordRecovery')
  );

  const healthReport = read('backend/src/services/DailyHealthReportService.ts');
  assert(
    'daily health reads historical execution failures',
    healthReport.includes('FROM task_execution_logs l')
  );
  assert(
    'daily health excludes unregistered task types',
    healthReport.includes('s.type IN (:registered_types)')
  );
  assert(
    'daily health no longer depends on current last_run_status',
    !healthReport.includes("s.last_run_status = 'FAILED'")
  );

  const tradingDigest = read('backend/src/services/DailyTradingDigestService.ts');
  assert(
    'trading digest selects configured/default portfolio',
    tradingDigest.includes('DAILY_TRADING_DIGEST_PORTFOLIO_NAME')
  );
  assert(
    'trading digest has deterministic portfolio ordering',
    tradingDigest.includes("['auto_trade_enabled', 'DESC']")
  );
  assert(
    'trading digest identifies portfolio in payload',
    tradingDigest.includes('portfolio_name:')
  );

  const taskRoutes = read('backend/src/api/routes/task.routes.ts');
  const taskController = read('backend/src/api/controllers/TaskController.ts');
  assert(
    'admin can inspect notification health and deliveries',
    taskRoutes.includes("'/notification-deliveries/health'") &&
      taskRoutes.includes("'/notification-deliveries'") &&
      taskController.includes('listDeliveries')
  );
  assert(
    'admin can retry terminal notification',
    taskRoutes.includes("'/notification-deliveries/:id/retry'") &&
      taskController.includes('retryTerminal')
  );
  assert(
    'notification admin endpoints are role-gated',
    /notification-deliveries[\s\S]{0,300}requireRole\('admin'\)/.test(taskRoutes)
  );

  const deployConfig = read('scripts/deployment/deploy_config.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { renderBackendEnv } = require(join(root, 'scripts/deployment/deploy_config.js'));
  const renderedEnv = renderBackendEnv({
    FEISHU_APP_SECRET: 'legacy',
    FEISHU_BITABLE_APP_TOKEN: 'legacy',
    OPS_ALERT_FEISHU_WEBHOOK: 'https://open.feishu.cn/ops',
  });
  assert(
    'deployment stops carrying retired Feishu secrets',
    deployConfig.includes('retiredFeishuKeys') &&
      !renderedEnv.includes('FEISHU_APP_SECRET') &&
      !renderedEnv.includes('FEISHU_BITABLE_APP_TOKEN') &&
      renderedEnv.includes('OPS_ALERT_FEISHU_WEBHOOK')
  );

  const todayCommandCenter = read('backend/src/services/TodayCommandCenterService.ts');
  assert(
    'today command center reads real outbox health',
    todayCommandCenter.includes('feishuNotificationService.getHealth()') &&
      !todayCommandCenter.includes('getLatestFeishuRecommendationLog')
  );

  const riskAlertModel = read('backend/src/models/RiskAlert.ts');
  const riskAlertService = read('backend/src/services/RiskAlertService.ts');
  assert(
    'risk alert service owns one external notification path',
    riskAlertService.includes("external_dispatch_owner: 'risk_alert_service'") &&
      riskAlertModel.includes("external_dispatch_owner === 'risk_alert_service'")
  );

  const morningCheckup = read('backend/src/portfolio/risk/MorningRiskCheckupService.ts');
  assert(
    'morning risk checkup is connected to unified outbox',
    morningCheckup.includes("kind: 'morning_risk_checkup'") &&
      morningCheckup.includes('notifications.enqueueAndDeliver')
  );

  for (const removed of [
    'backend/src/services/webhookFailOpen.ts',
    'backend/src/models/WebhookFallbackLog.ts',
    'backend/src/services/FeishuTaskReportService.ts',
    'backend/src/services/NotificationService.ts',
  ]) {
    assert(`obsolete source deleted: ${removed}`, !existsSync(join(root, removed)));
  }

  const directFeishuSources = [
    'backend/src/live-trading/services/LiveAuditAlertService.ts',
    'backend/src/services/CriticalAnnouncementPushService.ts',
    'backend/src/services/attribution/DailyAttributionFeishuPushService.ts',
    'backend/src/services/RiskAlertService.ts',
    'backend/src/scripts/audit-task-parameters-dry-run.ts',
    'backend/src/services/FeishuBotWebhookService.ts',
    'backend/src/portfolio/risk/MorningRiskCheckupService.ts',
  ];
  for (const file of directFeishuSources) {
    const source = read(file);
    assert(`${file} has no direct axios webhook send`, !/axios\.post\s*\(/.test(source));
    assert(
      `${file} uses unified outbox`,
      source.includes('feishuNotificationService') || source.includes('FeishuNotificationService')
    );
  }

  console.log(`[notification-schema-contract] ${35 - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
