const { shellQuote } = require('./deploy_config');

const RUNTIME_SCHEMA_TABLES = [
  'stocks',
  'daily_bars',
  'backtest_results',
  'trades',
  'users',
  'favorite_stocks',
  'data_update_logs',
  'scheduled_tasks',
  'task_execution_logs',
  'daily_screeners',
  'paper_trading_portfolios',
  'paper_trading_positions',
  'paper_trading_trades',
  'paper_trading_snapshots',
  'risk_alerts',
  'trading_journals',
  'portfolio_simulations',
  'data_source_health',
  'ai_investment_signals',
  'recommendation_trade_outcomes',
  'recommendation_loop_policy_snapshots',
  'budget_policy_version_snapshots',
  'quant_strategies',
  'quant_backtest_tasks',
  'quant_backtest_results',
  'quant_backtest_trades',
  'quant_signals',
  'quant_strategy_performance_snapshots',
  'quant_strategy_weights',
  'quant_strategy_experiments',
  'quant_strategy_param_versions',
  'quant_strategy_param_validations',
  'quant_fusion_audits',
  'task_parameter_audit_logs',
  'realtime_quotes',
];

const CRITICAL_RUNTIME_SCHEMA_TABLES = [
  'scheduled_tasks',
  'task_execution_logs',
  'ai_investment_signals',
  'recommendation_trade_outcomes',
  'recommendation_loop_policy_snapshots',
  'quant_signals',
  'quant_fusion_audits',
  'quant_backtest_tasks',
  'quant_backtest_results',
  'quant_strategy_weights',
  'quant_strategy_experiments',
  'quant_strategy_param_versions',
  'quant_strategy_param_validations',
  'realtime_quotes',
  'paper_trading_portfolios',
  'paper_trading_trades',
  'task_parameter_audit_logs',
];

function sqlLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function buildRuntimeSchemaMigrationSQL(appDbUser = 'stock_admin') {
  const role = sqlLiteral(appDbUser || 'stock_admin');
  return `
    -- 线上历史库曾由 postgres / stock_admin 混合建表，导致应用启动时无法 ALTER/CREATE。
    -- 这里不改业务数据；优先修复 owner，若维护角色不是 superuser/member，则降级为 grant/create 权限。
    -- 注意：ALTER ... OWNER TO app_role 需要维护角色是 superuser 或 app_role 成员；生产默认用 pgg_superadmins。
    DO $$
    DECLARE
      target_role text := ${role};
      item record;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
        RAISE NOTICE '应用数据库角色 % 不存在，跳过 owner/grant 修复', target_role;
        RETURN;
      END IF;

      BEGIN
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), target_role);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'GRANT CONNECT 失败：%', SQLERRM;
      END;

      BEGIN
        EXECUTE format('ALTER SCHEMA public OWNER TO %I', target_role);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'ALTER SCHEMA OWNER 跳过：%', SQLERRM;
      END;

      BEGIN
        EXECUTE format('GRANT USAGE, CREATE ON SCHEMA public TO %I', target_role);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'GRANT SCHEMA USAGE/CREATE 失败：%', SQLERRM;
      END;

      FOR item IN SELECT tablename AS object_name FROM pg_tables WHERE schemaname = 'public'
      LOOP
        BEGIN
          EXECUTE format('ALTER TABLE IF EXISTS public.%I OWNER TO %I', item.object_name, target_role);
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'ALTER TABLE %.% OWNER 跳过：%', 'public', item.object_name, SQLERRM;
        END;
      END LOOP;

      FOR item IN SELECT sequencename AS object_name FROM pg_sequences WHERE schemaname = 'public'
      LOOP
        BEGIN
          EXECUTE format('ALTER SEQUENCE IF EXISTS public.%I OWNER TO %I', item.object_name, target_role);
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'ALTER SEQUENCE %.% OWNER 跳过：%', 'public', item.object_name, SQLERRM;
        END;
      END LOOP;

      FOR item IN SELECT viewname AS object_name FROM pg_views WHERE schemaname = 'public'
      LOOP
        BEGIN
          EXECUTE format('ALTER VIEW IF EXISTS public.%I OWNER TO %I', item.object_name, target_role);
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'ALTER VIEW %.% OWNER 跳过：%', 'public', item.object_name, SQLERRM;
        END;
      END LOOP;

      FOR item IN
        SELECT p.proname AS function_name, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
      LOOP
        BEGIN
          EXECUTE format(
            'ALTER FUNCTION public.%I(%s) OWNER TO %I',
            item.function_name,
            item.args,
            target_role
          );
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'ALTER FUNCTION %.%(%) OWNER 跳过：%',
            'public',
            item.function_name,
            item.args,
            SQLERRM;
        END;
      END LOOP;

      BEGIN
        EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO %I', target_role);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'GRANT ALL TABLES 失败：%', SQLERRM;
      END;

      BEGIN
        EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO %I', target_role);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'GRANT ALL SEQUENCES 失败：%', SQLERRM;
      END;

      BEGIN
        EXECUTE format('GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO %I', target_role);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'GRANT ALL FUNCTIONS 失败：%', SQLERRM;
      END;

      BEGIN
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO %I', target_role);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'ALTER DEFAULT PRIVILEGES TABLES 跳过：%', SQLERRM;
      END;

      BEGIN
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO %I', target_role);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'ALTER DEFAULT PRIVILEGES SEQUENCES 跳过：%', SQLERRM;
      END;

      BEGIN
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO %I', target_role);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'ALTER DEFAULT PRIVILEGES FUNCTIONS 跳过：%', SQLERRM;
      END;
    END $$;

    -- 历史 PushPlus/微信字段兼容迁移，保持幂等。
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users')
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'pushplus_token'
         ) THEN
        ALTER TABLE users ADD COLUMN pushplus_token VARCHAR(100) DEFAULT NULL;
        RAISE NOTICE '新增 pushplus_token 列成功';
      ELSE
        RAISE NOTICE 'pushplus_token 列已存在或 users 表不存在，跳过';
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'wxpusher_uid'
      ) THEN
        ALTER TABLE users DROP COLUMN wxpusher_uid;
        RAISE NOTICE '移除 wxpusher_uid 列成功';
      ELSE
        RAISE NOTICE 'wxpusher_uid 列不存在，跳过';
      END IF;
    END $$;

    -- 自动荐股闭环字段兼容；如果表尚未创建，由后端 Sequelize sync 负责创建。
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_investment_signals') THEN
        ALTER TABLE ai_investment_signals ADD COLUMN IF NOT EXISTS loop_run_id VARCHAR(80);
        CREATE INDEX IF NOT EXISTS idx_ai_investment_signals_loop_run_id
          ON ai_investment_signals (loop_run_id);
      END IF;

      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'recommendation_trade_outcomes') THEN
        ALTER TABLE recommendation_trade_outcomes ADD COLUMN IF NOT EXISTS loop_run_id VARCHAR(80);
        CREATE INDEX IF NOT EXISTS idx_recommendation_trade_outcomes_loop_run_id
          ON recommendation_trade_outcomes (loop_run_id);
      END IF;

      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'recommendation_loop_policy_snapshots') THEN
        ALTER TABLE recommendation_loop_policy_snapshots ADD COLUMN IF NOT EXISTS loop_run_id VARCHAR(80);
        CREATE INDEX IF NOT EXISTS idx_loop_policy_snapshots_loop_run_id
          ON recommendation_loop_policy_snapshots (loop_run_id);
      END IF;
    END $$;

    -- 量化策略运行策略字段兼容；历史库可能已存在 quant_strategies 但缺少新字段，
    -- 会导致策略注册、策略列表和开盘扫描配置读取失败。
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'task_execution_logs') THEN
        ALTER TABLE task_execution_logs ADD COLUMN IF NOT EXISTS result_summary JSONB NOT NULL DEFAULT '{}'::jsonb;
        UPDATE task_execution_logs SET result_summary = '{}'::jsonb WHERE result_summary IS NULL;
      END IF;

      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'quant_strategies') THEN
        ALTER TABLE quant_strategies ADD COLUMN IF NOT EXISTS execution_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
        ALTER TABLE quant_strategies ADD COLUMN IF NOT EXISTS environment_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
        ALTER TABLE quant_strategies ADD COLUMN IF NOT EXISTS lifecycle_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
        ALTER TABLE quant_strategies ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE quant_strategies ADD COLUMN IF NOT EXISTS display_order INTEGER;
        UPDATE quant_strategies SET execution_policy = '{}'::jsonb WHERE execution_policy IS NULL;
        UPDATE quant_strategies SET environment_policy = '{}'::jsonb WHERE environment_policy IS NULL;
        UPDATE quant_strategies SET lifecycle_policy = '{}'::jsonb WHERE lifecycle_policy IS NULL;
      END IF;
    END $$;
  `;
}

function buildDockerPsqlMigrationCommand(deployConfig, sql) {
  const pg = deployConfig.postgres || {};
  const envArg = pg.password ? `-e PGPASSWORD=${shellQuote(pg.password)} ` : '';
  return `docker exec ${envArg}-i ${shellQuote(pg.docker_container)} psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U ${shellQuote(pg.user)} -d ${shellQuote(pg.database)} << 'END_SQL'\n${sql}\nEND_SQL`;
}

