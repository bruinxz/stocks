const { shellQuote } = require('./deploy_config');

function sqlLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function buildRuntimeSchemaMigrationSQL(appDbUser = 'stock_admin') {
  const role = sqlLiteral(appDbUser || 'stock_admin');
  return `
    -- 线上历史库曾由 postgres / stock_admin 混合建表，导致应用启动时无法 ALTER/CREATE。
    -- 这里不改业务数据；优先修复 owner，若维护角色不是 superuser/member，则降级为 grant/create 权限。
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
  `;
}

function buildDockerPsqlMigrationCommand(deployConfig, sql) {
  const pg = deployConfig.postgres || {};
  const envArg = pg.password ? `-e PGPASSWORD=${shellQuote(pg.password)} ` : '';
  return `docker exec ${envArg}-i ${shellQuote(pg.docker_container)} psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U ${shellQuote(pg.user)} -d ${shellQuote(pg.database)} << 'END_SQL'\n${sql}\nEND_SQL`;
}

module.exports = {
  buildDockerPsqlMigrationCommand,
  buildRuntimeSchemaMigrationSQL,
};
