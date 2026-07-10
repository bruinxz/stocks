import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, test } from '@jest/globals';
import api from '../../services/api';
import {
  LOGIN_BYPASS_DESTINATION,
  ProtectedRoute,
  resolveEffectiveViewer,
  resolveLoginBypass,
} from '../authBypassPolicy';

describe('owner-approved login bypass', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/catdesk');
  });

  test('/login resolves to /catdesk', () => {
    expect(resolveLoginBypass('/login')).toBe(LOGIN_BYPASS_DESTINATION);
    expect(resolveLoginBypass('/catdesk')).toBeNull();
  });

  test('protected content renders without a token', () => {
    const markup = renderToStaticMarkup(
      <ProtectedRoute>
        <main data-testid="protected-content">公开研究台</main>
      </ProtectedRoute>
    );

    expect(markup).toContain('data-testid="protected-content"');
    expect(markup).toContain('公开研究台');
  });

  test('a 401 rejection does not redirect the browser to /login', async () => {
    const unauthorized = Object.assign(new Error('unauthorized'), {
      config: { headers: {} },
      response: { status: 401 },
      isAxiosError: true,
    });

    await expect(
      api.get('/protected-test-endpoint', {
        adapter: async () => Promise.reject(unauthorized),
      })
    ).rejects.toBe(unauthorized);

    expect(window.location.pathname).toBe('/catdesk');
  });

  test('an anonymous session receives the Admin fallback identity', () => {
    expect(resolveEffectiveViewer(null, null, 'stale-user')).toEqual({
      displayUsername: 'Admin',
      role: 'admin',
    });
  });
});
