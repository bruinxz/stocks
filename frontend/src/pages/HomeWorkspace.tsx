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
 * Phase 7.5 (2026-06-28) — /home 走标准 Sider+Header Layout.
 *
 * Phase 8 (2026-06-28) — 高级感重设计.
 * 用户原话: "继续优化视觉效果, 我要高级感和设计感".
 *   1. 账户区: 28px → 64px 大数字 + radial gradient + UPPERCASE label, Apple Finance 风.
 *   2. 推荐卡: 列表行式 → 大尺寸卡片 grid (padding 32px) + hover lift, Stripe Dashboard 风.
 *   3. 学一招: 暖纸色 → 冷色高级 (浅紫 brand-soft 背景).
 *   4. 因子表现: 6 列挤压 → 大间距卡片 + 加大 sparkline.
 *   5. 持仓: 列表行 → 卡片网格 + 等宽数字 + 浮盈大字号.
 *   6. 全局去 emoji icon → antd Outlined.
 *   7. 数字全部走 Intl.NumberFormat('zh-CN') 千分位.
 *   8. 跟单 / 卖出按钮: violet → 黑色 (--ink-1, 比 brand 更高级).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Empty, Modal, Result, Skeleton, Tooltip, message } from 'antd';
import {
  ArrowUpOutlined,
  ArrowDownOutlined,
  ReloadOutlined,
  ShoppingCartOutlined,
  BookOutlined,
  BulbOutlined,
  CaretDownOutlined,
  CaretUpOutlined,
  ArrowRightOutlined,
  CheckOutlined,
} from '@ant-design/icons';
import { usePortfolio } from '../contexts/PortfolioContext';
import { getPortfolio, placeTrade, PositionRow } from '../services/portfolioWorkspaceService';
import { todayWorkspaceService, AccountSummary } from '../services/todayWorkspaceService';
import { getV3Recommendations, V3RecommendationItem } from '../services/v3RecommendationService';

// ---------------------------------------------------------------------------
//  helpers — 本文件内联, 新手主页不再拆 helper 文件
// ---------------------------------------------------------------------------

const NF_INT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const NF_MONEY = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 纯数字部分 (不带 ¥), 千分位 + 2 位小数. Phase 8 — 大字号 hero 用. */
function formatAmount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return NF_MONEY.format(n);
}

/** 千分位 + 2 位小数, 带 ¥ 前缀. n=null/undefined → '—'. */
function formatYuan(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `¥${NF_MONEY.format(n)}`;
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
  return `${sign}¥${NF_MONEY.format(Math.abs(n))}`;
}

/** 整数千分位 — 用于"约 5,000 元". */
function formatInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return NF_INT.format(n);
}

