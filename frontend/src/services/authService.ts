import api from './api';

export interface LoginRequest {
  username: string;
  password: string;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
}

export interface AuthResponse {
  success: boolean;
  data: {
    user: {
      id: number;
      username: string;
      email: string;
      role: string;
      nickname?: string;
      phone?: string;
      avatar_url?: string;
    };
    tokens?: {
      accessToken: string;
      refreshToken?: string; // Optional for backwards compatibility
    };
    token?: string; // 兼容旧逻辑
  };
  message?: string;
}

export const authService = {
  async login(credentials: LoginRequest): Promise<AuthResponse> {
    const response = await api.post<AuthResponse>('/auth/login', credentials);
    const data = response.data.data;
    if (response.data.success && data) {
      if (data.tokens) {
        localStorage.setItem('token', data.tokens.accessToken);
      } else if (data.token) {
        localStorage.setItem('token', data.token);
      }
      localStorage.setItem('user', JSON.stringify(data.user));
    }
    return response.data;
  },

  async register(userData: RegisterRequest): Promise<AuthResponse> {
    const response = await api.post<AuthResponse>('/auth/register', userData);
    const data = response.data.data;
    if (response.data.success && data) {
      if (data.tokens) {
        localStorage.setItem('token', data.tokens.accessToken);
      } else if (data.token) {
        localStorage.setItem('token', data.token);
      }
      localStorage.setItem('user', JSON.stringify(data.user));
    }
    return response.data;
  },

  async logout(): Promise<void> {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      console.error('Logout API failed', error);
    } finally {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('username');
    }
  },

  async getCurrentUser() {
    const token = localStorage.getItem('token');
    if (!token) return null;
    try {
      const response = await api.get('/auth/profile');
      return response.data;
    } catch (error) {
      return null;
    }
  },

  async updateProfile(profileData: { nickname?: string; phone?: string; avatar_url?: string }) {
    const response = await api.put('/auth/profile', profileData);
    if (response.data.success) {
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      localStorage.setItem('user', JSON.stringify({ ...user, ...response.data.data.user }));
    }
    return response.data;
  },

  async uploadAvatar(file: File) {
    const formData = new FormData();
    formData.append('avatar', file);
    const response = await api.post('/auth/avatar', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    if (response.data.success) {
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      localStorage.setItem('user', JSON.stringify({ ...user, ...response.data.data.user }));
    }
    return response.data;
  },
};
