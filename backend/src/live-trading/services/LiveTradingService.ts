import { Op } from 'sequelize';
import { LiveBrokerAccount } from '../../models/LiveBrokerAccount';
import { LiveAccountSnapshot } from '../../models/LiveAccountSnapshot';
import { LivePosition } from '../../models/LivePosition';
import { LiveOrderDraft } from '../../models/LiveOrderDraft';
import { LiveOrder } from '../../models/LiveOrder';
import { LiveTrade } from '../../models/LiveTrade';
import { LiveExecutionAuditLog } from '../../models/LiveExecutionAuditLog';
import { Stock } from '../../models/Stock';
import { MockBrokerGateway } from '../brokers/MockBrokerGateway';
import { BrokerGateway } from '../brokers/BrokerGateway';
import { DatabaseQuoteProvider } from '../market-data/DatabaseQuoteProvider';
import { liveRiskGuardService } from './LiveRiskGuardService';
import { LIVE_ORDER_CONFIRM_TEXT, liveTradingSafetyService } from './LiveTradingSafetyService';

function toNumber(value: any): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function round(value: any, digits = 2): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const base = 10 ** digits;
  return Math.round(num * base) / base;
}

function normalizeSymbol(symbol: string): string {
  const value = String(symbol || '').trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(value)) return value;
  if (/^(SH|SZ|BJ)\.\d{6}$/.test(value)) {
    const [market, code] = value.split('.');
    return `${code}.${market}`;
  }
  if (/^(SH|SZ|BJ)\d{6}$/.test(value)) return `${value.slice(2)}.${value.slice(0, 2)}`;
  if (/^\d{6}$/.test(value)) {
    const prefix = value.startsWith('6') ? 'SH' : value.startsWith('8') || value.startsWith('4') ? 'BJ' : 'SZ';
    return `${value}.${prefix}`;
  }
  return value;
}

function maskAccountNo(value?: string): string {
  const raw = String(value || '').replace(/\s+/g, '');
  if (!raw) return '未绑定';
  if (raw.length <= 4) return `****${raw}`;
  return `${raw.slice(0, 2)}****${raw.slice(-4)}`;
}

export class LiveTradingService {
  private brokerGateway: BrokerGateway;
  private quoteProvider: DatabaseQuoteProvider;

  constructor() {
    this.brokerGateway = new MockBrokerGateway();
    this.quoteProvider = new DatabaseQuoteProvider();
  }

  async getReadiness(user_id?: number) {
    const safety = liveTradingSafetyService.getStatus();
    const broker = this.brokerGateway.getCapabilities();
    const marketData = this.quoteProvider.getProviderInfo();
    const accountCount = user_id
      ? await LiveBrokerAccount.count({ where: { user_id, is_active: true } })
      : 0;
    return {
      generated_at: new Date().toISOString(),
      safety,
      broker,
      market_data: marketData,
      account_count: accountCount,
      phases: [
        { key: 'safety_boundary', label: '安全边界', status: 'ready', detail: '默认禁止真实下单，强确认与熔断开关已内置。' },
        { key: 'market_data', label: '真实行情入口', status: 'partial', detail: '当前读取本地行情缓存；商业化前需替换授权实时行情。' },
        { key: 'broker_readonly', label: '券商只读', status: safety.can_sync_account ? 'partial' : 'locked', detail: '接口与模型已就绪；真实券商适配器尚未启用。' },
        { key: 'order_approval', label: '订单审批', status: 'ready', detail: '支持订单草稿、风控说明、强确认；提交券商默认阻断。' },
        { key: 'execution', label: '真实执行', status: safety.can_submit_orders ? 'restricted' : 'blocked', detail: safety.can_submit_orders ? '仅限受控内部灰度。' : '真实下单被环境开关和 Mock 网关阻断。' },
      ],
      conclusion: safety.can_submit_orders
        ? '实盘执行开关已开启，但仍必须走订单审批、强确认、风控与审计。'
        : '当前处于安全只读/模拟边界：可以查看实盘方案与订单草稿，但不会提交真实委托。',
    };
  }

