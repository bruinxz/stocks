/**
 * Owner login-removal regression guard.
 *
 * Exercises both authentication entry points used by backend routes and proves
 * that missing or invalid credentials reach the protected handler as admin.
 */
import express, { Request, Response } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { AuthController } from '../../src/api/controllers/AuthController';
import { authenticate as authenticateMiddleware } from '../../src/middlewares/auth';
import { User } from '../../src/models/User';

type CanonicalAdmin = {
  id: number;
  username: string;
  role: string;
};

const EXPECTED_ADMIN: CanonicalAdmin = {
  id: 1,
  username: 'admin',
  role: 'admin',
};

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

function isCanonicalAdmin(value: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(EXPECTED_ADMIN);
}

async function main(): Promise<void> {
  const previousJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'auth-default-admin-regression-test-secret';

  try {
    const app = buildApp();
    const cases = [
      { label: 'AuthController missing Authorization', path: '/controller-protected' },
      {
        label: 'AuthController invalid token',
        path: '/controller-protected',
        authorization: 'Bearer invalid.jwt.token',
      },
      { label: 'middleware missing Authorization', path: '/middleware-protected' },
      {
        label: 'middleware invalid token',
        path: '/middleware-protected',
        authorization: 'Bearer invalid.jwt.token',
      },
    ];

    for (const testCase of cases) {
      let pending = request(app).get(testCase.path);
      if (testCase.authorization) {
        pending = pending.set('Authorization', testCase.authorization);
      }
      const response = await pending;

      assert(
        `${testCase.label} reaches protected handler`,
        response.status === 200 && response.body.reached === true
      );
      assert(
        `${testCase.label} injects canonical admin`,
        isCanonicalAdmin(response.body.user),
        `got=${JSON.stringify(response.body.user)}`
      );
    }

    const originalFindByPk = User.findByPk;
    const validToken = jwt.sign(
      { user_id: 7, username: 'valid-user', role: 'analyst' },
      process.env.JWT_SECRET as string
    );
    const sequelizeUser = {
      id: 7,
      username: 'valid-user',
      role: 'analyst',
      is_active: true,
    };
    (User as any).findByPk = async (id: number) => (id === 7 ? sequelizeUser : null);
    try {
      const validResponse = await request(app)
        .get('/controller-protected')
        .set('Authorization', `Bearer ${validToken}`);
      assert('AuthController valid token reaches protected handler', validResponse.status === 200);
      assert(
        'AuthController valid token preserves Sequelize user object',
        JSON.stringify(validResponse.body.user) === JSON.stringify(sequelizeUser),
        `got=${JSON.stringify(validResponse.body.user)}`
      );
    } finally {
      (User as any).findByPk = originalFindByPk;
    }
  } finally {
    if (previousJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousJwtSecret;
    }
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
