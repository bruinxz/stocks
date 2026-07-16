import { createHash } from 'crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request, { Response as SupertestResponse } from 'supertest';
import jwt, { JwtPayload } from 'jsonwebtoken';

const ACCESS_SECRET = 'auth-route-access-secret-that-is-long-and-distinct';
const REFRESH_SECRET = 'auth-route-refresh-secret-that-is-long-and-distinct';
const SENSITIVE_ERROR = 'database-host-and-credential-must-not-leak';
const DEFAULT_ADMIN_TEST_PASSWORD = ['correct', 'password'].join('-');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = ACCESS_SECRET;
process.env.JWT_REFRESH_SECRET = REFRESH_SECRET;
process.env.ENABLE_SECURE_COOKIE = 'false';
process.env.DEFAULT_ADMIN_AUTO_LOGIN = 'true';
process.env.DEFAULT_ADMIN_USERNAME = 'route-user';
process.env.DEFAULT_ADMIN_PASSWORD = DEFAULT_ADMIN_TEST_PASSWORD; // gitleaks:allow -- synthetic test credential

// Runtime requires intentionally follow env setup because auth.routes creates
// its controller singleton at module load.
const { sequelize } = require('../../src/config/database');
const { User } = require('../../src/models/User');
const { AuthRefreshSession } = require('../../src/models/AuthRefreshSession');
const { AuthController } = require('../../src/api/controllers/AuthController');
const authRoutes = require('../../src/api/routes/auth.routes').default;
const {
  AUTH_ACCESS_TOKEN_AUDIENCE,
  AUTH_JWT_ISSUER,
  AUTH_REFRESH_TOKEN_AUDIENCE,
} = require('../../src/middlewares/auth');

interface FakeSession {
  [key: string]: any;
  update(values: Record<string, unknown>): Promise<FakeSession>;
}

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function refreshTokenFrom(response: SupertestResponse): string {
  const header = response.headers['set-cookie'];
  const cookie = Array.isArray(header) ? header[0] : header;
  const matched = typeof cookie === 'string' ? /^refreshToken=([^;]+)/.exec(cookie) : null;
  return matched ? decodeURIComponent(matched[1]) : '';
}

function cookieHeader(response: SupertestResponse): string {
  const header = response.headers['set-cookie'];
  return Array.isArray(header) ? header.join('\n') : String(header || '');
}

