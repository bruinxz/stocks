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

export interface AutomationHealthIssue {
  level: 'warning' | 'critical';
  message: string;
  task_name?: string;
  code?: string;
}

export interface AutomationHealthChain {
  key: string;
  title: string;
  subtitle: string;
  status: 'healthy' | 'warning' | 'critical';
  active_count: number;
  task_count: number;
  tasks: Array<{
    id?: number;
    name: string;
    type: string;
    cron_expression?: string;
    is_active?: boolean;
    last_run_at?: string;
    last_run_status?: string;
    last_log_status?: string;
    last_log_started_at?: string;
    last_log_completed_at?: string;
    parameters?: Record<string, any>;
  }>;
  issues: AutomationHealthIssue[];
}

export interface AutomationHealth {
  generated_at: string;
  status: 'healthy' | 'warning' | 'critical';
  summary: {
    total_tasks: number;
    active_tasks: number;
    critical_issues: number;
    warnings: number;
    queue_waiting: number;
    latest_loop_run_at?: string | null;
    latest_loop_run_id?: string | null;
    latest_loop_trade_action?: string | null;
  };
  queues: Record<string, any>;
  chains: AutomationHealthChain[];
  latest_loop?: any;
  issues: AutomationHealthIssue[];
  next_actions: string[];
}

export const taskService = {
  async getTasks(): Promise<ScheduledTask[]> {
    const response = await api.get('/tasks');
    return response.data.data;
  },

  async getAutomationHealth(): Promise<AutomationHealth> {
    const response = await api.get('/tasks/automation-health');
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
