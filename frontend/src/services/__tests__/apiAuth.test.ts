import { afterEach, describe, expect, jest, test } from '@jest/globals';
import axios from 'axios';
import { AUTH_REFRESH_TIMEOUT_MS, refreshAccessToken } from '../api';

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('access-token refresh single-flight', () => {
  test('one failed flight rejects every waiter, clears user state, and permits a later flight', async () => {
    let rejectRequest: ((reason: Error) => void) | undefined;
    const request = new Promise((_resolve, reject) => {
      rejectRequest = reject;
    });
    const post = jest.spyOn(axios, 'post').mockReturnValue(request as never);
    localStorage.setItem('token', 'expired-token');
    localStorage.setItem('user', '{"id":7}');
    localStorage.setItem('fw_combo_templates_v1', '[{"private":true}]');
    sessionStorage.setItem('criticalAlertModal_acked_v1', '["private-alert"]');

    const first = refreshAccessToken();
    const second = refreshAccessToken();
    expect(second).toBe(first);
    expect(post).toHaveBeenCalledTimes(1);

    rejectRequest?.(new Error('refresh denied'));
    const settled = await Promise.allSettled([first, second]);
    expect(settled.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
    expect(localStorage.getItem('fw_combo_templates_v1')).toBeNull();
    expect(sessionStorage.getItem('criticalAlertModal_acked_v1')).toBeNull();

    post.mockResolvedValueOnce({
      data: { data: { accessToken: 'replacement-token' } },
    });
    await expect(refreshAccessToken()).resolves.toBe('replacement-token');
    expect(post).toHaveBeenCalledTimes(2);
  });

  test('uses a finite axios timeout and aborts a hung transport at the deadline', async () => {
    jest.useFakeTimers();
    const post = jest.spyOn(axios, 'post').mockImplementation((_url, _body, config) => {
      return new Promise((_resolve, reject) => {
        config?.signal?.addEventListener(
          'abort',
          () => {
            const error = new Error('transport aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      });
    });
    localStorage.setItem('token', 'expired-token');

    const refresh = refreshAccessToken();
    expect(post).toHaveBeenCalledWith(
      expect.stringMatching(/\/auth\/refresh$/),
      {},
      expect.objectContaining({
        timeout: AUTH_REFRESH_TIMEOUT_MS,
        signal: expect.any(AbortSignal),
      })
    );
    jest.advanceTimersByTime(AUTH_REFRESH_TIMEOUT_MS);

    await expect(refresh).rejects.toBeInstanceOf(Error);
    expect(localStorage.getItem('token')).toBeNull();
  });

  test('an aborted caller settles without cancelling another waiter on the shared flight', async () => {
    let resolveRequest: ((response: unknown) => void) | undefined;
    const request = new Promise(resolve => {
      resolveRequest = resolve;
    });
    const post = jest.spyOn(axios, 'post').mockReturnValue(request as never);
    const caller = new AbortController();

    const shared = refreshAccessToken();
    const cancelled = refreshAccessToken(caller.signal);
    caller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    resolveRequest?.({ data: { data: { accessToken: 'shared-token' } } });
    await expect(shared).resolves.toBe('shared-token');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
