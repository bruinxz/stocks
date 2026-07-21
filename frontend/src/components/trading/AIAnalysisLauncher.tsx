import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AutoComplete, Button, Empty, Input, Space, Tag, Typography } from 'antd';
import {
  LineChartOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import AIStockAnalysisModal from './AIStockAnalysisModal';
import { searchStocks } from '../../services/api';

const { Text } = Typography;

interface StockHit {
  symbol: string;
  name: string | null;
}

interface AIAnalysisLauncherProps {
  taskLabel?: string;
  compact?: boolean;
}

const RECENT_KEY = 'ai_analysis_recent_v1';
const RECENT_MAX = 8;

function loadRecent(): StockHit[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows.filter(row => row?.symbol).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** 搜股、最近分析和分析弹窗的唯一实现，供独立工作区与 CatDesk 页签复用。 */
export default function AIAnalysisLauncher({
  taskLabel = 'ai_analysis_hub',
  compact = false,
}: AIAnalysisLauncherProps) {
  const [keyword, setKeyword] = useState('');
  const [options, setOptions] = useState<
    Array<{ value: string; label: React.ReactNode; hit: StockHit }>
  >([]);
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<StockHit | null>(null);
  const [recent, setRecent] = useState<StockHit[]>(loadRecent);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSequenceRef = useRef(0);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  const trigger = useCallback((hit: StockHit) => {
    setTarget(hit);
    setRecent(previous => {
      const next = [hit, ...previous.filter(row => row.symbol !== hit.symbol)].slice(0, RECENT_MAX);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // localStorage quota 不应阻塞分析。
      }
      return next;
    });
  }, []);

  const runSearch = useCallback((value: string, sequence: number) => {
    const query = value.trim();
    if (!query) {
      if (sequence === searchSequenceRef.current) setOptions([]);
      return;
    }
    setSearching(true);
    searchStocks(query, 20)
      .then(response => {
        if (sequence !== searchSequenceRef.current) return;
        const stocks: any[] = response?.data?.data?.stocks || response?.data?.stocks || [];
        setOptions(
          stocks.map(stock => {
            const hit: StockHit = { symbol: stock.symbol, name: stock.name ?? null };
            return {
              value: stock.symbol,
              hit,
              label: (
                <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
                  <span>
                    <Text strong>{stock.symbol}</Text>
                    {stock.name ? <Text style={{ marginLeft: 8 }}>{stock.name}</Text> : null}
                  </span>
                  {stock.industry ? <Text type="secondary">{stock.industry}</Text> : null}
                </Space>
              ),
            };
          })
        );
      })
      .catch(() => {
        if (sequence === searchSequenceRef.current) setOptions([]);
      })
      .finally(() => {
        if (sequence === searchSequenceRef.current) setSearching(false);
      });
  }, []);

  const changeKeyword = useCallback(
    (value: string) => {
      setKeyword(value);
      setOptions([]);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const sequence = ++searchSequenceRef.current;
      debounceRef.current = setTimeout(() => runSearch(value, sequence), 250);
    },
    [runSearch]
  );

  const runManual = useCallback(() => {
    const query = keyword.trim();
    if (!query) return;
    const first = options[0]?.hit;
    const normalizedQuery = query.toUpperCase().replace(/^(SH|SZ)\./, '');
    const firstMatches =
      first &&
      (first.symbol.toUpperCase().replace(/^(SH|SZ)\./, '') === normalizedQuery ||
        String(first.name || '').trim() === query);
    trigger(firstMatches ? first : { symbol: query, name: null });
  }, [keyword, options, trigger]);

  return (
    <>
      <div className={`ai-analysis-launch${compact ? ' is-compact' : ''}`}>
        <div className="ai-analysis-capabilities" aria-label="分析能力">
          <div>
            <RobotOutlined />
            <span>多智能体会审</span>
            <small>基本面、技术面、新闻与情绪交叉验证</small>
          </div>
          <div>
            <LineChartOutlined />
            <span>当前价测算</span>
            <small>买卖区间、止损止盈与整手数量</small>
          </div>
          <div>
            <SafetyCertificateOutlined />
            <span>风险先行</span>
            <small>行情过期自动降级，不用旧价格制造结论</small>
          </div>
        </div>
        <div className="ai-analysis-launch__label">
          <SearchOutlined /> 选择要分析的股票
        </div>
        <Space.Compact style={{ width: '100%' }}>
          <AutoComplete
            value={keyword}
            options={options}
            onChange={changeKeyword}
            onSelect={(value, option: any) => {
              setKeyword('');
              setOptions([]);
              trigger(option?.hit || { symbol: value, name: null });
            }}
            style={{ width: '100%' }}
            popupMatchSelectWidth={false}
            notFoundContent={searching ? '搜索中…' : keyword.trim() ? '无匹配股票' : null}
          >
            <Input
              size="large"
              allowClear
              placeholder="输入股票代码或名称，如 600519 / 贵州茅台"
              prefix={<SearchOutlined />}
              onPressEnter={runManual}
            />
          </AutoComplete>
          <Button
            size="large"
            type="primary"
            icon={<ThunderboltOutlined />}
            disabled={!keyword.trim()}
            onClick={runManual}
          >
            开始分析
          </Button>
        </Space.Compact>

        <div className="ai-analysis-recent">
          <div className="ai-analysis-recent__head">最近分析</div>
          {recent.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有分析记录" />
          ) : (
            <Space wrap size={[8, 8]}>
              {recent.map(hit => (
                <Tag
                  key={hit.symbol}
                  className="ai-analysis-recent__chip"
                  onClick={() => trigger(hit)}
                >
                  <RobotOutlined /> <Text strong>{hit.symbol}</Text>
                  {hit.name ? <Text style={{ marginLeft: 6 }}>{hit.name}</Text> : null}
                </Tag>
              ))}
            </Space>
          )}
        </div>
      </div>

      {target ? (
        <AIStockAnalysisModal
          open
          onClose={() => setTarget(null)}
          stockCode={target.symbol}
          stockName={target.name}
          taskLabel={taskLabel}
        />
      ) : null}
    </>
  );
}
