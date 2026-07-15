import type { ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

export const LOGIN_PATH = '/login';

interface ViewerLike {
  nickname?: string | null;
  username?: string | null;
  role?: string | null;
}

interface EffectiveViewer {
  displayUsername: string;
  role: string;
}

export function resolveAuthRedirect(pathname: string, token: string | null): string | null {
  if (pathname === LOGIN_PATH) return token ? '/catdesk' : null;
  return token ? null : LOGIN_PATH;
}

export function resolveEffectiveViewer(
  user: ViewerLike | null | undefined,
  token: string | null,
  storedUsername: string | null
): EffectiveViewer {
  if (!token) {
    return { displayUsername: '访客', role: 'guest' };
  }

  return {
    displayUsername: user?.nickname || user?.username || storedUsername || '用户',
    role: user?.role || 'user',
  };
}

export function ProtectedRoute({ children }: { children: ReactElement }) {
  const location = useLocation();
  const token = localStorage.getItem('token');
  return token ? children : <Navigate to={LOGIN_PATH} replace state={{ from: location }} />;
}
