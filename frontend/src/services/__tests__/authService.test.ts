import { afterEach, describe, expect, jest, test } from '@jest/globals';
import api from '../api';
import { authService } from '../authService';
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

      await expect(authService.logout()).resolves.toBeUndefined();

      expect(post).toHaveBeenCalledWith('/auth/logout');
      for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) {
        expect(localStorage.getItem(key)).toBeNull();
      }
      for (const key of USER_SCOPED_SESSION_STORAGE_KEYS) {
        expect(sessionStorage.getItem(key)).toBeNull();
      }
      expect(errorLog).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0);
    }
  );
});