function buildRuntimeSchemaHealthSQL(appDbUser = 'stock_admin') {
  const role = sqlLiteral(appDbUser || 'stock_admin');
  const tables = `ARRAY[${RUNTIME_SCHEMA_TABLES.map(sqlLiteral).join(',')}]::text[]`;
  const criticalTables = `ARRAY[${CRITICAL_RUNTIME_SCHEMA_TABLES.map(sqlLiteral).join(
    ','
  )}]::text[]`;
  const healthCte = `
    expected_tables AS (
      SELECT unnest(${tables}) AS table_name
    ), critical_tables AS (
      SELECT unnest(${criticalTables}) AS table_name
    ), actual_tables AS (
      SELECT c.relname AS table_name, pg_catalog.pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    ), table_health AS (
      SELECT
        e.table_name,
        a.owner,
        a.table_name IS NOT NULL AS exists,
        e.table_name IN (SELECT table_name FROM critical_tables) AS critical,
        CASE WHEN a.table_name IS NULL THEN false ELSE has_table_privilege(${role}, format('public.%I', e.table_name), 'SELECT') END AS can_select,
        CASE WHEN a.table_name IS NULL THEN false ELSE has_table_privilege(${role}, format('public.%I', e.table_name), 'INSERT') END AS can_insert,
        CASE WHEN a.table_name IS NULL THEN false ELSE has_table_privilege(${role}, format('public.%I', e.table_name), 'UPDATE') END AS can_update,
        CASE WHEN a.table_name IS NULL THEN false ELSE has_table_privilege(${role}, format('public.%I', e.table_name), 'DELETE') END AS can_delete
      FROM expected_tables e
      LEFT JOIN actual_tables a ON a.table_name = e.table_name
    ), serial_sequences AS (
      SELECT DISTINCT pg_get_serial_sequence(format('public.%I', e.table_name), c.column_name) AS sequence_name
      FROM expected_tables e
      JOIN information_schema.columns c
        ON c.table_schema = 'public'
       AND c.table_name = e.table_name
      WHERE pg_get_serial_sequence(format('public.%I', e.table_name), c.column_name) IS NOT NULL
    ), sequence_health AS (
      SELECT
        sequence_name,
        has_sequence_privilege(${role}, sequence_name, 'USAGE') AS can_usage,
        has_sequence_privilege(${role}, sequence_name, 'SELECT') AS can_select
      FROM serial_sequences
    ), schema_health AS (
      SELECT
        has_schema_privilege(${role}, 'public', 'USAGE') AS can_usage,
        has_schema_privilege(${role}, 'public', 'CREATE') AS can_create
    ), issues AS (
      SELECT 'critical'::text AS level, 'schema_privilege_gap'::text AS code, 'public schema privilege gap'::text AS message
      FROM schema_health
      WHERE NOT can_usage OR NOT can_create
      UNION ALL
      SELECT CASE WHEN critical THEN 'critical' ELSE 'warning' END,
             CASE WHEN critical THEN 'critical_table_missing' ELSE 'optional_table_missing' END,
             'missing table: ' || table_name
      FROM table_health
      WHERE NOT exists
      UNION ALL
      SELECT CASE WHEN critical THEN 'critical' ELSE 'warning' END,
             CASE WHEN critical THEN 'critical_table_privilege_gap' ELSE 'optional_table_privilege_gap' END,
             'table privilege gap: ' || table_name
      FROM table_health
      WHERE exists AND (NOT can_select OR NOT can_insert OR NOT can_update OR NOT can_delete)
      UNION ALL
      SELECT 'warning',
             'table_owner_mismatch',
             'owner mismatch: ' || table_name || ' owner=' || COALESCE(owner, '')
      FROM table_health
      WHERE exists AND owner IS DISTINCT FROM ${role}
      UNION ALL
      SELECT 'critical',
             'sequence_privilege_gap',
             'sequence privilege gap: ' || sequence_name
      FROM sequence_health
      WHERE NOT can_usage OR NOT can_select
    ), summary AS (
      SELECT
        COUNT(*) FILTER (WHERE level = 'critical') AS critical_issues,
        COUNT(*) FILTER (WHERE level = 'warning') AS warnings
      FROM issues
    )`;

  return `
    CREATE TEMP TABLE runtime_schema_health_result AS
    WITH ${healthCte}
    SELECT
      CASE
        WHEN critical_issues > 0 THEN 'critical'
        WHEN warnings > 0 THEN 'warning'
        ELSE 'healthy'
      END AS status,
      critical_issues,
      warnings
    FROM summary;

    TABLE runtime_schema_health_result;

    DO $$
    DECLARE
      critical_count integer;
      warning_count integer;
    BEGIN
      SELECT critical_issues, warnings
      INTO critical_count, warning_count
      FROM runtime_schema_health_result;

      IF critical_count > 0 THEN
        RAISE EXCEPTION 'Runtime schema health critical issues: %, warnings: %',
          critical_count,
          warning_count;
      END IF;
    END $$;
  `;
}

function buildDockerPsqlHealthCommand(deployConfig, sql) {
  const pg = deployConfig.postgres || {};
  const envArg = pg.password ? `-e PGPASSWORD=${shellQuote(pg.password)} ` : '';
  return `docker exec ${envArg}-i ${shellQuote(pg.docker_container)} psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U ${shellQuote(pg.user)} -d ${shellQuote(pg.database)} << 'END_SQL'\n${sql}\nEND_SQL`;
}

module.exports = {
  buildDockerPsqlMigrationCommand,
  buildDockerPsqlHealthCommand,
  buildRuntimeSchemaHealthSQL,
  buildRuntimeSchemaMigrationSQL,
};
