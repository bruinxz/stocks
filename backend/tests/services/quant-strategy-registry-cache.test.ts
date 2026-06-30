/**
 * QuantStrategyService registry sync contract.
 *
 * The simplified workspace reads /api/quant/strategies and /api/quant/runtime-health
 * during bootstrap. Those reads must not trigger a full registry write pass on
 * every request, especially when local dev connects to the remote dev database
 * through an SSH tunnel.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

console.log('\n## QuantStrategyService registry sync cache contract');

const source = readFileSync(
  join(process.cwd(), 'src/quant/engine/internal/QuantStrategyService.ts'),
  'utf8'
);

assert('service tracks in-flight registry sync', source.includes('registrySyncPromise'));
assert('service records last successful registry sync time', source.includes('registrySyncedAt'));
assert('service has a bounded registry sync TTL', source.includes('registrySyncTtlMs'));
assert(
  'listStrategies uses cached registry sync gate',
  /async listStrategies\(\)\s*\{\s*await this\.ensureRegistrySynced\(\)/.test(source)
);
assert(
  'resolveStrategyKeys returns explicit keys before registry sync',
  (() => {
    const body = source.match(/async resolveStrategyKeys[\s\S]*?\n  \}/)?.[0] || '';
    return (
      body.indexOf('const requested = normalizeStrategyKeys(strategy_keys);') >= 0 &&
      body.indexOf('if (requested.length > 0) return requested;') >
        body.indexOf('const requested = normalizeStrategyKeys(strategy_keys);') &&
      body.indexOf('await this.ensureRegistrySynced()') >
        body.indexOf('if (requested.length > 0) return requested;')
    );
  })()
);
assert(
  'getDefaultParamsByStrategy avoids full registry sync for explicit keys',
  /const explicitKeys = normalizeStrategyKeys\(strategy_keys\);[\s\S]*?const keys = explicitKeys\.length \? explicitKeys : await this\.resolveStrategyKeys\(strategy_keys\);/.test(
    source
  )
);
assert(
  'explicit syncRegistry still performs the write pass',
  /async syncRegistry\(\)\s*\{[\s\S]{0,260}?this\.runRegistrySync\(\)/.test(source)
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
