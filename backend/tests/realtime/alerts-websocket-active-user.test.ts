import jwt from 'jsonwebtoken';

import {
  AUTH_ACCESS_TOKEN_AUDIENCE,
  AUTH_JWT_ISSUER,
} from '../../src/middlewares/auth';
import { User } from '../../src/models/User';
import {
  resolveActiveAlertsUser,
  verifyAlertsToken,
} from '../../src/realtime/alertsWebSocketServer';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}`);
  }
}

async function main(): Promise<void> {
  const secret = 'alerts-active-user-test-access-secret';
  const token = jwt.sign(
    { user_id: 7, username: 'active', role: 'analyst', type: 'access' },
    secret,
    {
      algorithm: 'HS256',
      issuer: AUTH_JWT_ISSUER,
      audience: AUTH_ACCESS_TOKEN_AUDIENCE,
      expiresIn: '5m',
    }
  );
  const verified = verifyAlertsToken(token, secret);
  assert(
    'strict WebSocket identity retains a finite access-token expiry',
    Boolean(verified && verified.expires_at_ms > Date.now())
  );

  const originalFindByPk = User.findByPk;
  try {
    User.findByPk = async () => ({ id: 7, is_active: true } as unknown as User);
    assert('active database user may upgrade', await resolveActiveAlertsUser(7));
    User.findByPk = async () => ({ id: 7, is_active: false } as unknown as User);
    assert('disabled database user is denied', !(await resolveActiveAlertsUser(7)));
    User.findByPk = async () => null;
    assert('deleted database user is denied', !(await resolveActiveAlertsUser(7)));
    User.findByPk = async () => {
      throw new Error('sensitive-database-detail');
    };
    assert('database lookup failure fails closed', !(await resolveActiveAlertsUser(7)));
  } finally {
    User.findByPk = originalFindByPk;
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(() => process.exit(1));