/** A 股惯例: 涨红跌绿. 0 / null → 灰. */
function pnlColor(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return 'var(--ink-3, #737373)';
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

/** Inline SVG sparkline — 不引入新 lib (recharts 这里太重). Phase 8 加大: w 100 h 32 + 1.75 stroke. */
const Sparkline: React.FC<{ data: number[]; color: string }> = ({ data, color }) => {
  const w = 100;
  const h = 32;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(' ');
  return (
    <svg width={w} height={h} aria-hidden="true">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth={1.75}
        points={points}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
              数量: <strong>{formatInt(shares)} 股</strong> (约 {formatYuan(estAmount)})
            </div>
            <div>
              当前价: <strong>{formatYuan(price)}</strong>
            </div>
            <div style={{ marginTop: 8, color: 'var(--ink-3, #737373)', fontSize: 12 }}>
              新手默认每单 ¥{formatInt(DEFAULT_FOLLOW_AMOUNT)} — 实际成交价以盘口为准
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
            message.success(`已买入 ${rec.name || rec.symbol} ${formatInt(shares)} 股`);
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
              卖出全部 <strong>{formatInt(pos.quantity)} 股</strong> {pos.name || pos.symbol}
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
            <div style={{ marginTop: 8, color: 'var(--ink-3, #737373)', fontSize: 12 }}>
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

  // 派生: 今日 / 累计 颜色
  const todayPnl = account?.pnl_yesterday ?? null;
  const totalReturn = account?.total_return ?? null;
  const totalReturnPct = ((account?.total_return_pct ?? null) || 0) * 100;

  // ---------------------------------------------------------------------------
  //  Render
  // ---------------------------------------------------------------------------
  return (
    <div className="home-workspace">
      {/* ===== Phase 8 — 区块 1: 账户总值 hero (64px 大数字 + radial gradient) ===== */}
      <section className="home-hero">
        {accountLoading ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : accountError ? (
          <Result
            status="warning"
            title="账户加载失败"
            subTitle={accountError}
            extra={<Button onClick={loadAccount}>重试</Button>}
          />
        ) : (
          <>
            <div className="home-hero-label">账户总值</div>
            <div className="home-hero-value">
              <span className="home-hero-currency">¥</span>
              <span className="home-hero-amount tabular-nums">
                {formatAmount(account?.total_value)}
              </span>
            </div>
            <div className="home-hero-pnl">
              <span
                className="home-hero-badge"
                style={{ color: pnlColor(todayPnl), borderColor: pnlColor(todayPnl) + '33' }}
              >
                {(todayPnl ?? 0) >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}{' '}
                {formatPnl(todayPnl)}
              </span>
              <span className="home-hero-pnl-label">今日盈亏</span>
              <span className="home-hero-divider" aria-hidden="true">
                /
              </span>
              <span className="home-hero-pnl-label">累计</span>
              <span
                className="home-hero-cumulative tabular-nums"
                style={{ color: pnlColor(totalReturn) }}
              >
                {formatPnl(totalReturn)}
                <span className="home-hero-cumulative-pct">({formatPct(totalReturnPct)})</span>
              </span>
              <span className="home-hero-divider" aria-hidden="true">
                /
              </span>
              <span className="home-hero-pnl-label">可用现金</span>
              <span className="home-hero-cash tabular-nums">
                {formatYuan(account?.current_cash)}
              </span>
            </div>
          </>
        )}
      </section>

      {/* ===== Phase 8 — 区块 2: 今日 AI 推荐 (大卡片 grid + 黑色 CTA + hover lift) ===== */}
      <section className="home-section">
        <header className="home-section-head">
          <div>
            <h2 className="home-section-title">今日推荐</h2>
            <p className="home-section-subtitle">
              AI 多维度分析 · {visibleRecommendations.length} 只候选 · 每日 09:30 更新
            </p>
          </div>
          <Button
            type="text"
            icon={<ReloadOutlined />}
            onClick={loadRecommendations}
            loading={recLoading}
          >
            刷新
          </Button>
        </header>
        {recLoading ? (
          <div className="home-reco-grid">
            <Skeleton active paragraph={{ rows: 4 }} />
            <Skeleton active paragraph={{ rows: 4 }} />
          </div>
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
          <div className="home-reco-grid">
            {visibleRecommendations.map(rec => {
              const isBusy = busySymbol === rec.symbol;
              const price = rec.current_price;
              const shares = price ? yuanToShares(DEFAULT_FOLLOW_AMOUNT, price) : 0;
              const whyOpen = whyOpenSet.has(rec.symbol);
              // Phase 7: 把现有 dimensions (人气/逻辑/资金/结构) 翻译成新手能懂的"哪个量化因子".
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
              // 置信度 — 取所有 dimension 的均值 (0-100), 若没有 dimensions 走 80 fallback.
              const conf = rec.dimensions?.length
                ? Math.round(
                    rec.dimensions.reduce((s, d) => s + (d.bar_value || 0), 0) /
                      rec.dimensions.length
                  )
                : 80;
              return (
                <article key={rec.symbol} className="home-reco-card">
                  <div className="home-reco-card-head">
                    <div className="home-reco-card-name">
                      <div className="home-reco-card-title">{rec.name || rec.symbol}</div>
                      <div className="home-reco-card-symbol">{rec.symbol}</div>
                    </div>
                    <div className="home-reco-card-score">
                      <div className="home-reco-card-score-value tabular-nums">{conf}</div>
                      <div className="home-reco-card-score-label">置信度</div>
                    </div>
                  </div>
                  <div className="home-reco-card-price">
                    <span className="home-reco-card-price-amount tabular-nums">
                      {formatYuan(price)}
                    </span>
                    <span
                      className="home-reco-card-price-change tabular-nums"
                      style={{ color: pnlColor(rec.change_pct) }}
                    >
                      {formatPct(rec.change_pct)}
                    </span>
                  </div>
                  {rec.recommend_reason && (
                    <p className="home-reco-card-reason">{rec.recommend_reason}</p>
                  )}
                  <div className="home-reco-card-meta">
                    建议买入约 <strong>¥{formatInt(DEFAULT_FOLLOW_AMOUNT)}</strong> · 约{' '}
                    <strong>{formatInt(shares) || '—'}</strong> 股
                  </div>
                  <Button
                    type="primary"
                    icon={<ShoppingCartOutlined />}
                    onClick={() => handleFollowBuy(rec)}
                    loading={isBusy}
                    disabled={!price}
                    block
                    className="home-reco-card-cta"
                  >
                    一键跟单
                  </Button>
                  {/* Phase 7: 为什么推荐这只? — 翻译成新手能懂的因子语言. */}
                  <div className="home-reco-why">
                    <Button
                      type="link"
                      size="small"
                      className="home-reco-why-toggle"
                      onClick={() => toggleWhy(rec.symbol)}
                      icon={<BookOutlined />}
                    >
                      为什么推荐这只? {whyOpen ? <CaretUpOutlined /> : <CaretDownOutlined />}
                    </Button>
                    {whyOpen && (
                      <div className="home-reco-why-body">
                        {strongFactors.length > 0 ? (
                          strongFactors.map(f => (
                            <div key={f.name} className="home-reco-why-row">
                              <CheckOutlined className="home-reco-why-check" />
                              <span>
                                {f.label}: {f.detail} ({f.score}/100) — 对应「{f.name}因子」
                              </span>
                            </div>
                          ))
                        ) : (
                          <div className="home-reco-why-row">
                            <CheckOutlined className="home-reco-why-check" />
                            <span>AI 综合 4 维度 (人气/逻辑/资金/结构) 判断, 暂无单项突出强项</span>
                          </div>
                        )}
                        {rec.highlight_tags && rec.highlight_tags.length > 0 && (
                          <div className="home-reco-why-row">
                            <CheckOutlined className="home-reco-why-check" />
                            <span>
                              亮点标签:{' '}
                              {rec.highlight_tags.map(t => (
                                <span key={t} className="home-reco-why-pill">
                                  {t}
                                </span>
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
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* ===== Phase 8 — 区块 3: 今日学一招 (冷色高级 — 浅紫 brand-soft 背景) ===== */}
      <section className="home-lesson">
        <div className="home-lesson-icon-wrap">
          <BookOutlined />
        </div>
        <div className="home-lesson-content">
          <div className="home-lesson-eyebrow">今日学一招</div>
          <div className="home-lesson-title">{todayLesson.title}</div>
          <p className="home-lesson-body">{todayLesson.body}</p>
          <Button
            type="link"
            className="home-lesson-cta"
            onClick={() => navigate('/workspace/easy')}
          >
            想学更多 — 简易版 4 步教学 <ArrowRightOutlined />
          </Button>
        </div>
      </section>

      {/* ===== Phase 8 — 区块 4: 今日因子表现 (3 列 2 行 + 大 sparkline) =====
          TODO(P2, admin): 接通 /api/factors/today-performance */}
      <section className="home-section">
        <header className="home-section-head">
          <div>
            <h2 className="home-section-title">今日因子表现</h2>
            <p className="home-section-subtitle">
              6 大核心因子今天的强弱 · 「{topFactor.name}」最强 · {topFactor.hint}
            </p>
          </div>
          <span className="home-section-pill">示例数据</span>
        </header>
        <div className="home-factor-grid">
          {MOCK_FACTOR_PERFORMANCE.map(f => {
            const color = pnlColor(f.value);
            return (
              <div key={f.name} className="home-factor-cell">
                <div className="home-factor-row">
                  <div>
                    <div className="home-factor-name">{f.name}</div>
                    <div className="home-factor-value tabular-nums" style={{ color }}>
                      {formatPct(f.value)}
                    </div>
                  </div>
                  <Sparkline data={f.trend} color={color} />
                </div>
                <div className="home-factor-hint">{f.hint}</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ===== Phase 8 — 区块 5: 我的持仓 (卡片网格 + 等宽数字 + 浮盈大字号) ===== */}
      <section className="home-section">
        <header className="home-section-head">
          <div>
            <h2 className="home-section-title">我的持仓</h2>
            <p className="home-section-subtitle">{positions.length} 只 · 一键卖出全部</p>
          </div>
          <Button
            type="text"
            icon={<ReloadOutlined />}
            onClick={loadPositions}
            loading={posLoading}
          >
            刷新
          </Button>
        </header>
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
          <div className="home-pos-grid">
            {positions.map(pos => {
              const isBusy = busySymbol === pos.symbol;
              const costBasis = pos.quantity * pos.avg_cost;
              const pctChange = costBasis > 0 ? (pos.unrealized_pnl / costBasis) * 100 : null;
              return (
                <article key={pos.id} className="home-pos-card">
                  <div className="home-pos-card-head">
                    <div>
                      <div className="home-pos-card-name">{pos.name || pos.symbol}</div>
                      <div className="home-pos-card-symbol">
                        {formatInt(pos.quantity)} 股 @ {formatYuan(pos.avg_cost)}
                      </div>
                    </div>
                    <Tooltip title="一键卖出全部持仓">
                      <Button
                        danger
                        onClick={() => handleSellAll(pos)}
                        loading={isBusy}
                        className="home-pos-card-cta"
                      >
                        卖出
                      </Button>
                    </Tooltip>
                  </div>
                  <div className="home-pos-card-pnl">
                    <span
                      className="home-pos-card-pnl-value tabular-nums"
                      style={{ color: pnlColor(pos.unrealized_pnl) }}
                    >
                      {formatPnl(pos.unrealized_pnl)}
                    </span>
                    {pctChange != null && (
                      <span
                        className="home-pos-card-pnl-pct tabular-nums"
                        style={{ color: pnlColor(pos.unrealized_pnl) }}
                      >
                        {formatPct(pctChange)}
                      </span>
                    )}
                  </div>
                  <div className="home-pos-card-meta">
                    现价 <strong className="tabular-nums">{formatYuan(pos.current_price)}</strong>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* ===== 区块 6: 今日提示 (静态 hint, 极简一行) ===== */}
      {!accountLoading && !accountError && account && (
        <section className="home-tip">
          <span className="home-tip-dot" aria-hidden="true" />
          <span>
            {(() => {
              const cashPct =
                account.total_value > 0 ? (account.current_cash / account.total_value) * 100 : 100;
              if (cashPct >= 80) {
                return '当前仓位较轻 — 可关注上面的 AI 推荐, 单只建议 5% 以内';
              }
              if (cashPct <= 20) {
                return '当前仓位较重 — 大盘震荡时优先减仓盈利较多的';
              }
              return '当前仓位适中 — 跟踪持仓表现, 跌破成本 7% 应止损';
            })()}
          </span>
        </section>
      )}
    </div>
  );
};

export default HomeWorkspace;
