import { afterEach, describe, expect, jest, test } from '@jest/globals';
import api from '../api';
import { AUTH_LOGOUT_PENDING_KEY, authService } from '../authService';
import {
  USER_SCOPED_LOCAL_STORAGE_KEYS,
  USER_SCOPED_SESSION_STORAGE_KEYS,
} from '../../utils/sessionCleanup';

afterEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('authService.logout', () => {
  test.each(['success', 'failure'] as const)(
    'clears every user-scoped key after API %s',
    async outcome => {
      for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) localStorage.setItem(key, 'private');
      for (const key of USER_SCOPED_SESSION_STORAGE_KEYS) sessionStorage.setItem(key, 'private');
      const post = jest.spyOn(api, 'post');
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      if (outcome === 'success') post.mockResolvedValueOnce({} as never);
      else post.mockRejectedValueOnce(new Error('logout transport failed'));

      if (outcome === 'success') {
        await expect(authService.logout()).resolves.toBeUndefined();
      } else {
        await expect(authService.logout()).rejects.toThrow('logout transport failed');
      }

      expect(post).toHaveBeenCalledWith('/auth/logout');
      for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) {
        expect(localStorage.getItem(key)).toBeNull();
      }
      for (const key of USER_SCOPED_SESSION_STORAGE_KEYS) {
        expect(sessionStorage.getItem(key)).toBeNull();
      }
      expect(errorLog).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0);
      expect(localStorage.getItem(AUTH_LOGOUT_PENDING_KEY)).toBe(
        outcome === 'failure' ? '1' : null
      );
    }
  );

  test('retries a pending server-side revocation without restoring user state', async () => {
    localStorage.setItem(AUTH_LOGOUT_PENDING_KEY, '1');
    const post = jest.spyOn(api, 'post').mockResolvedValueOnce({} as never);

    await expect(authService.retryPendingLogout()).resolves.toBe(true);
    expect(post).toHaveBeenCalledWith('/auth/logout');
    expect(localStorage.getItem(AUTH_LOGOUT_PENDING_KEY)).toBeNull();
  });
});

describe.each(['login', 'register'] as const)('authService.%s', operation => {
  test('confirms a pending logout before creating a new refresh session', async () => {
    localStorage.setItem(AUTH_LOGOUT_PENDING_KEY, '1');
    const response = {
      data: {
        success: true,
        data: {
          user: { id: 1, username: 'user', email: 'user@example.com', role: 'user' },
          tokens: { accessToken: 'new-access-token' },
        },
      },
    };
    const post = jest
      .spyOn(api, 'post')
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce(response as never);

    if (operation === 'login') {
      await authService.login({ username: 'user', password: 'password' });
      expect(post).toHaveBeenNthCalledWith(2, '/auth/login', {
        username: 'user',
        password: 'password',
      });
    } else {
      await authService.register({
        username: 'user',
        email: 'user@example.com',
        password: 'password',
      });
      expect(post).toHaveBeenNthCalledWith(2, '/auth/register', {
        username: 'user',
        email: 'user@example.com',
        password: 'password',
      });
    }
    expect(post).toHaveBeenNthCalledWith(1, '/auth/logout');
    expect(localStorage.getItem(AUTH_LOGOUT_PENDING_KEY)).toBeNull();
    expect(localStorage.getItem('token')).toBe('new-access-token');
  });

  test('does not create a new session while an older logout is unconfirmed', async () => {
    localStorage.setItem(AUTH_LOGOUT_PENDING_KEY, '1');
    const post = jest.spyOn(api, 'post').mockRejectedValueOnce(new Error('offline'));

    const request =
      operation === 'login'
        ? authService.login({ username: 'user', password: 'password' })
        : authService.register({
            username: 'user',
            email: 'user@example.com',
            password: 'password',
          });

    await expect(request).rejects.toThrow('Previous logout could not be confirmed');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/auth/logout');
    expect(localStorage.getItem(AUTH_LOGOUT_PENDING_KEY)).toBe('1');
  });
});