  async getOverview(user_id: number) {
    const readiness = await this.getReadiness(user_id);
    const account = await LiveBrokerAccount.findOne({
      where: { user_id, is_active: true },
      order: [['updated_at', 'DESC']],
    });
    const accountId = account?.id ? Number(account.id) : undefined;
    const latestSnapshot = accountId
      ? await LiveAccountSnapshot.findOne({
          where: { user_id, account_id: accountId },
          order: [['snapshot_time', 'DESC']],
        })
      : null;
    const positions = accountId
      ? await LivePosition.findAll({
          where: { user_id, account_id: accountId, quantity: { [Op.gt]: 0 } },
          order: [['market_value', 'DESC']],
          limit: 20,
        })
      : [];
    const drafts = await LiveOrderDraft.findAll({
      where: { user_id },
      order: [['created_at', 'DESC']],
      limit: 10,
    });
    const openDrafts = drafts.filter(item => ['preview', 'pending', 'blocked'].includes(String((item as any).status)));
    const exposure = positions.reduce((sum, item: any) => sum + toNumber(item.market_value), 0);
    const totalAsset = toNumber((latestSnapshot as any)?.total_asset);
    const exposurePct = totalAsset > 0 ? round((exposure / totalAsset) * 100, 4) : 0;

    return {
      generated_at: new Date().toISOString(),
      readiness,
      account: account ? this.toPlain(account) : null,
      latest_snapshot: latestSnapshot ? this.toPlain(latestSnapshot) : null,
      positions: positions.map(item => this.toPlain(item)),
      order_drafts: drafts.map(item => this.toPlain(item)),
      summary: {
        account_bound: Boolean(account),
        total_asset: totalAsset,
        available_cash: toNumber((latestSnapshot as any)?.available_cash),
        market_value: toNumber((latestSnapshot as any)?.market_value) || exposure,
        exposure_pct: exposurePct,
        position_count: positions.length,
        pending_draft_count: openDrafts.length,
        can_submit_orders: readiness.safety.can_submit_orders,
        mode_label: readiness.safety.mode === 'approval_execution_enabled' ? '实盘审批执行' : readiness.safety.mode === 'read_only' ? '只读实盘观察' : '模拟/安全禁用',
        conclusion: readiness.conclusion,
      },
    };
  }

