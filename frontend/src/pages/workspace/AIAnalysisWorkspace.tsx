import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AutoComplete, Button, Empty, Input, Space, Tag, Typography } from 'antd';
import {
  LineChartOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import WorkspaceLayout from '../../components/layout/WorkspaceLayout';
import WorkspaceHero from '../../components/layout/WorkspaceHero';
import AIStockAnalysisModal from '../../components/trading/AIStockAnalysisModal';
import { searchStocks } from '../../services/api';

const { Text } = Typography;

/**
 * AIAnalysisWorkspace — 导航栏「AI 分析」一级入口 (2026-07-04).
 *
 * 用户原话: "我希望导航栏有个 Tab 可以直接触发 AI 分析".
 * 之前 AI 解读 (AIStockAnalysisModal) 只能从持仓行 / 因子选股行 / 今日信号
 * 里点某只股票的入口进. 这里给一个不依附任何列表的独立落地页:
 *   1. 顶部搜索框 (代码 / 名称 AutoComplete, 后端 /market/search);
 *   2. 选中即触发 → 打开多维度 AI 分析 Modal;
 *   3. 最近分析过的股票 chip, 一键重开 (localStorage, 用户维度).
 * 复用既有 AIStockAnalysisModal, 不新增后端.
 */

interface StockHit {
  symbol: string;
  name: string | null;
}

const RECENT_KEY = 'ai_analysis_recent_v1';
const RECENT_MAX = 8;

const loadRecent = (): StockHit[] => {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(x => x && x.symbol).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
};

const AIAnalysisWorkspace: React.FC = () => {
  const [keyword, setKeyword] = useState('');
  const [options, setOptions] = useState<
    Array<{ value: string; label: React.ReactNode; hit: StockHit }>
  >([]);
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<StockHit | null>(null);
  const [recent, setRecent] = useState<StockHit[]>(loadRecent);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const pushRecent = useCallback((hit: StockHit) => {
    setRecent(prev => {
      const next = [hit, ...prev.filter(x => x.symbol !== hit.symbol)].slice(0, RECENT_MAX);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* ignore quota */
      }
      return next;
    });
  }, []);

  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setOptions([]);
      return;
    }
    setSearching(true);
    searchStocks(trimmed, 20)
      .then(res => {
        const stocks: any[] = res?.data?.data?.stocks || res?.data?.stocks || [];
        setOptions(
          stocks.map((s: any) => {
            const hit: StockHit = { symbol: s.symbol, name: s.name ?? null };
            return {
              value: s.symbol,
              hit,
              label: (
                <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
                  <span>
                    <Text strong>{s.symbol}</Text>
                    {s.name ? <Text style={{ marginLeft: 8 }}>{s.name}</Text> : null}
                  </span>
                  {s.industry ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {s.industry}
                    </Text>
                  ) : null}
                </Space>
              ),
            };
          })
        );
      })
      .catch(() => setOptions([]))
      .finally(() => setSearching(false));
  }, []);

  const handleKeywordChange = useCallback(
    (val: string) => {
      setKeyword(val);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => runSearch(val), 250);
    },
    [runSearch]
  );

  const trigger = useCallback(
    (hit: StockHit) => {
      setTarget(hit);
      pushRecent(hit);
    },
    [pushRecent]
  );

  const handleSelect = useCallback(
    (value: string, option: any) => {
      const hit: StockHit = option?.hit || { symbol: value, name: null };
      setKeyword('');
      setOptions([]);
      trigger(hit);
    },
    [trigger]
  );

  const handleManualRun = useCallback(() => {
    const trimmed = keyword.trim();
    if (!trimmed) return;
    // 用户直接敲代码回车 / 点按钮: 优先用第一条候选, 否则按原样当代码.
    const first = options[0]?.hit;
    trigger(
      first && first.symbol.toUpperCase() === trimmed.toUpperCase()
        ? first
        : first || { symbol: trimmed, name: null }
    );
  }, [keyword, options, trigger]);

  const hero = useMemo(
    () => (
      <WorkspaceHero
        eyebrow="AI · 智能解读"
        title="AI 决策测算"
        subtitle="给一只股票：TradingAgents 做研究，当前行情把结论落到买点、卖点与风险线"
        variant="violet"
        rightSlot={
          <div className="ai-analysis-hero-icon" aria-hidden>
            <RobotOutlined />
          </div>
        }
      />
    ),
    []
  );

  return (
    <>
      <WorkspaceLayout
        title="AI 决策测算"
        subtitle="研究结论与价格计划分层呈现；不会自动下单，也不承诺收益。"
        hero={hero}
        themed
      >
        <div className="ai-analysis-launch">
          <div className="ai-analysis-capabilities" aria-label="分析能力">
            <div>
              <RobotOutlined />
              <span>多智能体会审</span>
              <small>基本面、技术面、新闻与情绪交叉验证</small>
            </div>
            <div>
              <LineChartOutlined />
              <span>当前价测算</span>
              <small>ATR、支撑压力、买卖区间与整手数量</small>
            </div>
            <div>
              <SafetyCertificateOutlined />
              <span>风险先行</span>
              <small>行情过期自动降级，明确止损和仓位上限</small>
            </div>
          </div>
          <div className="ai-analysis-launch__label">
            <SearchOutlined /> 选择要分析的股票
          </div>
          <Space.Compact style={{ width: '100%' }}>
            <AutoComplete
              value={keyword}
              options={options}
              onChange={handleKeywordChange}
              onSelect={handleSelect}
              style={{ width: '100%' }}
              popupMatchSelectWidth={false}
              notFoundContent={searching ? '搜索中…' : keyword.trim() ? '无匹配股票' : null}
            >
              <Input
                size="large"
                allowClear
                placeholder="输入股票代码或名称，如 600519 / 贵州茅台"
                prefix={<SearchOutlined style={{ color: 'var(--ink-4)' }} />}
                onPressEnter={handleManualRun}
              />
            </AutoComplete>
            <Button
              size="large"
              type="primary"
              icon={<ThunderboltOutlined />}
              disabled={!keyword.trim()}
              onClick={handleManualRun}
            >
              开始分析
            </Button>
          </Space.Compact>

          <div className="ai-analysis-recent">
            <div className="ai-analysis-recent__head">最近分析</div>
            {recent.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有分析记录，搜索一只股票开始吧"
                style={{ margin: '12px 0' }}
              />
            ) : (
              <Space wrap size={[8, 8]}>
                {recent.map(hit => (
                  <Tag
                    key={hit.symbol}
                    className="ai-analysis-recent__chip"
                    onClick={() => trigger(hit)}
                  >
                    <RobotOutlined style={{ marginRight: 6, color: 'var(--brand)' }} />
                    <Text strong>{hit.symbol}</Text>
                    {hit.name ? <Text style={{ marginLeft: 6 }}>{hit.name}</Text> : null}
                  </Tag>
                ))}
              </Space>
            )}
          </div>
        </div>
      </WorkspaceLayout>

      {target && (
        <AIStockAnalysisModal
          open={!!target}
          onClose={() => setTarget(null)}
          stockCode={target.symbol}
          stockName={target.name}
          taskLabel="ai_analysis_hub"
        />
      )}
    </>
  );
};

export default AIAnalysisWorkspace;
