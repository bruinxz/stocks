import { QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import {
  CRITICAL_RUNTIME_SCHEMA_TABLES,
  RUNTIME_SCHEMA_TABLES,
} from '../constants/runtimeSchemaTables';

type RuntimeSchemaStatus = 'healthy' | 'warning' | 'critical';

type RuntimeSchemaIssue = {
  level: 'warning' | 'critical';
  code: string;
  message: string;
  table_name?: string;
  sequence_name?: string;
};

const sqlLiteral = (value: any): string => `'${String(value ?? '').replace(/'/g, "''")}'`;

class RuntimeSchemaHealthService {
  async getHealth() {
    const appRole = process.env.RUNTIME_SCHEMA_APP_ROLE || process.env.DB_USER || 'stock_admin';
    const rows = await sequelize.query<{ health: any }>(this.buildHealthSql(appRole), {
      type: QueryTypes.SELECT,
    });
    return this.summarize(rows[0]?.health || {}, appRole);
  }

  private buildHealthSql(appRole: string): string {
    const expectedTables = `ARRAY[${RUNTIME_SCHEMA_TABLES.map(sqlLiteral).join(',')}]::text[]`;
    const criticalTables = `ARRAY[${CRITICAL_RUNTIME_SCHEMA_TABLES.map(sqlLiteral).join(
      ','
    )}]::text[]`;
    const role = sqlLiteral(appRole);

    return `
      WITH expected_tables AS (
        SELECT unnest(${expectedTables}) AS table_name
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
      )
      SELECT json_build_object(
        'checked_at', now(),
        'database', current_database(),
        'current_user', current_user,
        'app_role', ${role},
        'schema', (SELECT row_to_json(schema_health) FROM schema_health),
        'tables', COALESCE((SELECT json_agg(table_health ORDER BY critical DESC, table_name) FROM table_health), '[]'::json),
        'sequences', COALESCE((SELECT json_agg(sequence_health ORDER BY sequence_name) FROM sequence_health), '[]'::json)
      ) AS health;
    `;
  }

  private summarize(raw: any, appRole: string) {
    const tables = Array.isArray(raw?.tables) ? raw.tables : [];
    const sequences = Array.isArray(raw?.sequences) ? raw.sequences : [];
    const schema = raw?.schema || {};
    const issues: RuntimeSchemaIssue[] = [];

    for (const table of tables) {
      const tableName = table.table_name;
      const critical = Boolean(table.critical);
      if (!table.exists) {
        issues.push({
          level: critical ? 'critical' : 'warning',
          code: critical ? 'critical_table_missing' : 'optional_table_missing',
          table_name: tableName,
          message: `${critical ? '关键' : '可选'}运行表缺失：${tableName}`,
        });
        continue;
      }

      const missingPrivileges = ['select', 'insert', 'update', 'delete'].filter(
        privilege => !table[`can_${privilege}`]
      );
      if (missingPrivileges.length > 0) {
        issues.push({
          level: critical ? 'critical' : 'warning',
          code: critical ? 'critical_table_privilege_gap' : 'optional_table_privilege_gap',
          table_name: tableName,
          message: `${critical ? '关键' : '可选'}运行表权限不足：${tableName} 缺少 ${missingPrivileges
            .map(item => item.toUpperCase())
            .join('/')}`,
        });
      }

      if (table.owner && table.owner !== appRole) {
        issues.push({
          level: 'warning',
          code: 'table_owner_mismatch',
          table_name: tableName,
          message: `运行表 owner 不是应用角色：${tableName} owner=${table.owner} app_role=${appRole}`,
        });
      }
    }

    const schemaGaps = ['usage', 'create'].filter(privilege => !schema[`can_${privilege}`]);
    if (schemaGaps.length > 0) {
      issues.push({
        level: 'critical',
        code: 'schema_privilege_gap',
        message: `public schema 缺少 ${schemaGaps.map(item => item.toUpperCase()).join('/')} 权限`,
      });
    }

    for (const sequence of sequences) {
      const missingPrivileges = ['usage', 'select'].filter(
        privilege => !sequence[`can_${privilege}`]
      );
      if (missingPrivileges.length > 0) {
        issues.push({
          level: 'critical',
          code: 'sequence_privilege_gap',
          sequence_name: sequence.sequence_name,
          message: `自增序列权限不足：${sequence.sequence_name} 缺少 ${missingPrivileges
            .map(item => item.toUpperCase())
            .join('/')}`,
        });
      }
    }

    const criticalIssues = issues.filter(issue => issue.level === 'critical').length;
    const warnings = issues.filter(issue => issue.level === 'warning').length;
    const status: RuntimeSchemaStatus =
      criticalIssues > 0 ? 'critical' : warnings > 0 ? 'warning' : 'healthy';

    return {
      generated_at: new Date().toISOString(),
      checked_at: raw?.checked_at,
      database: raw?.database,
      current_user: raw?.current_user,
      app_role: appRole,
      status,
      summary: {
        expected_tables: tables.length,
        existing_tables: tables.filter((item: any) => item.exists).length,
        critical_issues: criticalIssues,
        warnings,
        missing_tables: tables.filter((item: any) => !item.exists).length,
        privilege_gaps: issues.filter(issue => issue.code.includes('privilege_gap')).length,
        owner_mismatches: issues.filter(issue => issue.code === 'table_owner_mismatch').length,
        sequence_gaps: issues.filter(issue => issue.code === 'sequence_privilege_gap').length,
      },
      schema,
      tables,
      sequences,
      issues,
      remediation: {
        command_hint:
          '运行 scripts/deployment/runtime_schema_migration.js 对应的数据库迁移，或在生产容器内执行 GRANT/ALTER OWNER 修复 public schema、表和序列权限。',
        grant_sql: [
          `GRANT USAGE, CREATE ON SCHEMA public TO ${appRole};`,
          `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${appRole};`,
          `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${appRole};`,
        ],
      },
    };
  }
}

export const runtimeSchemaHealthService = new RuntimeSchemaHealthService();