async function main(): Promise<void> {
  const originalTransaction = sequelize.transaction;
  const originalUserFindOne = User.findOne;
  const originalUserFindByPk = User.findByPk;
  const originalUserCreate = User.create;
  const originalSessionFindOne = AuthRefreshSession.findOne;
  const originalSessionCreate = AuthRefreshSession.create;
  const originalSessionUpdate = AuthRefreshSession.update;
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
    ENABLE_SECURE_COOKIE: process.env.ENABLE_SECURE_COOKIE,
    DEFAULT_ADMIN_AUTO_LOGIN: process.env.DEFAULT_ADMIN_AUTO_LOGIN,
    DEFAULT_ADMIN_USERNAME: process.env.DEFAULT_ADMIN_USERNAME,
    DEFAULT_ADMIN_PASSWORD: process.env.DEFAULT_ADMIN_PASSWORD,
  };

  const user = {
    id: 7,
    username: 'route-user',
    email: 'route-user@example.com',
    role: 'admin',
    is_active: true,
    validatePassword: async (password: string) => password === DEFAULT_ADMIN_TEST_PASSWORD,
    toJSON() {
      return {
        id: this.id,
        username: this.username,
        email: this.email,
        role: this.role,
        is_active: this.is_active,
      };
    },
  };
  const sessions: FakeSession[] = [];

  try {
    sequelize.transaction = async (...args: any[]) => {
      const callback = args[args.length - 1];
      return callback({ LOCK: { UPDATE: 'UPDATE' } });
    };
    User.findOne = async (options: any) => (options?.where?.username ? user : null);
    User.findByPk = async (id: number) => (id === user.id ? user : null);
    User.create = async (values: any) => ({ ...user, ...values, id: 8 });
    AuthRefreshSession.create = async (values: any) => {
      const row: FakeSession = {
        ...values,
        async update(changes: Record<string, unknown>) {
          Object.assign(this, changes);
          return this;
        },
      };
      sessions.push(row);
      return row;
    };
    AuthRefreshSession.findOne = async (options: any) =>
      sessions.find(session => session.jti === options?.where?.jti) || null;
    AuthRefreshSession.update = async (values: any, options: any) => {
      let count = 0;
      for (const session of sessions) {
        if (
          session.family_id === options?.where?.family_id &&
          session.revoked_at === options?.where?.revoked_at
        ) {
          Object.assign(session, values);
          count += 1;
        }
      }
      return [count];
    };

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRoutes);

    const defaultLogin = await request(app).post('/api/auth/default-login').send({});
    assert('enabled default administrator login succeeds', defaultLogin.status === 200);
    assert(
      'default administrator login returns the configured account',
      defaultLogin.body.data.user.username === user.username
    );
    assert('default administrator login creates one server session', sessions.length === 1);
    sessions.length = 0;

    process.env.DEFAULT_ADMIN_AUTO_LOGIN = 'false';
    const disabledDefaultLogin = await request(app).post('/api/auth/default-login').send({});
    assert(
      'disabled default administrator login is not exposed',
      disabledDefaultLogin.status === 404
    );
    process.env.DEFAULT_ADMIN_AUTO_LOGIN = 'true';

    const registration = await request(app).post('/api/auth/register').send({
      username: 'registered-user',
      email: 'registered-user@example.com',
      password: DEFAULT_ADMIN_TEST_PASSWORD, // gitleaks:allow -- synthetic test credential
    });
    assert('registration creates a server session', registration.status === 201);
    assert('registration persists one hashed refresh session', sessions.length === 1);
    sessions.length = 0;

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: user.username, password: DEFAULT_ADMIN_TEST_PASSWORD }); // gitleaks:allow -- synthetic test credential
    assert('login succeeds', login.status === 200, JSON.stringify(login.body));
    const firstRefreshToken = refreshTokenFrom(login);
    assert('login sets refresh cookie', firstRefreshToken.length > 0);
    assert('development opt-out cookie is HttpOnly', /HttpOnly/i.test(cookieHeader(login)));
    assert('development opt-out cookie is not Secure', !/;\s*Secure/i.test(cookieHeader(login)));
    assert('one server session is created', sessions.length === 1);
    assert(
      'only SHA-256 is persisted',
      sessions[0].token_hash ===
        createHash('sha256').update(firstRefreshToken, 'utf8').digest('hex')
    );
    assert(
      'raw refresh token is absent from persisted values',
      !Object.keys(sessions[0]).some(key => /^(refresh_)?token$/.test(key))
    );
    const bodyOnlyRefresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: firstRefreshToken });
    assert('refresh token body fallback is forbidden', bodyOnlyRefresh.status === 400);

    const accessPayload = jwt.verify(login.body.data.tokens.accessToken, ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: AUTH_JWT_ISSUER,
      audience: AUTH_ACCESS_TOKEN_AUDIENCE,
    }) as JwtPayload;
    assert(
      'access JWT has strict type/aud/iss',
      accessPayload.type === 'access' &&
        accessPayload.aud === AUTH_ACCESS_TOKEN_AUDIENCE &&
        accessPayload.iss === AUTH_JWT_ISSUER
    );

    const refreshPayload = jwt.verify(firstRefreshToken, REFRESH_SECRET, {
      algorithms: ['HS256'],
      issuer: AUTH_JWT_ISSUER,
      audience: AUTH_REFRESH_TOKEN_AUDIENCE,
    }) as JwtPayload;
    assert(
      'refresh JWT has strict type/aud/iss and family pins',
      refreshPayload.type === 'refresh' &&
        refreshPayload.aud === AUTH_REFRESH_TOKEN_AUDIENCE &&
        refreshPayload.iss === AUTH_JWT_ISSUER &&
        typeof refreshPayload.jti === 'string' &&
        typeof refreshPayload.family_id === 'string'
    );

    const rotated = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${firstRefreshToken}`)
      .send({});
    const secondRefreshToken = refreshTokenFrom(rotated);
    assert('refresh rotation succeeds', rotated.status === 200, JSON.stringify(rotated.body));
    assert('rotation issues a distinct refresh token', secondRefreshToken !== firstRefreshToken);
    const rotatedRefreshPayload = jwt.verify(secondRefreshToken, REFRESH_SECRET, {
      algorithms: ['HS256'],
      issuer: AUTH_JWT_ISSUER,
      audience: AUTH_REFRESH_TOKEN_AUDIENCE,
    }) as JwtPayload;
    assert(
      'rotation preserves the absolute refresh-family expiry',
      rotatedRefreshPayload.exp === refreshPayload.exp
    );
    assert(
      'rotation revokes old and creates same-family successor',
      sessions.length === 2 &&
        sessions[0].revocation_reason === 'rotated' &&
        sessions[0].replaced_by_jti === sessions[1].jti &&
        sessions[0].family_id === sessions[1].family_id &&
        sessions[1].revoked_at === null
    );

    const reused = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${firstRefreshToken}`)
      .send({});
    assert('old refresh token reuse is rejected', reused.status === 401);
    assert(
      'reuse revokes the active family successor',
      sessions[1].revoked_at instanceof Date && sessions[1].revocation_reason === 'reuse_detected'
    );

    const secondLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: user.username, password: DEFAULT_ADMIN_TEST_PASSWORD }); // gitleaks:allow -- synthetic test credential
    const logoutToken = refreshTokenFrom(secondLogin);
    const logoutSession = sessions[sessions.length - 1];
    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `refreshToken=${logoutToken}`)
      .send({});
    assert('logout works without a live access token', logout.status === 200);
    assert(
      'logout revokes server-side family',
      logoutSession.revoked_at instanceof Date && logoutSession.revocation_reason === 'logout'
    );

    const missingRowLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: user.username, password: DEFAULT_ADMIN_TEST_PASSWORD }); // gitleaks:allow -- synthetic test credential
    const missingRowToken = refreshTokenFrom(missingRowLogin);
    const survivingFamilyRow = sessions[sessions.length - 1];
    survivingFamilyRow.jti = '33333333-3333-4333-8333-333333333333';
    const missingRowLogout = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `refreshToken=${missingRowToken}`)
      .send({});
    assert('logout tolerates a missing exact jti row', missingRowLogout.status === 200);
    assert(
      'signed family claim still revokes surviving sessions when exact jti is missing',
      survivingFamilyRow.revoked_at instanceof Date &&
        survivingFamilyRow.revocation_reason === 'logout'
    );

    const retryableLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: user.username, password: DEFAULT_ADMIN_TEST_PASSWORD }); // gitleaks:allow -- synthetic test credential
    const retryableToken = refreshTokenFrom(retryableLogin);

    sequelize.transaction = async () => {
      throw new Error(SENSITIVE_ERROR);
    };
    const refreshDatabaseFailure = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${retryableToken}`)
      .send({});
    assert('refresh database failure fails closed', refreshDatabaseFailure.status === 503);
    assert(
      'refresh 503 preserves cookie for a later revoke/retry',
      !cookieHeader(refreshDatabaseFailure).includes('refreshToken=;')
    );
    const logoutDatabaseFailure = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `refreshToken=${retryableToken}`)
      .send({});
    assert(
      'logout database failure reports unconfirmed revocation',
      logoutDatabaseFailure.status === 503
    );
    assert(
      'logout 503 preserves cookie for pending revocation retry',
      !cookieHeader(logoutDatabaseFailure).includes('refreshToken=;')
    );
    const databaseFailure = await request(app)
      .post('/api/auth/login')
      .send({ username: user.username, password: DEFAULT_ADMIN_TEST_PASSWORD }); // gitleaks:allow -- synthetic test credential
    assert('session database failure fails closed', databaseFailure.status === 503);
    assert(
      'database failure response is redacted',
      !JSON.stringify(databaseFailure.body).includes(SENSITIVE_ERROR)
    );
    assert('database failure does not issue a cookie', refreshTokenFrom(databaseFailure) === '');

    sequelize.transaction = originalTransaction;
    process.env.JWT_REFRESH_SECRET = ACCESS_SECRET;
    const sharedSecretController = new AuthController();
    const sharedSecretApp = express();
    sharedSecretApp.use(express.json());
    sharedSecretApp.post('/login', sharedSecretController.login);
    const sharedSecret = await request(sharedSecretApp)
      .post('/login')
      .send({ username: user.username, password: DEFAULT_ADMIN_TEST_PASSWORD }); // gitleaks:allow -- synthetic test credential
    assert('shared access/refresh secret is rejected', sharedSecret.status === 503);

    process.env.NODE_ENV = 'production';
    process.env.JWT_REFRESH_SECRET = REFRESH_SECRET;
    process.env.ENABLE_SECURE_COOKIE = 'false';
    sequelize.transaction = async (...args: any[]) => {
      const callback = args[args.length - 1];
      return callback({ LOCK: { UPDATE: 'UPDATE' } });
    };
    const productionController = new AuthController();
    const productionApp = express();
    productionApp.use(express.json());
    productionApp.post('/login', productionController.login);
    const productionLogin = await request(productionApp)
      .post('/login')
      .send({ username: user.username, password: DEFAULT_ADMIN_TEST_PASSWORD }); // gitleaks:allow -- synthetic test credential
    assert('production login succeeds with session persistence', productionLogin.status === 200);
    assert(
      'production cookie remains Secure even when env says false',
      /;\s*Secure/i.test(cookieHeader(productionLogin))
    );
  } finally {
    sequelize.transaction = originalTransaction;
    User.findOne = originalUserFindOne;
    User.findByPk = originalUserFindByPk;
    User.create = originalUserCreate;
    AuthRefreshSession.findOne = originalSessionFindOne;
    AuthRefreshSession.create = originalSessionCreate;
    AuthRefreshSession.update = originalSessionUpdate;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled auth refresh session test error:', error);
  process.exit(1);
});
