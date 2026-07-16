/**
 * Access-token authentication fail-closed regression guard.
 *
 * The historical filename is retained so existing test runners keep finding
 * it. There is intentionally no default-admin behavior left to preserve.
 */
import express, { Request, Response } from 'express';
import request, { Response as SupertestResponse } from 'supertest';
import jwt from 'jsonwebtoken';
import { AuthController } from '../../src/api/controllers/AuthController';
import {
  AUTH_ACCESS_TOKEN_AUDIENCE,
  AUTH_JWT_ISSUER,
  AUTH_REFRESH_TOKEN_AUDIENCE,
  authenticate as authenticateMiddleware,
} from '../../src/middlewares/auth';
import { User } from '../../src/models/User';

const JWT_SECRET = 'auth-fail-closed-regression-test-secret';
const JWT_REFRESH_SECRET = 'auth-fail-closed-refresh-regression-secret';
const INFRASTRUCTURE_ERROR = 'sensitive-database-error-must-not-leak';

const ENTRY_POINTS = [
  { label: 'AuthController', path: '/controller-protected' },
  { label: 'middleware', path: '/middleware-protected' },
] as const;

function buildApp(): express.Express {
  const app = express();
  const authController = new AuthController();
  const protectedHandler = (req: Request, res: Response) => {
    res.json({ reached: true, user: (req as any).user });
  };

  app.get('/controller-protected', authController.authenticate, protectedHandler);
  app.get('/middleware-protected', authenticateMiddleware, protectedHandler);
  return app;
}

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function send(
  app: express.Express,
  path: string,
  authorization?: string
): Promise<SupertestResponse> {
  let pending = request(app).get(path);
  if (authorization !== undefined) {
    pending = pending.set('Authorization', authorization);
  }
  return pending;
}

function assertStopped(
  label: string,
  response: SupertestResponse,
  expectedStatus: 401 | 503,
  forbiddenValues: string[] = []
): void {
  const serializedBody = JSON.stringify(response.body);
  assert(
    `${label} returns ${expectedStatus} without calling next`,
    response.status === expectedStatus && response.body.reached !== true,
    `status=${response.status}, body=${serializedBody}`
  );
  assert(
    `${label} returns a generic error body`,
    forbiddenValues.every(value => value.length === 0 || !serializedBody.includes(value)),
    `body=${serializedBody}`
  );
}

function signAccessToken(
  payload: Record<string, unknown> = {
    user_id: 7,
    username: 'valid-user',
    role: 'analyst',
  },
  expiresIn: number | '1h' = '1h'
): string {
  return jwt.sign({ ...payload, type: 'access' }, JWT_SECRET, {
    algorithm: 'HS256',
    issuer: AUTH_JWT_ISSUER,
    audience: AUTH_ACCESS_TOKEN_AUDIENCE,
    expiresIn,
  });
}

