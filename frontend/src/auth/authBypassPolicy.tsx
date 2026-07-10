import type { ReactElement } from 'react';

export const LOGIN_BYPASS_DESTINATION = '/catdesk';

interface ViewerLike {
  nickname?: string | null;
  username?: string | null;
  role?: string | null;
}

interface EffectiveViewer {
  displayUsername: string;
  role: string;
}

export function resolveLoginBypass(pathname: string): string | null {
  return pathname === '/login' ? LOGIN_BYPASS_DESTINATION : null;
}

export function resolveEffectiveViewer(
  user: ViewerLike | null | undefined,
  token: string | null,
  storedUsername: string | null
): EffectiveViewer {
  if (!token) {
    return { displayUsername: 'Admin', role: 'admin' };
  }

  return {
    displayUsername: user?.nickname || user?.username || storedUsername || 'Admin',
    role: user?.role || 'admin',
  };
}

export function ProtectedRoute({ children }: { children: ReactElement }) {
  return children;
}
