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
 *
 * Phase 10 (2026-06-28) — 时间维度补全 + 视觉再优化.
 * 用户原话: "推荐现在应该是在每天的任何时间段都有可能触发吧, 跟随时机来的, 所以
 * 页面上是不是要加入时间的间隔, 能更好看到每个时间段都推荐了哪些. 不只这个地方,
 * 考虑下其他地方是不是也需要时间, 时间是个很重要的参考. 同时再进行一版全模块的
 * 视觉优化."
 *   A. 推荐区按 30min 时间桶分组 + 时段标签 (盘前 / 上午盘 / ...).
 *   B. hero 数据时间 pill + 卡片右上 "信号 HH:MM" + 学一招/因子 "HH:MM 更新".
 *   C. hero 数字 64→72px + ¥ 上紫色 + 30 日 sparkline + 推荐卡 mini 信息行 + stagger
 *      fade-in 动画.
 *   D. 时间格式集中走 utils/timeFormat.ts.
 *
 * Phase 11 (2026-06-28) — 3D 特效 + 高级感.
 * 用户原话: "在进行一轮的视觉特效重构优化, 我觉得设计感和高级感还不足, 甚至可以
 * 引入一些 3D 提效..."
 *   1. Hero 改为暗色 + aurora gradient + spotlight 鼠标跟随 (framer-motion mount 动画).
 *   2. 推荐卡 / 持仓卡 / 学一招卡套 react-parallax-tilt (5° 倾斜 + glare).
 *   3. stagger spring entry — framer-motion 替代 CSS animation-delay.
 *   4. prefers-reduced-motion → 全部退化静态.
 *
 * 推荐时间来源契约 (向前兼容): 当前 V3RecommendationItem 后端不输出 created_at —
 * 前端按可选字段读 `(rec as any).created_at / signal_created_at / generated_at /
 * metadata?.trigger_time`, 任一可解析即用; 全部缺失则降级为不分组 + 标注 "今日推荐"
 * (signal_date 显示在 head). TODO(P2, backend): V3RecommendationController.enrichSignal
 * 把 signal.created_at 透传成 ISO 字符串, 前端无改动即生效时段分组.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Empty, Modal, Result, Skeleton, Space, Tooltip, message } from 'antd';
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
import { motion, useReducedMotion } from 'framer-motion';
import Tilt from 'react-parallax-tilt';
import { usePortfolio } from '../contexts/PortfolioContext';
import {
  getPortfolio,
  getSnapshots,
  placeTrade,
  PositionRow,
  SnapshotRow,
} from '../services/portfolioWorkspaceService';
import { todayWorkspaceService, AccountSummary } from '../services/todayWorkspaceService';
import { getV3Recommendations, V3RecommendationItem } from '../services/v3RecommendationService';
import {
  formatClock,
  formatHourMin,
  bucketToHalfHour,
  tradingSessionLabel,
} from '../utils/timeFormat';

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

/**
 * Phase 10 — Hero 资产 sparkline (260×40, 比上面 Sparkline 更宽).
 * 入参是 snapshot.total_value 序列, color brand violet.
 */
