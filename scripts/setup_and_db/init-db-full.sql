--
-- PostgreSQL database dump
--

\restrict xbqIeVxwDr7WagVvaDxsaU6jhWSzQ1szbPjDXPBqzLM5FkKmshPQPaWjOc0owjs

-- Dumped from database version 14.22 (Homebrew)
-- Dumped by pg_dump version 14.22 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: enum_paper_trading_trades_direction; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.enum_paper_trading_trades_direction AS ENUM (
    'BUY',
    'SELL'
);


ALTER TYPE public.enum_paper_trading_trades_direction OWNER TO postgres;

--
-- Name: enum_trades_direction; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.enum_trades_direction AS ENUM (
    'long',
    'short'
);


ALTER TYPE public.enum_trades_direction OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: backtest_results; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.backtest_results (
    id uuid NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    user_id integer NOT NULL,
    strategy_config jsonb NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    initial_capital numeric(20,4) NOT NULL,
    final_capital numeric(20,4) NOT NULL,
    total_return numeric(10,4) NOT NULL,
    annualized_return numeric(10,4),
    sharpe_ratio numeric(10,4),
    sortino_ratio numeric(10,4),
    max_drawdown numeric(10,4),
    win_rate numeric(10,4),
    profit_loss_ratio numeric(10,4),
    total_trades integer DEFAULT 0 NOT NULL,
    profit_trades integer DEFAULT 0 NOT NULL,
    loss_trades integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying,
    error_message text,
    detailed_metrics jsonb,
    annualized_volatility numeric(10,4),
    information_ratio numeric(10,4),
    calmar_ratio numeric(10,4),
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    equity_curve jsonb,
    daily_returns jsonb
);


ALTER TABLE public.backtest_results OWNER TO postgres;

--
-- Name: COLUMN backtest_results.name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.name IS '回测名称';


--
-- Name: COLUMN backtest_results.description; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.description IS '回测描述';


--
-- Name: COLUMN backtest_results.user_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.user_id IS '用户ID';


--
-- Name: COLUMN backtest_results.strategy_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.strategy_config IS '策略配置';


--
-- Name: COLUMN backtest_results.start_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.start_date IS '开始日期';


--
-- Name: COLUMN backtest_results.end_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.end_date IS '结束日期';


--
-- Name: COLUMN backtest_results.initial_capital; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.initial_capital IS '初始资金';


--
-- Name: COLUMN backtest_results.final_capital; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.final_capital IS '最终资金';


--
-- Name: COLUMN backtest_results.total_return; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.total_return IS '总收益率(%)';


--
-- Name: COLUMN backtest_results.annualized_return; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.annualized_return IS '年化收益率(%)';


--
-- Name: COLUMN backtest_results.sharpe_ratio; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.sharpe_ratio IS '夏普比率';


--
-- Name: COLUMN backtest_results.sortino_ratio; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.sortino_ratio IS '索提诺比率';


--
-- Name: COLUMN backtest_results.max_drawdown; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.max_drawdown IS '最大回撤(%)';


--
-- Name: COLUMN backtest_results.win_rate; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.win_rate IS '胜率(%)';


--
-- Name: COLUMN backtest_results.profit_loss_ratio; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.profit_loss_ratio IS '盈亏比';


--
-- Name: COLUMN backtest_results.total_trades; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.total_trades IS '总交易次数';


--
-- Name: COLUMN backtest_results.profit_trades; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.profit_trades IS '盈利交易次数';


--
-- Name: COLUMN backtest_results.loss_trades; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.loss_trades IS '亏损交易次数';


--
-- Name: COLUMN backtest_results.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.status IS '回测状态';


--
-- Name: COLUMN backtest_results.error_message; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.error_message IS '错误信息';


--
-- Name: COLUMN backtest_results.detailed_metrics; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.detailed_metrics IS '详细指标';


--
-- Name: COLUMN backtest_results.annualized_volatility; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.annualized_volatility IS '年化波动率';


--
-- Name: COLUMN backtest_results.information_ratio; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.information_ratio IS '信息比率';


--
-- Name: COLUMN backtest_results.calmar_ratio; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.calmar_ratio IS '卡玛比率';


--
-- Name: COLUMN backtest_results.equity_curve; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.equity_curve IS '资金曲线';


--
-- Name: COLUMN backtest_results.daily_returns; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.backtest_results.daily_returns IS '每日收益率';


