import api from './api';

export interface ScheduledTask {
  id?: number;
  name: string;
  cron_expression: string;
  type: string;
  parameters?: any;
  is_active: boolean;
  last_run_at?: string;
  last_run_status?: string;
}

export interface TaskExecutionLog {
  id: number;
  task_id: number;
  task_name: string;
  status: string;
  total_items: number;
  completed_items: number;
  failed_items: number;
  error_message: string;
  started_at: string;
  completed_at: string;
}

export const taskService = {
  async getTasks(): Promise<ScheduledTask[]> {
    const response = await api.get('/tasks');
    return response.data.data;
  },

  async getTaskLogs(id: number): Promise<TaskExecutionLog[]> {
    const response = await api.get(`/tasks/${id}/logs`);
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

  async executeTask(id: number): Promise<void> {
    await api.post(`/tasks/${id}/run`);
  },

  async deleteTask(id: number): Promise<void> {
    await api.delete(`/tasks/${id}`);
  },
};