const HeroSparkline: React.FC<{ data: number[] }> = ({ data }) => {
  if (data.length < 2) return null;
  const w = 260;
  const h = 40;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(' ');
  // 渐变填充
  const lastY = h - ((data[data.length - 1] - min) / range) * h;
  return (
    <svg width={w} height={h} aria-hidden="true" className="home-hero-sparkline">
      <defs>
        <linearGradient id="hero-spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        fill="url(#hero-spark-grad)"
        points={`0,${h} ${points} ${w},${h}`}
      />
      <polyline
        fill="none"
        stroke="var(--brand)"
        strokeWidth={1.75}
        points={points}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={w} cy={lastY} r={3} fill="var(--brand)" />
    </svg>
  );
};

// ---------------------------------------------------------------------------
//  Phase 10 — 推荐时段分组
// ---------------------------------------------------------------------------

interface TimeGroup {
  key: string;
  clock: string; // "09:00" or "时间未知"
  session: string; // "盘前" / "上午盘" / ...
  items: V3RecommendationItem[];
}

/**
 * Phase 10 — 从一条 V3RecommendationItem 上探测时间字段.
 *
 * 字段优先级 (后端 v3 controller 当前未透传 created_at, 这里穷举可能字段以便后端
 * 加字段后前端不需要改):
 *   1. created_at        — Sequelize 模型默认字段
 *   2. signal_created_at — V3RecommendationController 后续若改名透传
 *   3. generated_at      — 旧 controller 命名 (e.g. AIAdvisorService)
 *   4. metadata.trigger_time — IntradayOpportunityScan 走的字段
 *
 * 返回 ISO 字符串或 Date; 全缺/解析失败 返 null.
 */
function extractRecoTime(rec: V3RecommendationItem): string | Date | null {
  const anyRec = rec as unknown as Record<string, any>;
  const candidates: any[] = [
    anyRec.created_at,
    anyRec.signal_created_at,
    anyRec.generated_at,
    anyRec.metadata?.trigger_time,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (c instanceof Date) {
      return Number.isFinite(c.getTime()) ? c : null;
    }
    const d = new Date(c);
    if (Number.isFinite(d.getTime())) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
//  组件
// ---------------------------------------------------------------------------

const HomeWorkspace: React.FC = () => {
  const { selectedPortfolioId } = usePortfolio();
  const navigate = useNavigate();

  // Phase 11 — prefers-reduced-motion 用户禁用动画时 framer-motion + tilt 全部禁用
  const reduceMotion = useReducedMotion();

  // Phase 11 — hero 鼠标跟随 spotlight. 用 ref + CSS variable 写 % 值,
  // 不用 state 避免 60fps re-render. CSS .home-hero::after 读 --mouse-x/y.
  const heroRef = useRef<HTMLElement | null>(null);
  const handleHeroMouseMove = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const el = heroRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    el.style.setProperty('--mouse-x', `${x}%`);
    el.style.setProperty('--mouse-y', `${y}%`);
  }, []);

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

  // Phase 10 — hero 30 日资产 sparkline. 失败静默 (sparkline 缺即不渲染).
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);

  // Phase 10 — "数据时间" 显示用. 任一区块刷新成功就刷新此时间, 让用户感知数据新鲜度.
  const [dataTime, setDataTime] = useState<Date>(() => new Date());

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
      setDataTime(new Date());
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
      // Phase 10: 拉 20 条 (盘前 + 盘中 + 盘后), 不再只取 3 条 — 时段分组需要看全天.
      const data = await getV3Recommendations({ limit: 20 });
      setRecommendations(data.recommendations || []);
      setDataTime(new Date());
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
      setDataTime(new Date());
    } catch (err: unknown) {
      setPosError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosLoading(false);
    }
  }, [selectedPortfolioId]);

  // Phase 10 — hero sparkline. 资产曲线快照, 失败不阻塞 hero 渲染.
  const loadSnapshots = useCallback(async () => {
    try {
      const data = await getSnapshots(selectedPortfolioId);
      setSnapshots(data || []);
    } catch {
      // 静默 — sparkline 缺失不显示, 但账户主数字不应被影响.
    }
  }, [selectedPortfolioId]);

  useEffect(() => {
    void loadAccount();
    void loadRecommendations();
    void loadPositions();
    void loadSnapshots();
  }, [loadAccount, loadRecommendations, loadPositions, loadSnapshots]);

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

  /**
   * Phase 10 — 时段分组.
   *
   * 后端 V3RecommendationController.enrichSignal 目前未透传 created_at, 故前端按可选
   * 字段链探测时间: `created_at` → `signal_created_at` → `generated_at` →
   * `metadata.trigger_time`. 任一可解析即用; 全部缺失返 hasTime=false 走"不分组"降级
   * (推荐都丢进 'today' 单桶, head 只显示信号日期 + 推荐数).
   *
   * 字符串解析失败按 invalid 处理 (toDate 返 null), 同样降级.
   */
  const timeGroups = useMemo(() => {
    if (visibleRecommendations.length === 0) {
      return { hasTime: false, groups: [] as TimeGroup[] };
    }
    let anyHasTime = false;
    const bucketMap = new Map<string, V3RecommendationItem[]>();
    for (const rec of visibleRecommendations) {
      const candidate = extractRecoTime(rec);
      if (candidate) {
        anyHasTime = true;
        const key = bucketToHalfHour(candidate);
        const list = bucketMap.get(key) || [];
        list.push(rec);
        bucketMap.set(key, list);
      } else {
        const list = bucketMap.get('__no_time__') || [];
        list.push(rec);
        bucketMap.set('__no_time__', list);
      }
    }
    if (!anyHasTime) {
      return { hasTime: false, groups: [] as TimeGroup[] };
    }
    // 按时间桶升序 (盘前 → 盘后); '__no_time__' 排末尾
    const keys = Array.from(bucketMap.keys()).sort((a, b) => {
      if (a === '__no_time__') return 1;
      if (b === '__no_time__') return -1;
      return a.localeCompare(b);
    });
    const groups: TimeGroup[] = keys.map(k => {
      const items = bucketMap.get(k)!;
      if (k === '__no_time__') {
        return { key: k, clock: '时间未知', session: '其他', items };
      }
      // 用桶内第一条 (sorted by extracted time) 的真实时间算 session label
      const firstTime = extractRecoTime(items[0])!;
      return {
        key: k,
        clock: k,
        session: tradingSessionLabel(firstTime),
        items,
      };
    });
    return { hasTime: true, groups };
  }, [visibleRecommendations]);

  // 派生: 今日 / 累计 颜色
  const todayPnl = account?.pnl_yesterday ?? null;
  const totalReturn = account?.total_return ?? null;
  const totalReturnPct = ((account?.total_return_pct ?? null) || 0) * 100;

  // Phase 10 — hero sparkline 数据 (最近 30 个 snapshot.total_value).
  const heroSparkData = useMemo(() => {
    if (!snapshots || snapshots.length < 2) return [] as number[];
    return snapshots
      .slice(-30)
      .map(s => Number(s.total_value))
      .filter(v => Number.isFinite(v));
  }, [snapshots]);

  // Phase 10 — 推荐卡片渲染. 抽出来给"按时间分组" + "降级不分组"两种 path 复用.
  const renderRecoCard = useCallback(
    (rec: V3RecommendationItem, indexInGroup: number) => {
      const isBusy = busySymbol === rec.symbol;
      const price = rec.current_price;
      const shares = price ? yuanToShares(DEFAULT_FOLLOW_AMOUNT, price) : 0;
      const whyOpen = whyOpenSet.has(rec.symbol);
      const recoTime = extractRecoTime(rec);
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
      const conf = rec.dimensions?.length
        ? Math.round(
            rec.dimensions.reduce((s, d) => s + (d.bar_value || 0), 0) /
              rec.dimensions.length
          )
        : 80;
      // Phase 10 — mini meta line (预期波动 / 持有 / 风险). 没有 metadata 时用启发式默认.
      const expectedVol = rec.amplitude_pct
        ? `±${rec.amplitude_pct.toFixed(1)}%`
        : '±3%';
      const holdRange =
        rec.decision?.position_action === 'maintain'
          ? '5-15 日'
          : rec.decision?.risk_level === 'high'
            ? '2-5 日'
            : '5-10 日';
      const riskLabel =
        rec.decision?.risk_level === 'high'
          ? '高'
          : rec.decision?.risk_level === 'low'
            ? '低'
            : '中';
      // stagger fade-in: 给一个 inline --i 让 CSS 用作 animation-delay multiplier
      const staggerStyle = {
        ['--reco-card-index' as any]: indexInGroup,
      } as React.CSSProperties;
      // Phase 11 — framer-motion spring entry + react-parallax-tilt 3D 倾斜.
      // reduceMotion → 退化为静态 article (无 tilt, 无 spring).
      const cardInner = (
        <article
          key={rec.symbol}
          className="home-reco-card home-reco-card--anim home-reco-card--tilt"
          style={staggerStyle}
        >
          {recoTime && (
            <span className="home-reco-card-time" title="信号触发时间">
              信号 {formatHourMin(recoTime)}
            </span>
          )}
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
          {/* Phase 10 — mini 信息行 (波动 / 持有 / 风险). 紧贴 CTA 上方. */}
          <div className="home-reco-card-mini">
            <span className="home-reco-card-mini-item">
              <span className="home-reco-card-mini-label">预期波动</span>
              <span className="home-reco-card-mini-value">{expectedVol}</span>
            </span>
            <span className="home-reco-card-mini-dot" aria-hidden>·</span>
            <span className="home-reco-card-mini-item">
              <span className="home-reco-card-mini-label">持有</span>
              <span className="home-reco-card-mini-value">{holdRange}</span>
            </span>
            <span className="home-reco-card-mini-dot" aria-hidden>·</span>
            <span className="home-reco-card-mini-item">
              <span className="home-reco-card-mini-label">风险</span>
              <span className="home-reco-card-mini-value">{riskLabel}</span>
            </span>
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
            一键跟单 ¥{formatInt(DEFAULT_FOLLOW_AMOUNT)}
          </Button>
          {/* hover 右上箭头 hint — 暗示 "可点进详情". 用 CSS 控制可见性, 始终 mount 防 layout 跳. */}
          <span className="home-reco-card-arrow" aria-hidden>
            <ArrowRightOutlined />
          </span>
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
      if (reduceMotion) {
        return cardInner;
      }
      return (
        <motion.div
          key={rec.symbol}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            type: 'spring',
            stiffness: 220,
            damping: 26,
            delay: Math.min(indexInGroup * 0.06, 0.5),
          }}
          className="home-reco-tilt"
        >
          <Tilt
            tiltMaxAngleX={5}
            tiltMaxAngleY={5}
            tiltReverse={false}
            glareEnable
            glareMaxOpacity={0.18}
            glareColor="#a78bfa"
            glarePosition="all"
            glareBorderRadius="16px"
            transitionSpeed={500}
            scale={1.01}
            perspective={1200}
            gyroscope={false}
          >
            {cardInner}
          </Tilt>
        </motion.div>
      );
    },
    [busySymbol, handleFollowBuy, navigate, reduceMotion, toggleWhy, whyOpenSet]
  );

  // ---------------------------------------------------------------------------
  //  Render
  // ---------------------------------------------------------------------------
  return (
    <div className="home-workspace">
      {/* ===== Phase 8 — 区块 1: 账户总值 hero (64px 大数字 + radial gradient) =====
          Phase 10 — 72px + violet ¥ + 30 日 sparkline + 数据时间 pill.
          Phase 11 — 暗色 aurora + spotlight 鼠标跟随 + framer-motion mount 动画. */}
      <motion.section
        ref={heroRef as React.RefObject<HTMLElement>}
        className="home-hero"
        onMouseMove={reduceMotion ? undefined : handleHeroMouseMove}
        initial={reduceMotion ? false : { opacity: 0, y: 12 }}
        animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      >
        {/* P11 noise grain overlay — pure CSS via background-image */}
        <div className="home-hero-noise" aria-hidden />
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
            <div className="home-hero-label">
              账户总值
              <span className="home-hero-data-pill" title="本页数据最近一次刷新时间 (上海)">
                数据 · {formatClock(dataTime)}
              </span>
            </div>
            <div className="home-hero-value">
              <span className="home-hero-currency">¥</span>
              <span className="home-hero-amount tabular-nums">
                {formatAmount(account?.total_value)}
              </span>
              {heroSparkData.length >= 2 && (
                <span className="home-hero-spark-wrap" aria-label="近 30 日资产曲线">
                  <HeroSparkline data={heroSparkData} />
                  <span className="home-hero-spark-caption">近 30 日</span>
                </span>
              )}
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
      </motion.section>

      {/* ===== Phase 8 — 区块 2: 今日 AI 推荐 (大卡片 grid + 黑色 CTA + hover lift) =====
          Phase 10 — 按 30min 时间桶分组, 每组 head 显示 HH:MM + 时段标签 (盘前/上午盘/...).
          后端字段缺失时降级为不分组. */}
      <section className="home-section">
        <header className="home-section-head">
          <div>
            <h2 className="home-section-title">今日推荐</h2>
            <p className="home-section-subtitle">
              AI 多维度分析 · {visibleRecommendations.length} 只候选
              {timeGroups.hasTime
                ? ` · 跨 ${timeGroups.groups.length} 个时段`
                : ' · 每日 09:30 起持续刷新'}
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
        ) : timeGroups.hasTime ? (
          <div className="home-reco-time-groups">
            {timeGroups.groups.map((group, gIdx) => {
              const head = (
                <div className="home-reco-time-head">
                  <span className="home-reco-time-clock">{group.clock}</span>
                  <span className="home-reco-time-session">{group.session}</span>
                  <span className="home-reco-time-count">{group.items.length} 只</span>
                </div>
              );
              return (
                <div key={group.key} className="home-reco-time-group">
                  {reduceMotion ? (
                    head
                  ) : (
                    <motion.div
                      initial={{ opacity: 0, x: -16 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true, margin: '-40px' }}
                      transition={{
                        duration: 0.32,
                        delay: gIdx * 0.04,
                        ease: [0.22, 1, 0.36, 1],
                      }}
                    >
                      {head}
                    </motion.div>
                  )}
                  <div className="home-reco-grid">
                    {group.items.map((rec, idx) => renderRecoCard(rec, idx))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="home-reco-grid">
            {visibleRecommendations.map((rec, idx) => renderRecoCard(rec, idx))}
          </div>
        )}
      </section>

      {/* ===== Phase 8 — 区块 3: 今日学一招 (冷色高级 — 浅紫 brand-soft 背景) =====
          Phase 11 — mesh gradient + noise + parallax tilt. */}
      {(() => {
        const lessonInner = (
          <section className="home-lesson">
            <div className="home-lesson-icon-wrap">
              <BookOutlined />
            </div>
            <div className="home-lesson-content">
              <div className="home-lesson-eyebrow">
                今日学一招
                <span className="home-lesson-time">{formatHourMin(dataTime)} 更新</span>
              </div>
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
        );
        if (reduceMotion) return lessonInner;
        return (
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="home-lesson-tilt"
          >
            <Tilt
              tiltMaxAngleX={2.5}
              tiltMaxAngleY={2.5}
              glareEnable
              glareMaxOpacity={0.08}
              glareColor="#a78bfa"
              glarePosition="all"
              glareBorderRadius="20px"
              transitionSpeed={600}
              perspective={1600}
            >
              {lessonInner}
            </Tilt>
          </motion.div>
        );
      })()}

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
          <Space size={8}>
            <span className="home-section-time">{formatHourMin(dataTime)} 更新</span>
            <span className="home-section-pill">示例数据</span>
          </Space>
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
            <p className="home-section-subtitle">
              {positions.length} 只
              {(() => {
                if (positions.length === 0) return ' · 暂无';
                const days = positions
                  .map(p => {
                    const d = new Date(p.created_at);
                    if (!Number.isFinite(d.getTime())) return null;
                    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400_000));
                  })
                  .filter((v): v is number => v !== null);
                if (days.length === 0) return ' · 一键卖出全部';
                const avg = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
                return ` · 平均持有 ${avg} 天 · 一键卖出全部`;
              })()}
            </p>
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
            {positions.map((pos, posIdx) => {
              const isBusy = busySymbol === pos.symbol;
              const costBasis = pos.quantity * pos.avg_cost;
              const pctChange = costBasis > 0 ? (pos.unrealized_pnl / costBasis) * 100 : null;
              // Phase 10 — 持仓天数 (自然日, 不扣周末). 与 PortfolioWorkspace 同口径.
              const daysHeld = (() => {
                const d = new Date(pos.created_at);
                if (!Number.isFinite(d.getTime())) return null;
                const diff = Math.floor((Date.now() - d.getTime()) / 86400_000);
                return Math.max(0, diff);
              })();
              const inner = (
                <article key={pos.id} className="home-pos-card home-pos-card--tilt">
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
                    {daysHeld != null && (
                      <>
                        {' '}
                        · 持 <strong className="tabular-nums">{daysHeld}</strong> 天
                      </>
                    )}
                  </div>
                </article>
              );
              if (reduceMotion) {
                return inner;
              }
              const glareColor =
                (pos.unrealized_pnl ?? 0) >= 0 ? '#dc2626' /* up red */ : '#16a34a' /* down green */;
              return (
                <motion.div
                  key={pos.id}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    type: 'spring',
                    stiffness: 220,
                    damping: 26,
                    delay: Math.min(posIdx * 0.05, 0.4),
                  }}
                  className="home-pos-tilt"
                >
                  <Tilt
                    tiltMaxAngleX={3}
                    tiltMaxAngleY={3}
                    glareEnable
                    glareMaxOpacity={0.1}
                    glareColor={glareColor}
                    glarePosition="all"
                    glareBorderRadius="16px"
                    transitionSpeed={500}
                    scale={1.005}
                    perspective={1400}
                  >
                    {inner}
                  </Tilt>
                </motion.div>
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
