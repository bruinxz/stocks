import { UserController } from '../../src/api/controllers/UserController';
import { sequelize } from '../../src/config/database';
import { AuthRefreshSession } from '../../src/models/AuthRefreshSession';
import { User } from '../../src/models/User';

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

function response() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

async function main(): Promise<void> {
  const originalTransaction = sequelize.transaction;
  const originalFindByPk = User.findByPk;
  const originalFindOne = User.findOne;
  const originalSessionUpdate = AuthRefreshSession.update;
  const revocations: Array<{ values: any; options: any }> = [];
  const user = {
    id: 7,
    email: 'user@example.test',
    role: 'user',
    is_active: true,
    password_hash: 'old-hash',
    async save() {
      return this;
    },
    toJSON() {
      return { id: this.id, email: this.email, role: this.role, is_active: this.is_active };
    },
  };

  try {
    sequelize.transaction = async (...args: any[]) => {
      const callback = args[args.length - 1];
      return callback({ LOCK: { UPDATE: 'UPDATE' } });
    };
    User.findByPk = async (id: unknown) =>
      Number(id) === user.id ? (user as unknown as User) : null;
    User.findOne = async () => null;
    AuthRefreshSession.update = async (values: any, options: any) => {
      revocations.push({ values, options });
      return [1];
    };

    const controller = new UserController();
    const disabled = response();
    await controller.updateUser(
      {
        user: { role: 'admin' },
        params: { id: String(user.id) },
        body: { is_active: false },
      } as any,
      disabled as any,
      (() => undefined) as any
    );
    assert('admin deactivation succeeds', disabled.statusCode === 200);
    assert(
      'deactivation revokes every active refresh session in the transaction',
      revocations[0]?.values?.revocation_reason === 'user_inactive' &&
        revocations[0]?.options?.where?.user_id === user.id &&
        revocations[0]?.options?.where?.revoked_at === null
    );

    const changed = response();
    await controller.changePassword(
      {
        user: { role: 'admin' },
        params: { id: String(user.id) },
        body: { newPassword: 'new-password' },
      } as any,
      changed as any,
      (() => undefined) as any
    );
    assert('admin password change succeeds', changed.statusCode === 200);
    assert(
      'password change revokes every active refresh session',
      revocations[1]?.values?.revocation_reason === 'password_changed' &&
        revocations[1]?.options?.where?.user_id === user.id
    );
  } finally {
    sequelize.transaction = originalTransaction;
    User.findByPk = originalFindByPk;
    User.findOne = originalFindOne;
    AuthRefreshSession.update = originalSessionUpdate;
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('unhandled test error:', error);
  process.exit(1);
});