  async listDrafts(user_id: number, options: { status?: string; limit?: number } = {}) {
    const where: any = { user_id };
    if (options.status && options.status !== 'all') where.status = options.status;
    const rows = await LiveOrderDraft.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: Math.min(Math.max(Number(options.limit || 50), 1), 200),
    });
    return rows.map(item => this.toPlain(item));
  }

  async createDraft(user_id: number, input: any) {
    const symbol = normalizeSymbol(input.symbol);
    const side = String(input.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const stock = await Stock.findOne({ where: { symbol } });
    const quote = await this.quoteProvider.getQuote(symbol);
    const name = input.name || quote?.name || (stock as any)?.name || symbol;
    const limitPrice = round(input.limit_price || input.limitPrice || quote?.current_price || (stock as any)?.price, 4);
    const quantity = Math.max(0, Math.floor(Number(input.quantity || 0) / 100) * 100);
    const overview = await this.getOverview(user_id);
    const accountId = Number(input.account_id || overview.account?.id || 0) || undefined;
    const position = overview.positions.find((item: any) => item.symbol === symbol);
    const riskCheck = liveRiskGuardService.evaluate({
      side,
      symbol,
      name,
      quantity,
      limit_price: limitPrice,
      total_asset: overview.summary.total_asset,
      available_cash: overview.summary.available_cash,
      current_position_value: toNumber(position?.market_value),
      total_exposure_pct: overview.summary.exposure_pct,
      is_st: /ST|退/.test(String(name || '')),
    });
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
    const draft = await LiveOrderDraft.create({
      user_id,
      account_id: accountId,
      symbol,
      name,
      side,
      order_type: 'LIMIT',
      quantity,
      limit_price: limitPrice,
      estimated_amount: riskCheck.estimated_amount,
      status: riskCheck.allowed ? 'pending' : 'blocked',
      source_type: input.source_type || 'manual_live_draft',
      source_id: input.source_id,
      rationale: input.rationale || '用户手动创建实盘订单草稿，等待强确认。',
      risk_level: riskCheck.risk_level,
      risk_check: riskCheck,
      quote_snapshot: quote || {},
      confirm_text_required: LIVE_ORDER_CONFIRM_TEXT,
      expires_at: expiresAt,
      metadata: {
        created_from: 'live_trading_page',
        safety_status: liveTradingSafetyService.getStatus(),
      },
    } as any);

    await this.audit({
      user_id,
      account_id: accountId,
      draft_id: Number(draft.id),
      event_type: 'live_order_draft_created',
      severity: riskCheck.allowed ? 'info' : 'warning',
      message: riskCheck.allowed ? '实盘订单草稿已创建，等待用户确认。' : '实盘订单草稿被基础风控阻断。',
      after_state: this.toPlain(draft),
      metadata: { risk_check: riskCheck },
    });

    return this.toPlain(draft);
  }

  async rejectDraft(user_id: number, draft_id: number, reason?: string) {
    const draft = await LiveOrderDraft.findOne({ where: { id: draft_id, user_id } });
    if (!draft) throw new Error('订单草稿不存在或无权限');
    const before = this.toPlain(draft);
    await draft.update({ status: 'rejected', rejected_at: new Date(), metadata: { ...(draft as any).metadata, reject_reason: reason || '' } });
    await this.audit({
      user_id,
      account_id: (draft as any).account_id,
      draft_id,
      event_type: 'live_order_draft_rejected',
      severity: 'info',
      message: '用户已拒绝实盘订单草稿。',
      before_state: before,
      after_state: this.toPlain(draft),
      metadata: { reason },
    });
    return this.toPlain(draft);
  }

  async approveDraft(user_id: number, draft_id: number, input: any) {
    const draft = await LiveOrderDraft.findOne({ where: { id: draft_id, user_id } });
    if (!draft) throw new Error('订单草稿不存在或无权限');
    const before = this.toPlain(draft);
    if (!['pending', 'preview'].includes(String((draft as any).status))) {
      throw new Error(`当前订单草稿状态为 ${(draft as any).status}，不可确认提交。`);
    }
    const riskAllowed = Boolean((draft as any).risk_check?.allowed);
    if (!riskAllowed) throw new Error('订单草稿未通过基础风控，禁止确认提交。');

    liveTradingSafetyService.assertOrderExecutionAllowed(input.confirm_text);

    await draft.update({ status: 'approved', approved_by: user_id, approved_at: new Date() });
    await this.audit({
      user_id,
      account_id: (draft as any).account_id,
      draft_id,
      event_type: 'live_order_draft_approved',
      severity: 'warning',
      message: '用户强确认实盘订单草稿，准备提交券商。',
      before_state: before,
      after_state: this.toPlain(draft),
      metadata: { confirm_text_matched: input.confirm_text === LIVE_ORDER_CONFIRM_TEXT },
    });

    return this.submitApprovedDraft(user_id, draft);
  }

  private async submitApprovedDraft(user_id: number, draft: LiveOrderDraft) {
    const result = await this.brokerGateway.placeOrder({
      symbol: (draft as any).symbol,
      side: (draft as any).side,
      quantity: Number((draft as any).quantity),
      limit_price: Number((draft as any).limit_price),
      order_type: (draft as any).order_type || 'LIMIT',
      client_order_id: `live-draft-${draft.id}`,
    });
    const order = await LiveOrder.create({
      user_id,
      account_id: (draft as any).account_id,
      draft_id: Number(draft.id),
      broker_order_id: result.broker_order_id,
      symbol: (draft as any).symbol,
      name: (draft as any).name,
      side: (draft as any).side,
      quantity: Number((draft as any).quantity),
      limit_price: Number((draft as any).limit_price),
      status: result.status,
      submitted_at: new Date(),
      raw_payload: result.raw_payload || {},
    } as any);
    await draft.update({ status: 'submitted' });
    await this.audit({
      user_id,
      account_id: (draft as any).account_id,
      draft_id: Number(draft.id),
      order_id: Number(order.id),
      event_type: 'live_order_submitted',
      severity: 'warning',
      message: '实盘订单已提交券商。',
      after_state: this.toPlain(order),
    });
    return { draft: this.toPlain(draft), order: this.toPlain(order) };
  }

  async syncReadonlyAccount(user_id: number, input: any = {}) {
    const safety = liveTradingSafetyService.getStatus();
    if (!safety.can_sync_account) {
      throw new Error('实盘只读同步未启用：请先设置 LIVE_READONLY_ENABLED=true，并配置真实券商只读网关。');
    }
    const account = await this.ensureAccount(user_id, input);
    const snapshot = await this.brokerGateway.getAccountSnapshot();
    const row = await LiveAccountSnapshot.create({
      user_id,
      account_id: Number(account.id),
      total_asset: snapshot.total_asset,
      available_cash: snapshot.available_cash,
      market_value: snapshot.market_value,
      frozen_cash: snapshot.frozen_cash || 0,
      total_pnl: snapshot.total_pnl || 0,
      day_pnl: snapshot.day_pnl || 0,
      snapshot_time: snapshot.snapshot_time,
      source: this.brokerGateway.getCapabilities().broker_key,
      raw_payload: snapshot.raw_payload || {},
    } as any);
    const positions = await this.brokerGateway.getPositions();
    for (const position of positions) {
      const marketValue = toNumber(position.market_value);
      await LivePosition.upsert({
        user_id,
        account_id: Number(account.id),
        symbol: normalizeSymbol(position.symbol),
        name: position.name,
        quantity: position.quantity,
        available_quantity: position.available_quantity,
        avg_cost: position.avg_cost,
        current_price: position.current_price,
        market_value: marketValue,
        unrealized_pnl: position.unrealized_pnl,
        unrealized_pnl_pct: position.unrealized_pnl_pct,
        position_pct: snapshot.total_asset > 0 ? round((marketValue / snapshot.total_asset) * 100, 4) : 0,
        quote_time: position.quote_time,
        source: this.brokerGateway.getCapabilities().broker_key,
        raw_payload: position.raw_payload || {},
      } as any);
    }
    await account.update({ last_sync_at: new Date(), readonly_enabled: true, connection_status: 'readonly_synced' });
    await this.audit({
      user_id,
      account_id: Number(account.id),
      event_type: 'live_account_readonly_synced',
      severity: 'info',
      message: '实盘账户只读快照已同步。',
      after_state: this.toPlain(row),
      metadata: { position_count: positions.length },
    });
    return { account: this.toPlain(account), snapshot: this.toPlain(row), position_count: positions.length };
  }

  async getAuditLogs(user_id: number, limit = 50) {
    const rows = await LiveExecutionAuditLog.findAll({
      where: { user_id },
      order: [['created_at', 'DESC']],
      limit: Math.min(Math.max(Number(limit || 50), 1), 200),
    });
    return rows.map(item => this.toPlain(item));
  }

  async getQuotes(symbols: string[]) {
    return this.quoteProvider.getQuotes(symbols);
  }

  private async ensureAccount(user_id: number, input: any = {}) {
    const [account] = await LiveBrokerAccount.findOrCreate({
      where: { user_id, broker_key: this.brokerGateway.getCapabilities().broker_key },
      defaults: {
        user_id,
        broker_key: this.brokerGateway.getCapabilities().broker_key,
        broker_name: this.brokerGateway.getCapabilities().broker_name,
        account_alias: input.account_alias || '实盘只读账户',
        account_no_masked: maskAccountNo(input.account_no),
        permission_scope: 'read_only',
        connection_status: 'created',
        is_active: true,
        readonly_enabled: false,
        trading_enabled: false,
        risk_config: liveTradingSafetyService.getDefaultRiskLimits(),
        metadata: { created_by: 'live_trading_service' },
      } as any,
    });
    return account;
  }

  private async audit(input: {
    user_id?: number;
    account_id?: number;
    draft_id?: number;
    order_id?: number;
    event_type: string;
    severity?: string;
    message: string;
    before_state?: Record<string, any>;
    after_state?: Record<string, any>;
    metadata?: Record<string, any>;
  }) {
    return LiveExecutionAuditLog.create({
      user_id: input.user_id,
      account_id: input.account_id,
      draft_id: input.draft_id,
      order_id: input.order_id,
      event_type: input.event_type,
      severity: input.severity || 'info',
      message: input.message,
      before_state: input.before_state || {},
      after_state: input.after_state || {},
      metadata: input.metadata || {},
    } as any);
  }

  private toPlain(record: any) {
    if (!record) return record;
    return typeof record.toJSON === 'function' ? record.toJSON() : record;
  }
}

export const liveTradingService = new LiveTradingService();
