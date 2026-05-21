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
  audit_event_type?: string;
  source_loop_run_id?: string;
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
  result_summary?: {
    scenario?: string;
    status?: string;
    runtime_risk_blocked?: boolean;
    runtime_block_reason?: string | null;
    runtime_health?: {
      status?: string;
      score?: number;
      conclusion?: string;
      risk_count?: number;
      warn_count?: number;
      factor_min_coverage_rate?: number;
      factor_real_provider_rate?: number;
      factor_coverage_status?: string;
      risk_checks?: Array<{
        key?: string;
        label?: string;
        status?: string;
        metric?: string;
        conclusion?: string;
      }>;
    } | null;
    trade_date?: string;
    scanned_stocks?: number;
    signal_count?: number;
    archived_signal_count?: number;
    agent_submitted?: number;
    agent_failed?: number;
    paper_executed?: number;
    paper_planned?: number;
    paper_skipped?: number;
    requested_count?: number;
    persisted_count?: number;
    latest_trade_date_symbol_count?: number;
    created_validations?: number;
    updated_validations?: number;
    completed_validations?: number;
    pending_validations?: number;
    no_data_validations?: number;
    lifecycle_applied?: number;
    lifecycle_promotion_count?: number;
    lifecycle_degradation_count?: number;
    lifecycle_rollback_count?: number;
    active_adopted_strategy_count?: number;
    message?: string;
  };
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

export interface TaskParameterAuditLog {
  id: number;
  task_id: number;
  task_name: string;
  task_type: string;
  event_type: string;
  source_loop_run_id?: string | null;
  operator_user_id?: number;
  operator_username?: string;
  changed_keys: string[];
  diffs: Array<{
    key: string;
    before: any;
    after: any;
  }>;
  before_parameters: Record<string, any>;
  after_parameters: Record<string, any>;
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
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
  risk_limit_suggestion?: any;
  issues: AutomationHealthIssue[];
  next_actions: string[];
}

export interface RiskLimitSuggestionApplyResult {
  dry_run: boolean;
  applied: boolean;
  message: string;
  action?: string;
  reason?: string;
  limits?: Record<string, number>;
  stability?: {
    latest_action: string;
    latest_action_label?: string;
    consecutive_same_action: number;
    actionable_samples: number;
    window_size: number;
    can_apply: boolean;
    confidence: number;
    evidence_passed?: boolean;
    protection_delta_pct?: number;
    protected_runs?: number;
    thresholds?: Record<string, number>;
    label: string;
    reason: string;
    history?: Array<{
      action: string;
      loop_run_id?: string;
      generated_at?: string;
      reason?: string;
    }>;
  };
  source_loop_run_id?: string | null;
  generated_at?: string | null;
  apply_mode?: 'preview' | 'manual_confirmed';
  changes: Array<{
    id: number;
    name: string;
    type: string;
    current_parameters: Record<string, any>;
    suggested_parameters: Record<string, any>;
    changed_keys: string[];
    changed: boolean;
    diffs: Array<{
      key: string;
      current_value: any;
      suggested_value: any;
    }>;
    field_evidence?: Record<
      string,
      {
        action?: string;
        confidence?: number;
        sample_count?: number;
        triggered_count?: number;
        reason?: string;
        can_apply?: boolean;
        stability?: {
          can_apply?: boolean;
          consecutive_same_action?: number;
          min_consecutive_same_action?: number;
          min_confidence?: number;
          min_sample_count?: number;
          min_triggered_count?: number;
          label?: string;
          reason?: string;
        };
      }
    >;
  }>;
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

  async applyRiskLimitSuggestion(data: {
    dry_run?: boolean;
    task_ids?: number[];
    source_loop_run_id?: string;
  }): Promise<RiskLimitSuggestionApplyResult> {
    const response = await api.post('/tasks/risk-limit-suggestion/apply', data);
    return response.data.data;
  },

  async getTaskLogs(id: number): Promise<TaskExecutionLog[]> {
    const response = await api.get(`/tasks/${id}/logs`);
    return response.data.data;
  },

  async getTaskParameterAudits(params?: {
    task_id?: number;
    event_type?: string;
    limit?: number;
    watched_only?: boolean;
  }): Promise<TaskParameterAuditLog[]> {
    const response = await api.get('/tasks/parameter-audits', { params });
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
