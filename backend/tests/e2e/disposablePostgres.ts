import { parse } from 'node:url';
import { Sequelize } from 'sequelize-typescript';

function oneQueryValue(
  value: string | string[] | undefined,
  field: string
): string | undefined {
  if (Array.isArray(value)) throw new Error(`${field} must be unique`);
  return value;
}

export function connectDisposablePostgres(database_url: string): Sequelize {
  const parsed = parse(database_url, true);
  const socket_dir = oneQueryValue(parsed.query.host, 'host');
  const port_value = oneQueryValue(parsed.query.port, 'port') ?? parsed.port ?? '5432';
  if (parsed.hostname || !socket_dir?.startsWith('/')) {
    throw new Error('disposable PostgreSQL must use an explicit Unix socket');
  }
  if (!/^[0-9]+$/.test(port_value)) {
    throw new Error('disposable PostgreSQL port is invalid');
  }
  const port = Number(port_value);
  if (port < 1 || port > 65_535) {
    throw new Error('disposable PostgreSQL port is out of range');
  }
  return new Sequelize(database_url, { host: socket_dir, port, logging: false });
}