--
-- Name: daily_bars; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.daily_bars (
    "time" timestamp with time zone NOT NULL,
    stock_id integer NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume bigint NOT NULL,
    turnover numeric(20,4),
    adj_close numeric(12,4),
    turnover_rate numeric(10,4),
    change_percent numeric(10,4),
    amplitude numeric(10,4),
    pe numeric(10,4),
    pb numeric(10,4),
    ps numeric(10,4),
    market_cap numeric(20,4),
    is_trading_day boolean DEFAULT true,
    is_suspended boolean DEFAULT false,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


ALTER TABLE public.daily_bars OWNER TO postgres;

--
-- Name: COLUMN daily_bars."time"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars."time" IS '交易时间';


--
-- Name: COLUMN daily_bars.stock_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.stock_id IS '股票ID';


--
-- Name: COLUMN daily_bars.open; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.open IS '开盘价';


--
-- Name: COLUMN daily_bars.high; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.high IS '最高价';


--
-- Name: COLUMN daily_bars.low; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.low IS '最低价';


--
-- Name: COLUMN daily_bars.close; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.close IS '收盘价';


--
-- Name: COLUMN daily_bars.volume; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.volume IS '成交量（股）';


--
-- Name: COLUMN daily_bars.turnover; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.turnover IS '成交额（元）';


--
-- Name: COLUMN daily_bars.adj_close; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.adj_close IS '复权收盘价';


--
-- Name: COLUMN daily_bars.turnover_rate; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.turnover_rate IS '换手率(%)';


--
-- Name: COLUMN daily_bars.change_percent; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.change_percent IS '涨跌幅(%)';


--
-- Name: COLUMN daily_bars.amplitude; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.amplitude IS '振幅(%)';


--
-- Name: COLUMN daily_bars.pe; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.pe IS '市盈率(PE)';


--
-- Name: COLUMN daily_bars.pb; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.pb IS '市净率(PB)';


--
-- Name: COLUMN daily_bars.ps; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.ps IS '市销率(PS)';


--
-- Name: COLUMN daily_bars.market_cap; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.market_cap IS '总市值(元)';


--
-- Name: COLUMN daily_bars.is_trading_day; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.is_trading_day IS '是否交易日';


--
-- Name: COLUMN daily_bars.is_suspended; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_bars.is_suspended IS '是否停牌';


--
-- Name: daily_screeners; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.daily_screeners (
    id integer NOT NULL,
    date date NOT NULL,
    symbol character varying(20) NOT NULL,
    name character varying(100) NOT NULL,
    decision character varying(50) NOT NULL,
    rationale text,
    scores jsonb,
    score numeric(10,2),
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE public.daily_screeners OWNER TO postgres;

--
-- Name: COLUMN daily_screeners.date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_screeners.date IS '评估日期';


--
-- Name: COLUMN daily_screeners.symbol; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_screeners.symbol IS '股票代码';


--
-- Name: COLUMN daily_screeners.name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_screeners.name IS '股票名称';


--
-- Name: COLUMN daily_screeners.decision; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_screeners.decision IS 'AI 综合决策 (e.g., STRONG_BUY, BUY, HOLD, SELL)';


--
-- Name: COLUMN daily_screeners.rationale; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_screeners.rationale IS '核心看多/看空理由简述';


--
-- Name: COLUMN daily_screeners.scores; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_screeners.scores IS '各维度评分明细 (技术面、基本面、情绪面等)';


--
-- Name: COLUMN daily_screeners.score; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.daily_screeners.score IS 'AI 综合评分 (0-100)';


--
-- Name: daily_screeners_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.daily_screeners_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.daily_screeners_id_seq OWNER TO postgres;

--
-- Name: daily_screeners_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.daily_screeners_id_seq OWNED BY public.daily_screeners.id;


--
-- Name: data_update_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.data_update_logs (
    id integer NOT NULL,
    type character varying(50) NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    date date NOT NULL,
    result jsonb,
    error text,
    "affectedStocks" integer,
    "insertedRecords" integer,
    "startedAt" timestamp with time zone,
    "completedAt" timestamp with time zone,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE public.data_update_logs OWNER TO postgres;

--
-- Name: COLUMN data_update_logs.type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.data_update_logs.type IS '更新类型';


--
-- Name: COLUMN data_update_logs.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.data_update_logs.status IS '更新状态';


--
-- Name: COLUMN data_update_logs.date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.data_update_logs.date IS '更新日期（用于检查当天是否已更新）';


--
-- Name: COLUMN data_update_logs.result; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.data_update_logs.result IS '更新结果详情';


--
-- Name: COLUMN data_update_logs.error; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.data_update_logs.error IS '错误信息';


--
-- Name: COLUMN data_update_logs."affectedStocks"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.data_update_logs."affectedStocks" IS '影响的股票数量';


--
-- Name: COLUMN data_update_logs."insertedRecords"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.data_update_logs."insertedRecords" IS '插入的数据条数';


--
-- Name: COLUMN data_update_logs."startedAt"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.data_update_logs."startedAt" IS '开始时间';


--
-- Name: COLUMN data_update_logs."completedAt"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.data_update_logs."completedAt" IS '完成时间';


--
-- Name: data_update_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.data_update_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.data_update_logs_id_seq OWNER TO postgres;

--
-- Name: data_update_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.data_update_logs_id_seq OWNED BY public.data_update_logs.id;


--
-- Name: favorite_stocks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.favorite_stocks (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "stockId" integer NOT NULL,
    "groupId" character varying(50),
    tags character varying(100),
    notes text,
    "sortOrder" integer DEFAULT 0,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE public.favorite_stocks OWNER TO postgres;

--
-- Name: COLUMN favorite_stocks."userId"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.favorite_stocks."userId" IS '用户ID';


--
-- Name: COLUMN favorite_stocks."stockId"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.favorite_stocks."stockId" IS '股票ID';


--
-- Name: COLUMN favorite_stocks."groupId"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.favorite_stocks."groupId" IS '自定义分组，如 "科技股"、"蓝筹股" 等';


--
-- Name: COLUMN favorite_stocks.tags; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.favorite_stocks.tags IS '自定义标签';


--
-- Name: COLUMN favorite_stocks.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.favorite_stocks.notes IS '备注';


--
-- Name: COLUMN favorite_stocks."sortOrder"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.favorite_stocks."sortOrder" IS '排序权重，越大越靠前';


--
-- Name: favorite_stocks_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.favorite_stocks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.favorite_stocks_id_seq OWNER TO postgres;

--
-- Name: favorite_stocks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.favorite_stocks_id_seq OWNED BY public.favorite_stocks.id;


--
-- Name: paper_trading_portfolios; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_trading_portfolios (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    name character varying(100) NOT NULL,
    "initialCapital" numeric(15,2) DEFAULT 1000000 NOT NULL,
    "currentCash" numeric(15,2) DEFAULT 1000000 NOT NULL,
    "totalValue" numeric(15,2) DEFAULT 1000000 NOT NULL,
    "isActive" boolean DEFAULT true,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE public.paper_trading_portfolios OWNER TO postgres;

--
-- Name: COLUMN paper_trading_portfolios.name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_portfolios.name IS '模拟盘名称';


--
-- Name: COLUMN paper_trading_portfolios."initialCapital"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_portfolios."initialCapital" IS '初始资金';


--
-- Name: COLUMN paper_trading_portfolios."currentCash"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_portfolios."currentCash" IS '当前可用资金';


--
-- Name: COLUMN paper_trading_portfolios."totalValue"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_portfolios."totalValue" IS '当前总资产 (资金 + 持仓市值)';


--
-- Name: COLUMN paper_trading_portfolios."isActive"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_portfolios."isActive" IS '是否处于激活状态';


--
-- Name: paper_trading_portfolios_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.paper_trading_portfolios_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.paper_trading_portfolios_id_seq OWNER TO postgres;

--
-- Name: paper_trading_portfolios_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.paper_trading_portfolios_id_seq OWNED BY public.paper_trading_portfolios.id;


--
-- Name: paper_trading_positions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_trading_positions (
    id integer NOT NULL,
    "portfolioId" integer NOT NULL,
    symbol character varying(20) NOT NULL,
    name character varying(100),
    quantity integer DEFAULT 0 NOT NULL,
    "avgCost" numeric(10,3) DEFAULT 0 NOT NULL,
    "currentPrice" numeric(10,3) DEFAULT 0 NOT NULL,
    "marketValue" numeric(15,2) DEFAULT 0 NOT NULL,
    "unrealizedPnl" numeric(15,2) DEFAULT 0 NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE public.paper_trading_positions OWNER TO postgres;

--
-- Name: COLUMN paper_trading_positions.symbol; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_positions.symbol IS '股票代码';


--
-- Name: COLUMN paper_trading_positions.name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_positions.name IS '股票名称';


--
-- Name: COLUMN paper_trading_positions.quantity; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_positions.quantity IS '持有股数 (股)';


--
-- Name: COLUMN paper_trading_positions."avgCost"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_positions."avgCost" IS '平均建仓成本价';


--
-- Name: COLUMN paper_trading_positions."currentPrice"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_positions."currentPrice" IS '最新价格';


--
-- Name: COLUMN paper_trading_positions."marketValue"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_positions."marketValue" IS '当前持仓市值';


--
-- Name: COLUMN paper_trading_positions."unrealizedPnl"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_positions."unrealizedPnl" IS '浮动盈亏';


--
-- Name: paper_trading_positions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.paper_trading_positions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.paper_trading_positions_id_seq OWNER TO postgres;

--
-- Name: paper_trading_positions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.paper_trading_positions_id_seq OWNED BY public.paper_trading_positions.id;


--
-- Name: paper_trading_snapshots; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_trading_snapshots (
    id integer NOT NULL,
    "portfolioId" integer NOT NULL,
    date date NOT NULL,
    "totalValue" numeric(15,2) NOT NULL,
    "currentCash" numeric(15,2) NOT NULL,
    "positionValue" numeric(15,2) NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE public.paper_trading_snapshots OWNER TO postgres;

--
-- Name: COLUMN paper_trading_snapshots.date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_snapshots.date IS '快照日期';


--
-- Name: paper_trading_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.paper_trading_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.paper_trading_snapshots_id_seq OWNER TO postgres;

--
-- Name: paper_trading_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.paper_trading_snapshots_id_seq OWNED BY public.paper_trading_snapshots.id;


--
-- Name: paper_trading_trades; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.paper_trading_trades (
    id integer NOT NULL,
    "portfolioId" integer NOT NULL,
    symbol character varying(20) NOT NULL,
    name character varying(100) NOT NULL,
    direction public.enum_paper_trading_trades_direction NOT NULL,
    "executePrice" numeric(15,2) NOT NULL,
    quantity integer NOT NULL,
    amount numeric(15,2) NOT NULL,
    commission numeric(15,2) NOT NULL,
    "realizedPnl" numeric(15,2),
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE public.paper_trading_trades OWNER TO postgres;

--
-- Name: COLUMN paper_trading_trades.amount; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_trades.amount IS '交易金额（不含手续费）';


--
-- Name: COLUMN paper_trading_trades.commission; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_trades.commission IS '手续费';


--
-- Name: COLUMN paper_trading_trades."realizedPnl"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.paper_trading_trades."realizedPnl" IS '如果是卖出，记录本次交易的实现盈亏';


--
-- Name: paper_trading_trades_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.paper_trading_trades_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.paper_trading_trades_id_seq OWNER TO postgres;

--
-- Name: paper_trading_trades_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.paper_trading_trades_id_seq OWNED BY public.paper_trading_trades.id;


--
-- Name: risk_alerts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.risk_alerts (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    symbol character varying(20) NOT NULL,
    name character varying(100) NOT NULL,
    level character varying(50) NOT NULL,
    message text NOT NULL,
    "isRead" boolean DEFAULT false,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE public.risk_alerts OWNER TO postgres;

--
-- Name: COLUMN risk_alerts.symbol; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.risk_alerts.symbol IS '触发告警的股票代码';


--
-- Name: COLUMN risk_alerts.name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.risk_alerts.name IS '触发告警的股票名称';


--
-- Name: COLUMN risk_alerts.level; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.risk_alerts.level IS '告警级别 (e.g., HIGH, MEDIUM, LOW)';


--
-- Name: COLUMN risk_alerts.message; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.risk_alerts.message IS '告警详细内容，如 AI 建议卖出或跌破支撑位等';


--
-- Name: COLUMN risk_alerts."isRead"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.risk_alerts."isRead" IS '是否已读';


--
-- Name: risk_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.risk_alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.risk_alerts_id_seq OWNER TO postgres;

--
-- Name: risk_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.risk_alerts_id_seq OWNED BY public.risk_alerts.id;


--
-- Name: scheduled_tasks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.scheduled_tasks (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    "cronExpression" character varying(100) NOT NULL,
    type character varying(50) NOT NULL,
    parameters jsonb,
    "isActive" boolean DEFAULT true,
    "lastRunAt" timestamp with time zone,
    "lastRunStatus" character varying(50),
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE public.scheduled_tasks OWNER TO postgres;

--
-- Name: COLUMN scheduled_tasks."cronExpression"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.scheduled_tasks."cronExpression" IS 'cron表达式';


--
-- Name: COLUMN scheduled_tasks.type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.scheduled_tasks.type IS '任务类型 (e.g., SYNC_ALL_STOCKS, SYNC_HISTORY, AI_DAILY_SCREENER)';


--
-- Name: COLUMN scheduled_tasks.parameters; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.scheduled_tasks.parameters IS '任务执行参数';


--
-- Name: COLUMN scheduled_tasks."lastRunStatus"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.scheduled_tasks."lastRunStatus" IS 'SUCCESS, FAILED, RUNNING';


--
-- Name: scheduled_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.scheduled_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.scheduled_tasks_id_seq OWNER TO postgres;

--
-- Name: scheduled_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.scheduled_tasks_id_seq OWNED BY public.scheduled_tasks.id;


--
-- Name: stocks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.stocks (
    id integer NOT NULL,
    symbol character varying(10) NOT NULL,
    name character varying(100) NOT NULL,
    market character varying(10),
    industry character varying(100),
    listing_date date,
    "delistingDate" date,
    "isListed" boolean DEFAULT true,
    type character varying(50),
    "dataStatus" character varying(20),
    "totalMarketCap" numeric(20,4),
    "circulatingMarketCap" numeric(20,4),
    "peDynamic" numeric(10,4),
    pb numeric(10,4),
    "turnoverRate" numeric(10,4),
    price numeric(12,4),
    "changePercent" numeric(10,4),
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


ALTER TABLE public.stocks OWNER TO postgres;

--
-- Name: COLUMN stocks.symbol; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks.symbol IS '股票代码，如 600000.SH';


--
-- Name: COLUMN stocks.name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks.name IS '股票名称';


--
-- Name: COLUMN stocks.market; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks.market IS '市场类型：SH, SZ, BJ';


--
-- Name: COLUMN stocks.industry; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks.industry IS '所属行业';


--
-- Name: COLUMN stocks.listing_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks.listing_date IS '上市日期';


--
-- Name: COLUMN stocks."delistingDate"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks."delistingDate" IS '退市日期';


--
-- Name: COLUMN stocks."isListed"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks."isListed" IS '是否上市';


--
-- Name: COLUMN stocks.type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks.type IS '股票类型：stock, index, fund, bond';


--
-- Name: COLUMN stocks."dataStatus"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks."dataStatus" IS '数据状态：complete, incomplete, no_data, conflict';


--
-- Name: COLUMN stocks."totalMarketCap"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks."totalMarketCap" IS '最新总市值(元)';


--
-- Name: COLUMN stocks."circulatingMarketCap"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks."circulatingMarketCap" IS '最新流通市值(元)';


--
-- Name: COLUMN stocks."peDynamic"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks."peDynamic" IS '最新动态市盈率';


--
-- Name: COLUMN stocks.pb; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks.pb IS '最新市净率';


--
-- Name: COLUMN stocks."turnoverRate"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks."turnoverRate" IS '最新换手率(%)';


--
-- Name: COLUMN stocks.price; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks.price IS '最新价';


--
-- Name: COLUMN stocks."changePercent"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.stocks."changePercent" IS '最新涨跌幅(%)';


--
-- Name: stocks_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.stocks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.stocks_id_seq OWNER TO postgres;

--
-- Name: stocks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.stocks_id_seq OWNED BY public.stocks.id;


--
-- Name: trades; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.trades (
    id uuid NOT NULL,
    backtest_id uuid NOT NULL,
    entry_date timestamp with time zone NOT NULL,
    exit_date timestamp with time zone NOT NULL,
    stock_id integer NOT NULL,
    direction public.enum_trades_direction NOT NULL,
    entry_price numeric(12,4) NOT NULL,
    exit_price numeric(12,4) NOT NULL,
    quantity integer NOT NULL,
    pnl numeric(12,4) NOT NULL,
    pnl_percent numeric(10,4) NOT NULL,
    holding_days integer NOT NULL,
    entry_value numeric(12,4) NOT NULL,
    exit_value numeric(12,4) NOT NULL,
    commission numeric(10,4),
    stamp_duty numeric(10,4),
    transfer_fee numeric(10,4),
    total_fee numeric(10,4),
    net_pnl numeric(10,4),
    entry_signal character varying(50),
    exit_signal character varying(50),
    notes text,
    created_at timestamp with time zone,
    "updatedAt" timestamp with time zone NOT NULL
);


ALTER TABLE public.trades OWNER TO postgres;

--
-- Name: COLUMN trades.backtest_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.backtest_id IS '回测ID';


--
-- Name: COLUMN trades.entry_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.entry_date IS '入场日期';


--
-- Name: COLUMN trades.exit_date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.exit_date IS '出场日期';


--
-- Name: COLUMN trades.stock_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.stock_id IS '股票ID';


--
-- Name: COLUMN trades.direction; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.direction IS '交易方向';


--
-- Name: COLUMN trades.entry_price; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.entry_price IS '入场价格';


--
-- Name: COLUMN trades.exit_price; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.exit_price IS '出场价格';


--
-- Name: COLUMN trades.quantity; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.quantity IS '交易数量';


--
-- Name: COLUMN trades.pnl; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.pnl IS '盈亏金额';


--
-- Name: COLUMN trades.pnl_percent; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.pnl_percent IS '盈亏比例(%)';


--
-- Name: COLUMN trades.holding_days; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.holding_days IS '持有天数';


--
-- Name: COLUMN trades.entry_value; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.entry_value IS '入场市值';


--
-- Name: COLUMN trades.exit_value; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.exit_value IS '出场市值';


--
-- Name: COLUMN trades.commission; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.commission IS '佣金费用';


--
-- Name: COLUMN trades.stamp_duty; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.stamp_duty IS '印花税';


--
-- Name: COLUMN trades.transfer_fee; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.transfer_fee IS '过户费';


--
-- Name: COLUMN trades.total_fee; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.total_fee IS '总费用';


--
-- Name: COLUMN trades.net_pnl; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.net_pnl IS '净盈亏';


--
-- Name: COLUMN trades.entry_signal; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.entry_signal IS '入场信号';


--
-- Name: COLUMN trades.exit_signal; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.exit_signal IS '出场信号';


--
-- Name: COLUMN trades.notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trades.notes IS '备注';


--
-- Name: trading_journals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.trading_journals (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    date date NOT NULL,
    "marketSummary" text NOT NULL,
    "portfolioAnalysis" text NOT NULL,
    "actionPlan" text,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    tags jsonb,
    mood character varying(20)
);


ALTER TABLE public.trading_journals OWNER TO postgres;

--
-- Name: COLUMN trading_journals.date; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trading_journals.date IS '复盘日期';


--
-- Name: COLUMN trading_journals."marketSummary"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trading_journals."marketSummary" IS '大盘整体表现总结 (由 AI 生成)';


--
-- Name: COLUMN trading_journals."portfolioAnalysis"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trading_journals."portfolioAnalysis" IS '个人持仓/模拟盘表现分析 (由 AI 结合用户持仓生成)';


--
-- Name: COLUMN trading_journals."actionPlan"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trading_journals."actionPlan" IS 'AI 明日交易建议或注意事项';


--
-- Name: COLUMN trading_journals.tags; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trading_journals.tags IS '标签(如: 止损、追高、打板)';


--
-- Name: COLUMN trading_journals.mood; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.trading_journals.mood IS '情绪状态(如: 平静、焦虑、兴奋)';


--
-- Name: trading_journals_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.trading_journals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.trading_journals_id_seq OWNER TO postgres;

--
-- Name: trading_journals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.trading_journals_id_seq OWNED BY public.trading_journals.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id integer NOT NULL,
    username character varying(50) NOT NULL,
    email character varying(100) NOT NULL,
    "avatarUrl" character varying(255),
    nickname character varying(50),
    phone character varying(20),
    "passwordHash" character varying(255) NOT NULL,
    role character varying(50) DEFAULT 'user'::character varying,
    "isActive" boolean DEFAULT true,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "riskConfig" jsonb DEFAULT '{"stopLossPercent": 5, "enableVolumeAlert": true, "takeProfitPercent": 10, "enableTechnicalAlert": true}'::jsonb
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Name: COLUMN users."riskConfig"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.users."riskConfig" IS '用户自定义的风控阈值配置';


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.users_id_seq OWNER TO postgres;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: daily_screeners id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.daily_screeners ALTER COLUMN id SET DEFAULT nextval('public.daily_screeners_id_seq'::regclass);


--
-- Name: data_update_logs id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.data_update_logs ALTER COLUMN id SET DEFAULT nextval('public.data_update_logs_id_seq'::regclass);


--
-- Name: favorite_stocks id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.favorite_stocks ALTER COLUMN id SET DEFAULT nextval('public.favorite_stocks_id_seq'::regclass);


--
-- Name: paper_trading_portfolios id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_trading_portfolios ALTER COLUMN id SET DEFAULT nextval('public.paper_trading_portfolios_id_seq'::regclass);


--
-- Name: paper_trading_positions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_trading_positions ALTER COLUMN id SET DEFAULT nextval('public.paper_trading_positions_id_seq'::regclass);


--
-- Name: paper_trading_snapshots id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_trading_snapshots ALTER COLUMN id SET DEFAULT nextval('public.paper_trading_snapshots_id_seq'::regclass);


--
-- Name: paper_trading_trades id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_trading_trades ALTER COLUMN id SET DEFAULT nextval('public.paper_trading_trades_id_seq'::regclass);


--
-- Name: risk_alerts id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.risk_alerts ALTER COLUMN id SET DEFAULT nextval('public.risk_alerts_id_seq'::regclass);


--
-- Name: scheduled_tasks id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scheduled_tasks ALTER COLUMN id SET DEFAULT nextval('public.scheduled_tasks_id_seq'::regclass);


--
-- Name: stocks id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.stocks ALTER COLUMN id SET DEFAULT nextval('public.stocks_id_seq'::regclass);


--
-- Name: trading_journals id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.trading_journals ALTER COLUMN id SET DEFAULT nextval('public.trading_journals_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: backtest_results backtest_results_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.backtest_results
    ADD CONSTRAINT backtest_results_pkey PRIMARY KEY (id);


--
-- Name: daily_bars daily_bars_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.daily_bars
    ADD CONSTRAINT daily_bars_pkey PRIMARY KEY ("time", stock_id);


--
-- Name: daily_screeners daily_screeners_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.daily_screeners
    ADD CONSTRAINT daily_screeners_pkey PRIMARY KEY (id);


--
-- Name: data_update_logs data_update_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.data_update_logs
    ADD CONSTRAINT data_update_logs_pkey PRIMARY KEY (id);


--
-- Name: favorite_stocks favorite_stocks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.favorite_stocks
    ADD CONSTRAINT favorite_stocks_pkey PRIMARY KEY (id);


--
-- Name: paper_trading_portfolios paper_trading_portfolios_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_trading_portfolios
    ADD CONSTRAINT paper_trading_portfolios_pkey PRIMARY KEY (id);


--
-- Name: paper_trading_positions paper_trading_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_trading_positions
    ADD CONSTRAINT paper_trading_positions_pkey PRIMARY KEY (id);


--
-- Name: paper_trading_snapshots paper_trading_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_trading_snapshots
    ADD CONSTRAINT paper_trading_snapshots_pkey PRIMARY KEY (id);


--
-- Name: paper_trading_trades paper_trading_trades_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_trading_trades
    ADD CONSTRAINT paper_trading_trades_pkey PRIMARY KEY (id);


--
-- Name: risk_alerts risk_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.risk_alerts
    ADD CONSTRAINT risk_alerts_pkey PRIMARY KEY (id);


--
-- Name: scheduled_tasks scheduled_tasks_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_name_key UNIQUE (name);


--
-- Name: scheduled_tasks scheduled_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_pkey PRIMARY KEY (id);


--
-- Name: stocks stocks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.stocks
    ADD CONSTRAINT stocks_pkey PRIMARY KEY (id);


--
-- Name: trades trades_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_pkey PRIMARY KEY (id);


--
-- Name: trading_journals trading_journals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.trading_journals
    ADD CONSTRAINT trading_journals_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_email_key1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key1 UNIQUE (email);


--
-- Name: users users_email_key10; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key10 UNIQUE (email);


--
-- Name: users users_email_key11; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key11 UNIQUE (email);


--
-- Name: users users_email_key12; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key12 UNIQUE (email);


--
-- Name: users users_email_key13; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key13 UNIQUE (email);


--
-- Name: users users_email_key14; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key14 UNIQUE (email);


--
-- Name: users users_email_key15; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key15 UNIQUE (email);


--
-- Name: users users_email_key16; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key16 UNIQUE (email);


--
-- Name: users users_email_key17; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key17 UNIQUE (email);


--
-- Name: users users_email_key18; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key18 UNIQUE (email);


--
-- Name: users users_email_key19; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key19 UNIQUE (email);


--
-- Name: users users_email_key2; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key2 UNIQUE (email);


--
-- Name: users users_email_key20; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key20 UNIQUE (email);


--
-- Name: users users_email_key21; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key21 UNIQUE (email);


--
-- Name: users users_email_key22; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key22 UNIQUE (email);


--
-- Name: users users_email_key23; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key23 UNIQUE (email);


--
-- Name: users users_email_key24; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key24 UNIQUE (email);


--
-- Name: users users_email_key25; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key25 UNIQUE (email);


--
-- Name: users users_email_key26; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key26 UNIQUE (email);


--
-- Name: users users_email_key27; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key27 UNIQUE (email);


--
-- Name: users users_email_key28; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key28 UNIQUE (email);


--
-- Name: users users_email_key29; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key29 UNIQUE (email);


--
-- Name: users users_email_key3; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key3 UNIQUE (email);


--
-- Name: users users_email_key30; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key30 UNIQUE (email);


--
-- Name: users users_email_key31; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key31 UNIQUE (email);


--
-- Name: users users_email_key32; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key32 UNIQUE (email);


--
-- Name: users users_email_key33; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key33 UNIQUE (email);


--
-- Name: users users_email_key34; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key34 UNIQUE (email);


--
-- Name: users users_email_key35; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key35 UNIQUE (email);


--
-- Name: users users_email_key36; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key36 UNIQUE (email);


--
-- Name: users users_email_key37; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key37 UNIQUE (email);


--
-- Name: users users_email_key38; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key38 UNIQUE (email);


--
-- Name: users users_email_key39; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key39 UNIQUE (email);


--
-- Name: users users_email_key4; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key4 UNIQUE (email);


--
-- Name: users users_email_key40; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key40 UNIQUE (email);


--
-- Name: users users_email_key41; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key41 UNIQUE (email);


--
-- Name: users users_email_key42; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key42 UNIQUE (email);


--
-- Name: users users_email_key43; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key43 UNIQUE (email);


--
-- Name: users users_email_key44; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key44 UNIQUE (email);


--
-- Name: users users_email_key45; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key45 UNIQUE (email);


--
-- Name: users users_email_key46; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key46 UNIQUE (email);


--
-- Name: users users_email_key5; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key5 UNIQUE (email);


--
-- Name: users users_email_key6; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key6 UNIQUE (email);


--
-- Name: users users_email_key7; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key7 UNIQUE (email);


--
-- Name: users users_email_key8; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key8 UNIQUE (email);


--
-- Name: users users_email_key9; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key9 UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: users users_username_key1; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key1 UNIQUE (username);


--
-- Name: users users_username_key10; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key10 UNIQUE (username);


--
-- Name: users users_username_key11; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key11 UNIQUE (username);


--
-- Name: users users_username_key12; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key12 UNIQUE (username);


--
-- Name: users users_username_key13; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key13 UNIQUE (username);


--
-- Name: users users_username_key14; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key14 UNIQUE (username);


--
-- Name: users users_username_key15; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key15 UNIQUE (username);


--
-- Name: users users_username_key16; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key16 UNIQUE (username);


--
-- Name: users users_username_key17; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key17 UNIQUE (username);


--
-- Name: users users_username_key18; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key18 UNIQUE (username);


--
-- Name: users users_username_key19; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key19 UNIQUE (username);


--
-- Name: users users_username_key2; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key2 UNIQUE (username);


--
-- Name: users users_username_key20; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key20 UNIQUE (username);


--
-- Name: users users_username_key21; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key21 UNIQUE (username);


--
-- Name: users users_username_key22; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key22 UNIQUE (username);


--
-- Name: users users_username_key23; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key23 UNIQUE (username);


--
-- Name: users users_username_key24; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key24 UNIQUE (username);


--
-- Name: users users_username_key25; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key25 UNIQUE (username);


--
-- Name: users users_username_key26; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key26 UNIQUE (username);


--
-- Name: users users_username_key27; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key27 UNIQUE (username);


--
-- Name: users users_username_key28; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key28 UNIQUE (username);


--
-- Name: users users_username_key29; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key29 UNIQUE (username);


--
-- Name: users users_username_key3; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key3 UNIQUE (username);


--
-- Name: users users_username_key30; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key30 UNIQUE (username);


--
-- Name: users users_username_key31; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key31 UNIQUE (username);


--
-- Name: users users_username_key32; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key32 UNIQUE (username);


--
-- Name: users users_username_key33; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key33 UNIQUE (username);


--
-- Name: users users_username_key34; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key34 UNIQUE (username);


--
-- Name: users users_username_key35; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key35 UNIQUE (username);


--
-- Name: users users_username_key36; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key36 UNIQUE (username);


--
-- Name: users users_username_key37; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key37 UNIQUE (username);


--
-- Name: users users_username_key38; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key38 UNIQUE (username);


--
-- Name: users users_username_key39; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key39 UNIQUE (username);


--
-- Name: users users_username_key4; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key4 UNIQUE (username);


--
-- Name: users users_username_key40; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key40 UNIQUE (username);


--
-- Name: users users_username_key41; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key41 UNIQUE (username);


--
-- Name: users users_username_key42; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key42 UNIQUE (username);


--
-- Name: users users_username_key43; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key43 UNIQUE (username);


--
-- Name: users users_username_key44; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key44 UNIQUE (username);


--
-- Name: users users_username_key45; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key45 UNIQUE (username);


--
-- Name: users users_username_key46; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key46 UNIQUE (username);


--
-- Name: users users_username_key5; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key5 UNIQUE (username);


--
-- Name: users users_username_key6; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key6 UNIQUE (username);


--
-- Name: users users_username_key7; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key7 UNIQUE (username);


--
-- Name: users users_username_key8; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key8 UNIQUE (username);


--
-- Name: users users_username_key9; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key9 UNIQUE (username);


--
-- Name: data_update_logs_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX data_update_logs_created_at ON public.data_update_logs USING btree ("createdAt");


--
-- Name: data_update_logs_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX data_update_logs_date ON public.data_update_logs USING btree (date);


--
-- Name: data_update_logs_type_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX data_update_logs_type_status ON public.data_update_logs USING btree (type, status);


--
-- Name: favorite_stocks_group_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX favorite_stocks_group_id ON public.favorite_stocks USING btree ("groupId");


--
-- Name: favorite_stocks_stock_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX favorite_stocks_stock_id ON public.favorite_stocks USING btree ("stockId");


--
-- Name: favorite_stocks_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX favorite_stocks_user_id ON public.favorite_stocks USING btree ("userId");


--
-- Name: idx_backtest_results_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_backtest_results_created_at ON public.backtest_results USING btree (created_at);


--
-- Name: idx_backtest_results_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_backtest_results_status ON public.backtest_results USING btree (status);


--
-- Name: idx_daily_bars_stock_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_daily_bars_stock_id ON public.daily_bars USING btree (stock_id);


--
-- Name: idx_daily_bars_stock_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_daily_bars_stock_time ON public.daily_bars USING btree (stock_id, "time");


--
-- Name: idx_daily_bars_time_desc; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_daily_bars_time_desc ON public.daily_bars USING btree ("time");


--
-- Name: idx_trades_backtest_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_trades_backtest_id ON public.trades USING btree (backtest_id);


--
-- Name: idx_trades_entry_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_trades_entry_date ON public.trades USING btree (entry_date);


--
-- Name: idx_trades_exit_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_trades_exit_date ON public.trades USING btree (exit_date);


--
-- Name: idx_trades_stock_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_trades_stock_id ON public.trades USING btree (stock_id);


--
-- Name: stocks_industry; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX stocks_industry ON public.stocks USING btree (industry);


--
-- Name: stocks_market; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX stocks_market ON public.stocks USING btree (market);


--
-- Name: stocks_symbol; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX stocks_symbol ON public.stocks USING btree (symbol);


--
-- Name: user_stock_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX user_stock_unique ON public.favorite_stocks USING btree ("userId", "stockId");


--
-- Name: users_email; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX users_email ON public.users USING btree (email);


--
-- Name: users_username; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX users_username ON public.users USING btree (username);


--
-- Name: backtest_results backtest_results_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.backtest_results
    ADD CONSTRAINT backtest_results_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE;


--
-- Name: daily_bars daily_bars_stock_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.daily_bars
    ADD CONSTRAINT daily_bars_stock_id_fkey FOREIGN KEY (stock_id) REFERENCES public.stocks(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: favorite_stocks favorite_stocks_stockId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.favorite_stocks
    ADD CONSTRAINT "favorite_stocks_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES public.stocks(id) ON UPDATE CASCADE;


--
-- Name: favorite_stocks favorite_stocks_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.favorite_stocks
    ADD CONSTRAINT "favorite_stocks_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE;


--
-- Name: paper_trading_portfolios paper_trading_portfolios_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_trading_portfolios
    ADD CONSTRAINT "paper_trading_portfolios_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: paper_trading_positions paper_trading_positions_portfolioId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_trading_positions
    ADD CONSTRAINT "paper_trading_positions_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES public.paper_trading_portfolios(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: paper_trading_snapshots paper_trading_snapshots_portfolioId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_trading_snapshots
    ADD CONSTRAINT "paper_trading_snapshots_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES public.paper_trading_portfolios(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: paper_trading_trades paper_trading_trades_portfolioId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.paper_trading_trades
    ADD CONSTRAINT "paper_trading_trades_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES public.paper_trading_portfolios(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: risk_alerts risk_alerts_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.risk_alerts
    ADD CONSTRAINT "risk_alerts_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trades trades_backtest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_backtest_id_fkey FOREIGN KEY (backtest_id) REFERENCES public.backtest_results(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trades trades_stock_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_stock_id_fkey FOREIGN KEY (stock_id) REFERENCES public.stocks(id) ON UPDATE CASCADE;


--
-- Name: trading_journals trading_journals_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.trading_journals
    ADD CONSTRAINT "trading_journals_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict xbqIeVxwDr7WagVvaDxsaU6jhWSzQ1szbPjDXPBqzLM5FkKmshPQPaWjOc0owjs