async function main(): Promise<void> {
  const previousJwtSecret = process.env.JWT_SECRET;
  const previousJwtRefreshSecret = process.env.JWT_REFRESH_SECRET;
  const originalFindByPk = User.findByPk;
  const validToken = signAccessToken();

  try {
    process.env.JWT_REFRESH_SECRET = JWT_REFRESH_SECRET;
    // Missing configuration is an infrastructure failure, not an anonymous
    // administrator session. Build and exercise both entry points while the
    // environment is absent because the standalone middleware reads it per request.
    delete process.env.JWT_SECRET;
    (User as any).findByPk = async () => {
      throw new Error(INFRASTRUCTURE_ERROR);
    };
    const missingSecretApp = buildApp();
    for (const entryPoint of ENTRY_POINTS) {
      const missingCredentialResponse = await send(missingSecretApp, entryPoint.path);
      assertStopped(
        `${entryPoint.label} missing Authorization while JWT_SECRET is absent`,
        missingCredentialResponse,
        401,
        [INFRASTRUCTURE_ERROR]
      );
      const response = await send(missingSecretApp, entryPoint.path, `Bearer ${validToken}`);
      assertStopped(`${entryPoint.label} missing JWT_SECRET`, response, 503, [
        validToken,
        INFRASTRUCTURE_ERROR,
      ]);
    }

    process.env.JWT_SECRET = JWT_SECRET;
    const app = buildApp();
    const expiredToken = signAccessToken(undefined, -1);
    const incompleteIdentityToken = signAccessToken({ user_id: 7 });
    const legacyToken = jwt.sign(
      { user_id: 7, username: 'valid-user', role: 'analyst' },
      JWT_SECRET
    );
    const refreshToken = jwt.sign(
      {
        user_id: 7,
        username: 'valid-user',
        role: 'analyst',
        type: 'refresh',
        family_id: '12345678-1234-4234-8234-567812345678',
      },
      JWT_REFRESH_SECRET,
      {
        algorithm: 'HS256',
        issuer: AUTH_JWT_ISSUER,
        audience: AUTH_REFRESH_TOKEN_AUDIENCE,
        jwtid: '87654321-4321-4321-8321-876543218765',
        expiresIn: '1h',
      }
    );

    // Credential parsing and signature/expiry failures must not touch the DB.
    (User as any).findByPk = async () => {
      throw new Error(INFRASTRUCTURE_ERROR);
    };
    const credentialCases = [
      { label: 'missing Authorization' },
      { label: 'malformed scheme', authorization: 'Basic credentials' },
      { label: 'malformed Bearer', authorization: 'Bearer token with-spaces' },
      { label: 'invalid token', authorization: 'Bearer invalid.jwt.token' },
      { label: 'expired token', authorization: `Bearer ${expiredToken}` },
      { label: 'legacy token without type/aud/iss', authorization: `Bearer ${legacyToken}` },
      { label: 'refresh token at access endpoint', authorization: `Bearer ${refreshToken}` },
      {
        label: 'token missing identity claims',
        authorization: `Bearer ${incompleteIdentityToken}`,
      },
    ];
    for (const entryPoint of ENTRY_POINTS) {
      for (const testCase of credentialCases) {
        const response = await send(app, entryPoint.path, testCase.authorization);
        const credential = (testCase.authorization || '').replace(/^[^ ]+ /, '');
        assertStopped(`${entryPoint.label} ${testCase.label}`, response, 401, [
          credential,
          INFRASTRUCTURE_ERROR,
        ]);
      }
    }

    // A correctly signed token still fails closed when its subject is absent.
    (User as any).findByPk = async () => null;
    for (const entryPoint of ENTRY_POINTS) {
      const response = await send(app, entryPoint.path, `Bearer ${validToken}`);
      assertStopped(`${entryPoint.label} unknown user`, response, 401, [validToken]);
    }

    const inactiveUser = {
      id: 7,
      username: 'valid-user',
      email: 'valid-user@example.com',
      role: 'analyst',
      is_active: false,
    };
    (User as any).findByPk = async () => inactiveUser;
    for (const entryPoint of ENTRY_POINTS) {
      const response = await send(app, entryPoint.path, `Bearer ${validToken}`);
      assertStopped(`${entryPoint.label} inactive user`, response, 401, [validToken]);
    }

    // Database availability is distinct from bad credentials and must not leak
    // the exception detail or token into the response.
    (User as any).findByPk = async () => {
      throw new Error(INFRASTRUCTURE_ERROR);
    };
    for (const entryPoint of ENTRY_POINTS) {
      const response = await send(app, entryPoint.path, `Bearer ${validToken}`);
      assertStopped(`${entryPoint.label} user lookup failure`, response, 503, [
        validToken,
        INFRASTRUCTURE_ERROR,
      ]);
    }

    const activeUser = {
      id: 7,
      username: 'valid-user',
      email: 'valid-user@example.com',
      role: 'analyst',
      is_active: true,
    };
    (User as any).findByPk = async (id: number) => (id === activeUser.id ? activeUser : null);
    for (const entryPoint of ENTRY_POINTS) {
      const response = await send(app, entryPoint.path, `Bearer ${validToken}`);
      assert(
        `${entryPoint.label} valid Bearer reaches protected handler`,
        response.status === 200 && response.body.reached === true,
        `status=${response.status}, body=${JSON.stringify(response.body)}`
      );
      assert(
        `${entryPoint.label} valid Bearer preserves database identity`,
        response.body.user?.id === activeUser.id &&
          response.body.user?.username === activeUser.username &&
          response.body.user?.email === activeUser.email &&
          response.body.user?.role === activeUser.role,
        `user=${JSON.stringify(response.body.user)}`
      );
    }
  } finally {
    (User as any).findByPk = originalFindByPk;
    if (previousJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousJwtSecret;
    }
    if (previousJwtRefreshSecret === undefined) {
      delete process.env.JWT_REFRESH_SECRET;
    } else {
      process.env.JWT_REFRESH_SECRET = previousJwtRefreshSecret;
    }
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
