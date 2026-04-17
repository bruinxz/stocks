import api from './api';

export interface ScheduledTask {
  id?: number;
  name: string;
  cronExpression: string;
  type: string;
  parameters?: any;
  isActive: boolean;
  lastRunAt?: string;
  lastRunStatus?: string;
}

export const taskService = {
  async getTasks(): Promise<ScheduledTask[]> {
    const response = await api.get('/tasks');
    return response.data.data;
  },

  async createTask(data: ScheduledTask): Promise<ScheduledTask> {
    const response = await api.post('/tasks', data);
    return response.data.data;
  },

  async updateTask(id: number, data: Partial<ScheduledTask>): Promise<ScheduledTask> {
    const response = await api.put(`/tasks/${id}`, data);
    return response.data.data;
  },

  async deleteTask(id: number): Promise<void> {
    await api.delete(`/tasks/${id}`);
  },
};
