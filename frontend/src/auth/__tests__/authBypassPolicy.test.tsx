import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import axios from 'axios';
import api from '../../services/api';
import {
  LOGIN_PATH,
  ProtectedRoute,
  resolveAuthRedirect,
  resolveEffectiveViewer,
} from '../authBypassPolicy';

describe('fail-closed frontend authentication policy', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/catdesk');
    jest.restoreAllMocks();
  });

  test('anonymous routes redirect to login while authenticated login redirects to CatDesk', () => {
    expect(resolveAuthRedirect('/login', null)).toBeNull();
    expect(resolveAuthRedirect('/catdesk', null)).toBe(LOGIN_PATH);
    expect(resolveAuthRedirect('/login', 'token')).toBe('/catdesk');
    expect(resolveAuthRedirect('/catdesk', 'token')).toBeNull();
  });

  test('protected content requires a token and anonymous identity is never admin', () => {
    const anonymous = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/protected']}>
        <ProtectedRoute>
          <main data-testid="protected-content">受保护研究台</main>
        </ProtectedRoute>
      </MemoryRouter>
    );
    expect(anonymous).not.toContain('protected-content');
    expect(resolveEffectiveViewer(null, null, 'stale-user')).toEqual({
      displayUsername: '访客',
      role: 'guest',
    });

    localStorage.setItem('token', 'valid-token');
    const authenticated = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/protected']}>
        <ProtectedRoute>
          <main data-testid="protected-content">受保护研究台</main>
        </ProtectedRoute>
      </MemoryRouter>
    );
    expect(authenticated).toContain('protected-content');
  });

  test('a 401 refreshes once and retries the original Axios request', async () => {
    localStorage.setItem('token', 'expired-token');
    const refresh = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { success: true, data: { accessToken: 'refreshed-token' } },
    });
    let attempts = 0;
    const result = await api.get('/protected-test-endpoint', {
      adapter: async config => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('unauthorized'), {
            config,
            response: { status: 401 },
            isAxiosError: true,
          });
        }
        return {
          data: { ok: true },
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        };
      },
    });

    expect(result.data).toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('token')).toBe('refreshed-token');
    expect(window.location.pathname).toBe('/catdesk');
  });

  test('refresh failure clears session and returns to login', async () => {
    localStorage.setItem('token', 'expired-token');
    localStorage.setItem('user', '{"id":7}');
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('refresh rejected'));
    const unauthorized = Object.assign(new Error('unauthorized'), {
      response: { status: 401 },
      isAxiosError: true,
    });

    await expect(
      api.get('/protected-test-endpoint', {
        adapter: async config => Promise.reject(Object.assign(unauthorized, { config })),
      })
    ).rejects.toBe(unauthorized);

    expect(window.location.pathname).toBe('/login');
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
  });
});
