/**
 * Phase 6 (2026-06-27) — 新手主页 `/home`.
 *
 * 用户原话: "我是个股票的新手小白, 想要用这套系统来帮我自动化赚钱, 但是
 * 现在还是太复杂, 我还是用不起来, 所以你的目标应该是能让新手小白用起来。"
 *
 * Phase 1-5 在 admin 5 workspace 里做减法, 新手根本不该看 admin. Phase 6 把
 * "日常自动化赚钱"收到一页 — 3 区块 (账户 / 推荐 / 持仓) + 一键操作.
 *
 * Phase 7 (2026-06-28) — 加 3 个学习区块.
 * 用户反馈: "虽然是新手小白, 但是它也想逐步学习量化策略" + "不想让页面分离开".
 *   A. 推荐 "为什么?" 折叠 — 把现有 highlight_tags + dimensions 翻译成"哪个因子".
 *   B. 今日学一招 — 6 个量化基础知识点轮播 (按日期 % 6), CTA → 简易版.
 *   C. 今日因子表现 — 6 核心因子小卡片 + sparkline (mock 数据 + TODO 接口).
 * 设计纪律: 推荐"为什么"默认折叠 (不臃肿); 一招卡 1 段文字; 因子表现 1 行 6 格.
 *
 * 设计原则:
 *   - 无 tab 无侧栏 — 一眼能看到"今天要做什么".
 *   - 实用极简 (与简易版 /workspace/easy 暖纸色教学版并存, 互不替代).
 *   - 一键跟单 / 一键卖出 = 1 次 confirm + 1 次 POST, < 3 步搞定.
 *   - 完全复用现有后端 endpoint:
 *       GET  /api/today/v3-recommendations  (top 3)
 *       GET  /api/today/signals             (账户 KPI)
 *       GET  /api/paper-trading             (持仓)
 *       POST /api/paper-trading/trade       (一键跟单 / 一键卖出)
 *
 * 不依赖 WorkspaceLayout — App.tsx 在 /home 路径下短路渲染极简 header + 本组件.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Empty, Modal, Result, Skeleton, Space, Tag, Tooltip, message } from 'antd';
import {
  CloudSyncOutlined,
  DollarOutlined,
  FundOutlined,
  ReloadOutlined,
  RiseOutlined,
  ShoppingCartOutlined,
  StockOutlined,
  BookOutlined,
  BulbOutlined,
  DownOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { usePortfolio } from '../contexts/PortfolioContext';
import { getPortfolio, placeTrade, PositionRow } from '../services/portfolioWorkspaceService';
import { todayWorkspaceService, AccountSummary } from '../services/todayWorkspaceService';
import { getV3Recommendations, V3RecommendationItem } from '../services/v3RecommendationService';

// ---------------------------------------------------------------------------
//  helpers — 本文件内联, 新手主页不再拆 helper 文件
// ---------------------------------------------------------------------------

/** 千分位 + 2 位小数, 带 ¥ 前缀. n=null/undefined → '—'. */
function formatYuan(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 带符号 + 1 位百分比. n=null → '—'. */
function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

/** 带符号 + 2 位金额. */
function formatPnl(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}¥${Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A 股惯例: 涨红跌绿. 0 / null → 灰. */
function pnlColor(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return 'var(--ink-3, #94a3b8)';
  return n > 0 ? 'var(--up, #dc2626)' : 'var(--down, #16a34a)';
}

/** 把元转成 A 股手数 (100 股整). 不足 100 → 100, 上限到下一个百位. */
function yuanToShares(amountYuan: number, pricePerShare: number): number {
  if (!Number.isFinite(amountYuan) || !Number.isFinite(pricePerShare) || pricePerShare <= 0) {
    return 100;
  }
  const raw = amountYuan / pricePerShare;
  const lots = Math.max(1, Math.round(raw / 100));
  return lots * 100;
}

// ---------------------------------------------------------------------------
//  默认建议跟单金额 — 新手主页固定 5000 元/单, 不让用户填表
// ---------------------------------------------------------------------------
const DEFAULT_FOLLOW_AMOUNT = 5000;

// ---------------------------------------------------------------------------
//  Phase 7 — 学习模块常量
// ---------------------------------------------------------------------------

/** 区块 B: 6 个量化基础知识点, 按 (今日日号 % 6) 轮播. 每条都传递一个具体可学的知识. */
const DAILY_LESSONS = [
  {
    title: '动量因子',
    body: '过去 20 个交易日涨幅前 30% 的股票, 未来 5-10 天继续涨的概率比随机高约 8 个百分点。背后是"强者恒强"的羊群效应 — 但持有不能太久, 一旦放量滞涨就要警惕反转。',
  },
  {
    title: '价值因子',
    body: '低 PE (市盈率) / 低 PB (市净率) 的股票长期年化跑赢市场 2-4%。本质是"用便宜价格买好资产", 但要剔除"价值陷阱"(基本面持续恶化但估值已便宜)。',
  },
  {
    title: '质量因子',
    body: 'ROE (净资产收益率) 连续 3 年大于 15%、毛利率高且稳定的公司, 抗风险能力更强。质量因子在熊市表现尤其好 — 不一定涨最多, 但跌得少。',
  },
  {
    title: '成长因子',
    body: '营收同比增速 > 20%、净利润增速 > 30% 的公司, 短期估值容易被打高。注意区分"持续高增长"和"基数低导致的虚高" — 看 2-3 年趋势更可靠。',
  },
  {
    title: '北向资金',
    body: '北向资金 (港股通 → A 股) 连续 5 日净流入超 50 亿, 通常预示蓝筹白马走强。这是"聪明钱"信号之一 — 但单日大额流入未必, 要看持续性。',
  },
  {
    title: '龙头股策略',
    body: '行业内市值前 3 名 + 营收增速行业前列的公司, 集中度提升 (行业 ROIC 上行) 时显著跑赢。本质是吃"行业格局优化"的红利, 而非赌单只爆款。',
  },
];

/**
 * 区块 C: 6 核心因子今日表现.
 *
 * TODO(P2, admin): 接通 /api/factors/today-performance — backend 已有
 * `backtest_factor_performance` 表, 需要 controller 出一个 today rollup endpoint
 * (返回 6 因子的 daily IC + 累计收益 + 7 日 trend). 当前用静态示例避免新区块
 * crash 整个 /home, 普通用户看到的也是"启发式"的科普, 不影响实盘决策.
 */
const MOCK_FACTOR_PERFORMANCE: Array<{
  name: string;
  value: number;
  trend: number[];
  hint: string;
}> = [
  { name: '价值', value: 1.2, trend: [1, 2, 4, 6, 7, 6, 8], hint: '蓝筹和金融股领涨' },
  { name: '动量', value: 0.8, trend: [1, 3, 5, 6, 7, 5, 7], hint: '强势股延续' },
  { name: '质量', value: -0.3, trend: [7, 6, 5, 3, 2, 3, 2], hint: '高 ROE 板块小幅回落' },
  { name: '成长', value: 0.5, trend: [1, 2, 3, 5, 6, 5, 6], hint: '科技成长股偏强' },
  { name: '北向', value: -0.1, trend: [2, 3, 2, 3, 2, 3, 2], hint: '外资观望' },
  { name: '低波', value: 0.4, trend: [1, 2, 3, 4, 5, 4, 5], hint: '避险情绪一般' },
];

/** Inline SVG sparkline — 不引入新 lib (recharts 这里太重). */
const Sparkline: React.FC<{ data: number[]; color: string }> = ({ data, color }) => {
  const w = 80;
  const h = 22;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(' ');
  return (
    <svg width={w} height={h} aria-hidden="true">
      <polyline fill="none" stroke={color} strokeWidth={1.5} points={points} />
    </svg>
  );
};

// ---------------------------------------------------------------------------
//  组件
// ---------------------------------------------------------------------------

const HomeWorkspace: React.FC = () => {
  const { selectedPortfolioId } = usePortfolio();
  const navigate = useNavigate();

  // 三个独立 fetch — 任一失败不阻塞其他区块.
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [accountError, setAccountError] = useState<string | null>(null);

  const [recommendations, setRecommendations] = useState<V3RecommendationItem[]>([]);
  const [recLoading, setRecLoading] = useState(true);
  const [recError, setRecError] = useState<string | null>(null);

  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [posLoading, setPosLoading] = useState(true);
  const [posError, setPosError] = useState<string | null>(null);

  // 跟单 / 卖出去重 — 同一 symbol 单击多次保护
  const [busySymbol, setBusySymbol] = useState<string | null>(null);
  // 已跟过的推荐 (本次会话内) — 跟单成功后从列表移除
  const [followedSymbols, setFollowedSymbols] = useState<Set<string>>(new Set());
  // Phase 7: 推荐"为什么?"折叠状态 — 按 symbol 区分.
  const [whyOpenSet, setWhyOpenSet] = useState<Set<string>>(new Set());
  const toggleWhy = useCallback((symbol: string) => {
    setWhyOpenSet(prev => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  }, []);

  // Phase 7: 区块 B/C 计算 — 静态轮播 + 静态因子表现, 与 fetch 解耦, 不会随
  // selectedPortfolioId 变更 re-render.
  const todayLesson = useMemo(() => DAILY_LESSONS[new Date().getDate() % DAILY_LESSONS.length], []);
  const topFactor = useMemo(
    () => MOCK_FACTOR_PERFORMANCE.reduce((best, f) => (f.value > best.value ? f : best)),
    []
  );

  // -------- fetchers --------
  const loadAccount = useCallback(async () => {
    setAccountLoading(true);
    setAccountError(null);
    try {
      const data = await todayWorkspaceService.getTodaySignals({
        portfolio_id: selectedPortfolioId,
        // 极简 — 不需要 candidate list 干扰, 但 endpoint 必返这些字段, 一起拿无成本.
        dragon_head_limit: 0,
        earnings_limit: 0,
        alerts_limit: 0,
      });
      setAccount(data.account);
    } catch (err: unknown) {
      setAccountError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccountLoading(false);
    }
  }, [selectedPortfolioId]);

  const loadRecommendations = useCallback(async () => {
    setRecLoading(true);
    setRecError(null);
    try {
      const data = await getV3Recommendations({ limit: 3 });
      setRecommendations(data.recommendations || []);
    } catch (err: unknown) {
      setRecError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecLoading(false);
    }
  }, []);

  const loadPositions = useCallback(async () => {
    setPosLoading(true);
    setPosError(null);
    try {
      const data = await getPortfolio(selectedPortfolioId);
      setPositions(data.positions || []);
    } catch (err: unknown) {
      setPosError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosLoading(false);
    }
  }, [selectedPortfolioId]);

  useEffect(() => {
    void loadAccount();
    void loadRecommendations();
    void loadPositions();
  }, [loadAccount, loadRecommendations, loadPositions]);

  // -------- 一键跟单 --------
  const handleFollowBuy = useCallback(
    (rec: V3RecommendationItem) => {
      const price = rec.current_price;
      if (!price || price <= 0) {
        message.error('当前价缺失, 无法计算手数');
        return;
      }
      const shares = yuanToShares(DEFAULT_FOLLOW_AMOUNT, price);
      const estAmount = shares * price;
      Modal.confirm({
        title: '一键跟单',
        content: (
          <div style={{ fontSize: 14, lineHeight: 1.7 }}>
            <div>
              买入 <strong>{rec.name || rec.symbol}</strong> ({rec.symbol})
            </div>
            <div>
              数量: <strong>{shares} 股</strong> (约 {formatYuan(estAmount)})
            </div>
            <div>
              当前价: <strong>{formatYuan(price)}</strong>
            </div>
            <div style={{ marginTop: 8, color: 'var(--ink-3, #94a3b8)', fontSize: 12 }}>
              新手默认每单 ¥5,000 — 实际成交价以盘口为准
            </div>
          </div>
        ),
        okText: '确定买入',
        cancelText: '取消',
        onOk: async () => {
          setBusySymbol(rec.symbol);
          try {
            await placeTrade({
              symbol: rec.symbol,
              direction: 'BUY',
              quantity: shares,
              portfolio_id: selectedPortfolioId,
            });
            message.success(`已买入 ${rec.name || rec.symbol} ${shares} 股`);
            setFollowedSymbols(prev => {
              const next = new Set(prev);
              next.add(rec.symbol);
              return next;
            });
            // 刷新账户 + 持仓 (推荐列表本地隐藏即可).
            void loadAccount();
            void loadPositions();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            message.error(`买入失败: ${msg}`);
          } finally {
            setBusySymbol(null);
          }
        },
      });
    },
    [loadAccount, loadPositions, selectedPortfolioId]
  );

  // -------- 一键卖出 --------
  const handleSellAll = useCallback(
    (pos: PositionRow) => {
      const price = pos.current_price;
      const estAmount = pos.quantity * price;
      Modal.confirm({
        title: '一键卖出',
        content: (
          <div style={{ fontSize: 14, lineHeight: 1.7 }}>
            <div>
              卖出全部 <strong>{pos.quantity} 股</strong> {pos.name || pos.symbol}
            </div>
            <div>
              预计金额: <strong>{formatYuan(estAmount)}</strong>
            </div>
            <div>
              当前浮盈:{' '}
              <strong style={{ color: pnlColor(pos.unrealized_pnl) }}>
                {formatPnl(pos.unrealized_pnl)}
              </strong>
            </div>
            <div style={{ marginTop: 8, color: 'var(--ink-3, #94a3b8)', fontSize: 12 }}>
              实际成交价以盘口为准
            </div>
          </div>
        ),
        okText: '确定卖出',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: async () => {
          setBusySymbol(pos.symbol);
          try {
            const result = await placeTrade({
              symbol: pos.symbol,
              direction: 'SELL',
              quantity: pos.quantity,
              portfolio_id: selectedPortfolioId,
            });
            const realized = result.realized_pnl;
            message.success(
              realized != null && Number.isFinite(realized)
                ? `已卖出, 实现 ${formatPnl(realized)}`
                : '已卖出'
            );
            void loadAccount();
            void loadPositions();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            message.error(`卖出失败: ${msg}`);
          } finally {
            setBusySymbol(null);
          }
        },
      });
    },
    [loadAccount, loadPositions, selectedPortfolioId]
  );

  // -------- 计算派生值 --------
  const visibleRecommendations = useMemo(
    () => recommendations.filter(r => !followedSymbols.has(r.symbol)),
    [recommendations, followedSymbols]
  );

  // ---------------------------------------------------------------------------
  //  Render
  // ---------------------------------------------------------------------------
  return (
    <div className="home-workspace">
      {/* ===== 区块 1: 账户总值 ===== */}
      <Card className="home-card home-account-card" bordered bodyStyle={{ padding: 24 }}>
        {accountLoading ? (
          <Skeleton active paragraph={{ rows: 2 }} />
        ) : accountError ? (
          <Result
            status="warning"
            title="账户加载失败"
            subTitle={accountError}
            extra={<Button onClick={loadAccount}>重试</Button>}
          />
        ) : (
          <div className="home-account-body">
            <div className="home-account-label">
              <DollarOutlined style={{ marginRight: 6 }} />
              账户总值
            </div>
            <div className="home-account-value">{formatYuan(account?.total_value)}</div>
            <Space size={24} wrap style={{ marginTop: 8 }}>
              <span className="home-account-sub">
                <span className="home-account-sub-label">今日</span>
                <span style={{ color: pnlColor(account?.pnl_yesterday ?? null) }}>
                  {formatPnl(account?.pnl_yesterday ?? null)}
                </span>
              </span>
              <span className="home-account-sub">
                <span className="home-account-sub-label">累计</span>
                <span style={{ color: pnlColor(account?.total_return ?? null) }}>
                  {formatPnl(account?.total_return ?? null)}
                  <span style={{ marginLeft: 4, fontSize: 12 }}>
                    ({formatPct(((account?.total_return_pct ?? null) || 0) * 100)})
                  </span>
                </span>
              </span>
              <span className="home-account-sub">
                <span className="home-account-sub-label">可用现金</span>
                <span>{formatYuan(account?.current_cash)}</span>
              </span>
            </Space>
          </div>
        )}
      </Card>

      {/* ===== 区块 2: 今日 AI 推荐 ===== */}
      <Card
        className="home-card"
        bordered
        title={
          <span>
            <RiseOutlined style={{ marginRight: 6, color: 'var(--brand, #4338ca)' }} />
            今天 AI 推荐
            <Tag style={{ marginLeft: 8 }} color="processing">
              {visibleRecommendations.length} 只
            </Tag>
          </span>
        }
        extra={
          <Button
            type="text"
            icon={<ReloadOutlined />}
            onClick={loadRecommendations}
            loading={recLoading}
          >
            刷新
          </Button>
        }
        bodyStyle={{ padding: 16 }}
      >
        {recLoading ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : recError ? (
          <Result
            status="warning"
            title="推荐加载失败"
            subTitle={recError}
            extra={<Button onClick={loadRecommendations}>重试</Button>}
          />
        ) : visibleRecommendations.length === 0 ? (
          <Empty
            description={
              recommendations.length === 0
                ? '今天暂无 AI 推荐 — 数据可能还没跑完, 稍后再来'
                : '今天的推荐都跟过了, 明天再来'
            }
          />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {visibleRecommendations.map((rec, idx) => {
              const isBusy = busySymbol === rec.symbol;
              const price = rec.current_price;
              const shares = price ? yuanToShares(DEFAULT_FOLLOW_AMOUNT, price) : 0;
              const whyOpen = whyOpenSet.has(rec.symbol);
              // Phase 7: 把现有 dimensions (人气/逻辑/资金/结构) 翻译成新手能懂的"哪个量化因子".
              // 4 维 → 4 因子映射, 只展示 bar_value >= 60 的强项 (即真正"推荐这只"的理由).
              const DIM_TO_FACTOR: Record<string, { factor: string; copy: string }> = {
                logic: { factor: '价值', copy: '基本面与估值逻辑通顺' },
                capital: { factor: '动量/资金', copy: '主力资金流入, 短期动能强' },
                popularity: { factor: '人气', copy: '题材热度高, 关注度集中' },
                structure: { factor: '质量', copy: '价格结构健康, 风险可控' },
              };
              const strongFactors = (rec.dimensions || [])
                .filter(d => d.bar_value >= 60 && DIM_TO_FACTOR[d.key])
                .map(d => ({
                  name: DIM_TO_FACTOR[d.key].factor,
                  detail: DIM_TO_FACTOR[d.key].copy,
                  score: Math.round(d.bar_value),
                  label: d.label,
                }));
              return (
                <div key={rec.symbol} className="home-reco-item">
                  <div className="home-reco-row">
                    <div className="home-reco-head">
                      <span className="home-reco-idx">{idx + 1}</span>
                      <span className="home-reco-name">{rec.name || rec.symbol}</span>
                      <span className="home-reco-symbol">{rec.symbol}</span>
                      <span className="home-reco-price">{formatYuan(price)}</span>
                      <span style={{ color: pnlColor(rec.change_pct), fontSize: 12 }}>
                        {formatPct(rec.change_pct)}
                      </span>
                    </div>
                    <Button
                      type="primary"
                      icon={<ShoppingCartOutlined />}
                      onClick={() => handleFollowBuy(rec)}
                      loading={isBusy}
                      disabled={!price}
                      style={{ height: 40, borderRadius: 8, fontWeight: 500 }}
                    >
                      一键跟单
                    </Button>
                  </div>
                  {rec.recommend_reason && (
                    <div className="home-reco-reason">
                      <span className="home-reco-reason-label">理由</span>
                      {rec.recommend_reason}
                    </div>
                  )}
                  <div className="home-reco-meta">
                    AI 建议买入约 {formatYuan(DEFAULT_FOLLOW_AMOUNT)} (约 {shares || '—'} 股)
                  </div>
                  {/* Phase 7: 为什么推荐这只? — 翻译成新手能懂的因子语言. */}
                  <div className="home-reco-why">
                    <Button
                      type="link"
                      size="small"
                      className="home-reco-why-toggle"
                      onClick={() => toggleWhy(rec.symbol)}
                      icon={<BookOutlined />}
                    >
                      为什么推荐这只? {whyOpen ? <UpOutlined /> : <DownOutlined />}
                    </Button>
                    {whyOpen && (
                      <div className="home-reco-why-body">
                        {strongFactors.length > 0 ? (
                          strongFactors.map(f => (
                            <div key={f.name} className="home-reco-why-row">
                              <span className="home-reco-why-check">✓</span>
                              <span>
                                {f.label}: {f.detail} ({f.score}/100) — 对应「{f.name}因子」
                              </span>
                            </div>
                          ))
                        ) : (
                          <div className="home-reco-why-row">
                            <span className="home-reco-why-check">✓</span>
                            <span>AI 综合 4 维度 (人气/逻辑/资金/结构) 判断, 暂无单项突出强项</span>
                          </div>
                        )}
                        {rec.highlight_tags && rec.highlight_tags.length > 0 && (
                          <div className="home-reco-why-row">
                            <span className="home-reco-why-check">✓</span>
                            <span>
                              亮点标签:{' '}
                              {rec.highlight_tags.map(t => (
                                <Tag key={t} style={{ marginRight: 4 }}>
                                  {t}
                                </Tag>
                              ))}
                            </span>
                          </div>
                        )}
                        <div className="home-reco-why-tip">
                          <BulbOutlined /> 当 3 个或以上因子同时正向, 历史胜率约 62% — 点
                          <a onClick={() => navigate('/workspace/easy')}> 简易版 </a>
                          学完整 4 步教学.
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </Space>
        )}
      </Card>

      {/* ===== Phase 7 — 区块 2.5: 今日学一招 (按日期轮播 6 个量化基础知识点) ===== */}
      <Card className="home-card home-lesson-card" bordered bodyStyle={{ padding: 16 }}>
        <div className="home-lesson-head">
          <BookOutlined className="home-lesson-icon" />
          <span className="home-lesson-title">今日学一招 · 「{todayLesson.title}」</span>
        </div>
        <div className="home-lesson-body">{todayLesson.body}</div>
        <Button type="link" className="home-lesson-cta" onClick={() => navigate('/workspace/easy')}>
          想学更多? 试试简易版的 4 步教学 →
        </Button>
      </Card>

      {/* ===== Phase 7 — 区块 2.6: 今日因子表现 (6 核心因子小卡片 + sparkline) =====
          TODO(P2, admin): 接通 /api/factors/today-performance (见 MOCK_FACTOR_PERFORMANCE 注释) */}
      <Card className="home-card home-factor-card" bordered bodyStyle={{ padding: 16 }}>
        <div className="home-factor-head">
          <FundOutlined className="home-factor-icon" />
          <span className="home-factor-title">今日因子表现</span>
          <span className="home-factor-hint">6 大核心因子今天的强弱</span>
        </div>
        <div className="home-factor-grid">
          {MOCK_FACTOR_PERFORMANCE.map(f => {
            const color = pnlColor(f.value);
            return (
              <div key={f.name} className="home-factor-cell">
                <div className="home-factor-name">{f.name}</div>
                <div className="home-factor-value" style={{ color }}>
                  {formatPct(f.value)}
                </div>
                <Sparkline data={f.trend} color={color} />
              </div>
            );
          })}
        </div>
        <div className="home-factor-summary">
          今天「{topFactor.name}因子」表现最强 — {topFactor.hint}.
          <span className="home-factor-summary-meta">示例数据 · 后续接通真实因子盘后表现</span>
        </div>
      </Card>

      {/* ===== 区块 3: 我的持仓 ===== */}
      <Card
        className="home-card"
        bordered
        title={
          <span>
            <FundOutlined style={{ marginRight: 6, color: 'var(--brand, #4338ca)' }} />
            我的持仓
            <Tag style={{ marginLeft: 8 }} color="default">
              {positions.length} 只
            </Tag>
          </span>
        }
        extra={
          <Button
            type="text"
            icon={<CloudSyncOutlined />}
            onClick={loadPositions}
            loading={posLoading}
          >
            刷新
          </Button>
        }
        bodyStyle={{ padding: 16 }}
      >
        {posLoading ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : posError ? (
          <Result
            status="warning"
            title="持仓加载失败"
            subTitle={posError}
            extra={<Button onClick={loadPositions}>重试</Button>}
          />
        ) : positions.length === 0 ? (
          <Empty description="还没有持仓 — 跟上面的 AI 推荐买一只试试" />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {positions.map(pos => {
              const isBusy = busySymbol === pos.symbol;
              const costBasis = pos.quantity * pos.avg_cost;
              const pctChange = costBasis > 0 ? (pos.unrealized_pnl / costBasis) * 100 : null;
              return (
                <div key={pos.id} className="home-pos-item">
                  <div className="home-pos-row">
                    <div className="home-pos-head">
                      <StockOutlined style={{ marginRight: 6, color: 'var(--ink-3, #94a3b8)' }} />
                      <span className="home-pos-name">{pos.name || pos.symbol}</span>
                      <span className="home-pos-symbol">
                        {pos.quantity} 股 @ {formatYuan(pos.avg_cost)}
                      </span>
                    </div>
                    <Tooltip title="一键卖出全部持仓">
                      <Button
                        danger
                        onClick={() => handleSellAll(pos)}
                        loading={isBusy}
                        style={{ height: 40, borderRadius: 8, fontWeight: 500 }}
                      >
                        一键卖出
                      </Button>
                    </Tooltip>
                  </div>
                  <div className="home-pos-meta">
                    现价 <strong>{formatYuan(pos.current_price)}</strong>
                    <span style={{ marginLeft: 16 }}>
                      浮盈{' '}
                      <strong style={{ color: pnlColor(pos.unrealized_pnl) }}>
                        {formatPnl(pos.unrealized_pnl)}
                      </strong>
                      {pctChange != null && (
                        <span style={{ color: pnlColor(pos.unrealized_pnl), marginLeft: 4 }}>
                          ({formatPct(pctChange)})
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </Space>
        )}
      </Card>

      {/* ===== 区块 4: 今日提示 (静态, 复用 account 已知字段) ===== */}
      {!accountLoading && !accountError && account && (
        <Card className="home-card home-tip-card" bordered bodyStyle={{ padding: 16 }}>
          <div className="home-tip">
            <span className="home-tip-dot" />
            <span>
              {(() => {
                const cashPct =
                  account.total_value > 0
                    ? (account.current_cash / account.total_value) * 100
                    : 100;
                if (cashPct >= 80) {
                  return '当前仓位较轻 — 可关注上面的 AI 推荐, 单只建议 5% 以内';
                }
                if (cashPct <= 20) {
                  return '当前仓位较重 — 大盘震荡时优先减仓盈利较多的';
                }
                return '当前仓位适中 — 跟踪持仓表现, 跌破成本 7% 应止损';
              })()}
            </span>
          </div>
        </Card>
      )}
    </div>
  );
};

export default HomeWorkspace;
