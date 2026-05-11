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

export interface QueueJobSummary {
  id: string | number;
  queue_name: string;
  name?: string;
  state: string;
  progress?: any;
  failed_reason?: string;
  attempts_made?: number;
  timestamp?: number;
  processed_on?: number;
  finished_on?: number;
  data?: any;
  return_value?: any;
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
  queue_jobs?: QueueJobSummary[];
  queue_summary?: {
    total: number;
    completed: number;
    failed: number;
    active: number;
    waiting: number;
    delayed: number;
  };
  queue_error?: string;
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
