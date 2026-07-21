# -*- coding: utf-8 -*-
import uuid
import logging
import time
from enum import Enum
from typing import Optional

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, Depends
from fastapi.responses import StreamingResponse
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, HttpUrl
import uvicorn
import httpx
import json
import os

import asyncio

# 导入数据库模块
from tradingagents.db.database import get_db, engine, Base
from tradingagents.db import crud
from tradingagents.db.redis_cache import set_task_cache, get_task_cache
from sqlalchemy.orm import Session

# 创建数据库表
if engine:
    import logging
    try:
        Base.metadata.create_all(bind=engine)
    except Exception as e:
        logging.getLogger(__name__).error(f"Failed to create database tables: {e}")
        engine = None

# 导入核心逻辑
from main import build_runtime_config, run_trading_analysis
from tradingagents.llm_clients.base_client import normalize_content
from tradingagents.llm_clients.factory import create_llm_client

# 配置日志
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(
    title="TradingAgents API", 
    description="支持同步/异步/回调的多智能体交易分析接口",
    version="2.0.0"
)

# ==========================================
# 1. 数据模型与枚举设计 (Pydantic Models)
# ==========================================

class TaskStatus(str, Enum):
    PENDING = "PENDING"       # 任务已提交，等待执行
    PROCESSING = "PROCESSING" # 任务正在执行中
    COMPLETED = "COMPLETED"   # 任务执行成功
    FAILED = "FAILED"         # 任务执行失败

class AnalysisRequest(BaseModel):
    ticker: str
    target_date: Optional[str] = None        # 指定分析日期，格式为 YYYY-MM-DD，为空则默认使用当前日期
    is_async: bool = False                   # 是否使用异步模式，默认同步
    callback_url: Optional[HttpUrl] = None   # 异步模式下的回调地址（可选）

class AnalysisResultData(BaseModel):
    decision: str
    rationale: str
    detail: dict  # Full structured data of the execution trace

class AsyncSubmitResponse(BaseModel):
    task_id: str
    status: TaskStatus
    message: str

class TaskStatusResponse(BaseModel):
    task_id: str
    status: TaskStatus
    ticker: str
    target_date: str                         # 记录该任务分析的目标日期
    elapsed_time: float = 0.0                # 任务耗时（秒）
    data: Optional[AnalysisResultData] = None
    error: Optional[str] = None

# 回调函数发送的数据载荷格式（Webhook Payload）
class CallbackPayload(BaseModel):
    task_id: str
    status: TaskStatus
    ticker: str
    target_date: str                         # 记录该任务分析的目标日期
    elapsed_time: float = 0.0                # 任务耗时（秒）
    data: Optional[AnalysisResultData] = None
    error: Optional[str] = None


class PromptRequest(BaseModel):
    prompt: str
    max_chars: Optional[int] = None
    target: Optional[str] = None

# ==========================================
# 2. 任务状态存储 (Task Store)
# ==========================================
# 本版本已经重构，使用 Redis (7天过期缓存) + PostgreSQL (持久化) 替代了原先的内存字典。

# ==========================================
# 3. 核心异步与回调处理逻辑
# ==========================================

async def trigger_callback(task_id: str, callback_url: HttpUrl, task_info: TaskStatusResponse):
    """当任务完成或失败时，向指定的 Webhook URL 发送 POST 请求"""
    payload = CallbackPayload(
        task_id=task_id,
        status=task_info.status,
        ticker=task_info.ticker,
        target_date=task_info.target_date,
        elapsed_time=task_info.elapsed_time,
        data=task_info.data,
        error=task_info.error
    )
    
    logger.info(f"Task {task_id}: 正在向回调地址 {callback_url} 发送结果...")
    try:
        # 使用 httpx 进行异步 HTTP 请求，避免阻塞主线程
        async with httpx.AsyncClient() as client:
            response = await client.post(
                str(callback_url), 
                json=payload.model_dump(mode='json'),
                timeout=10.0
            )
            response.raise_for_status()
            logger.info(f"Task {task_id}: 回调发送成功 (Status: {response.status_code})")
    except Exception as e:
        logger.error(f"Task {task_id}: 回调发送失败! 错误信息: {e}")

async def process_analysis_task(task_id: str, ticker: str, target_date: str, callback_url: Optional[HttpUrl]):
    """后台执行交易分析任务的核心函数"""
    start_time = time.time()  # 记录任务开始时间
    
    # 从数据库获取新Session
    db_session = next(get_db())
    
    task_info = TaskStatusResponse(
        task_id=task_id,
        status=TaskStatus.PROCESSING,
        ticker=ticker,
        target_date=target_date,
        elapsed_time=0.0
    )
    
    # 存入 Redis 和 数据库
    set_task_cache(task_id, task_info.model_dump(mode='json'))
    if db_session:
        crud.update_task_status(db_session, task_id, TaskStatus.PROCESSING)
    
    try:
        logger.info(f"Task {task_id}: 开始执行 {ticker} 在 {target_date} 的分析任务")
        decision, rationale, log_path = await run_in_threadpool(run_trading_analysis, ticker, target_date)
        
        end_time = time.time()
        elapsed_time = round(end_time - start_time, 2)
        
        # 读取日志内容
        detail_data = {}
        if log_path and os.path.exists(log_path):
            with open(log_path, 'r', encoding='utf-8') as f:
                content = f.read()
                # 如果是 json 则解析，如果是 md 则存入 text 字段
                if log_path.endswith('.json'):
                    try:
                        detail_data = json.loads(content)
                    except:
                        detail_data = {"text": content}
                else:
                    detail_data = {"text": content}
                    
            # 读取完成可以删除本地文件防止堆积
            try:
                os.remove(log_path)
                logger.info(f"Task {task_id}: 成功读取并删除了本地日志文件 {log_path}")
            except Exception as e:
                logger.warning(f"Task {task_id}: 无法删除本地日志文件 {log_path}, 错误: {e}")
                
        task_info.status = TaskStatus.COMPLETED
        task_info.elapsed_time = elapsed_time
        task_info.data = AnalysisResultData(
            decision=decision,
            rationale=rationale,
            detail=detail_data
        )
        
        # 更新 Redis 和 数据库
        set_task_cache(task_id, task_info.model_dump(mode='json'))
        if db_session:
            crud.complete_task(db_session, task_id, elapsed_time, decision, rationale, detail_data)
            
        logger.info(f"Task {task_id}: 分析任务执行成功, 耗时 {elapsed_time} 秒")
        
    except Exception as e:
        end_time = time.time()
        elapsed_time = round(end_time - start_time, 2)
        
        logger.error(f"Task {task_id}: 执行失败! 耗时 {elapsed_time} 秒, 错误: {str(e)}")
        import traceback
        traceback.print_exc()
        
        task_info.status = TaskStatus.FAILED
        task_info.elapsed_time = elapsed_time
        task_info.error = str(e)
        
        # 更新 Redis 和 数据库
        set_task_cache(task_id, task_info.model_dump(mode='json'))
        if db_session:
            crud.update_task_status(db_session, task_id, TaskStatus.FAILED, elapsed_time, str(e))
            
    finally:
        if db_session:
            db_session.close()

    # 如果用户注册了回调地址，触发回调
    if callback_url:
        await trigger_callback(task_id, callback_url, task_info)


# ==========================================
# 4. API 路由接口定义
# ==========================================

@app.post("/api/analyze")
async def analyze_stock(request: AnalysisRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """
    提交分析任务。
    - 同步模式 (is_async=False)：一直等待直到分析完成并返回结果。
    - 异步模式 (is_async=True)：立即返回 task_id，后台默默执行。支持配置 callback_url。
    """
    task_id = str(uuid.uuid4())
    
    from datetime import datetime
    # 如果用户没有传 target_date，默认使用今天的日期
    final_target_date = request.target_date or datetime.today().strftime("%Y-%m-%d")
    
    task_info = TaskStatusResponse(
        task_id=task_id,
        status=TaskStatus.PENDING,
        ticker=request.ticker,
        target_date=final_target_date
    )
    
    # 存入 Redis 和 数据库
    set_task_cache(task_id, task_info.model_dump(mode='json'))
    if db:
        crud.create_task(db, task_id, request.ticker, final_target_date, TaskStatus.PENDING)
    
    if request.is_async:
        # 异步模式：将任务丢给后台并立即返回
        background_tasks.add_task(
            process_analysis_task, 
            task_id=task_id, 
            ticker=request.ticker, 
            target_date=final_target_date,
            callback_url=request.callback_url
        )
        return AsyncSubmitResponse(
            task_id=task_id,
            status=TaskStatus.PENDING,
            message=f"任务已成功异步提交，目标分析日期: {final_target_date}。请使用 task_id 轮询状态，或等待回调通知。"
        )
    else:
        # 同步模式：在此处等待线程池执行完毕
        await process_analysis_task(task_id, request.ticker, final_target_date, request.callback_url)
        
        # 从缓存或数据库读取最终结果
        cached = get_task_cache(task_id)
        if cached:
            task_info = TaskStatusResponse(**cached)
        else:
            # Fallback to DB
            if db:
                db_task = crud.get_task(db, task_id)
                if db_task:
                    data = None
                    if db_task.decision:
                        data = AnalysisResultData(decision=db_task.decision, rationale=db_task.rationale, detail=db_task.detail or {})
                    task_info = TaskStatusResponse(
                        task_id=db_task.id, status=db_task.status, ticker=db_task.ticker, target_date=db_task.target_date,
                        elapsed_time=db_task.elapsed_time, data=data, error=db_task.error
                    )
        
        if task_info.status == TaskStatus.FAILED:
            raise HTTPException(status_code=500, detail=task_info.error)
            
        return task_info

@app.get("/api/tasks/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(task_id: str, db: Session = Depends(get_db)):
    """
    通过 task_id 获取任务的当前状态和执行结果。优先查 Redis，查不到查 DB。
    """
    # 优先查 Redis 缓存
    cached = get_task_cache(task_id)
    if cached:
        return TaskStatusResponse(**cached)
        
    # Redis 没查到或者过期，查 DB
    if db:
        db_task = crud.get_task(db, task_id)
        if db_task:
            data = None
            if db_task.decision:
                data = AnalysisResultData(decision=db_task.decision, rationale=db_task.rationale, detail=db_task.detail or {})
            
            task_info = TaskStatusResponse(
                task_id=db_task.id,
                status=db_task.status,
                ticker=db_task.ticker,
                target_date=db_task.target_date,
                elapsed_time=db_task.elapsed_time,
                data=data,
                error=db_task.error
            )
            # 回写 Redis
            set_task_cache(task_id, task_info.model_dump(mode='json'))
            return task_info
            
    raise HTTPException(status_code=404, detail="未找到该任务 (Task not found)")

@app.get("/api/analyze/stream")
async def analyze_stock_stream(request: Request, ticker: str, target_date: Optional[str] = None):
    """
    通过 SSE (Server-Sent Events) 流式返回多智能体分析过程和结果。
    """
    from datetime import datetime
    import asyncio
    import json
    
    final_target_date = target_date or datetime.today().strftime("%Y-%m-%d")
    
    async def event_generator():
        import json
        yield f"data: {json.dumps({'type': 'system', 'message': f'开始对 {ticker} 在 {final_target_date} 的数据进行多智能体分析...'})}\n\n"
        
        from tradingagents.graph.trading_graph import TradingAgentsGraph
        config = build_runtime_config()
        query_ticker = ticker
        
        try:
            # 初始化状态机
            ta = TradingAgentsGraph(debug=False, config=config)
            init_agent_state = ta.propagator.create_initial_state(query_ticker, final_target_date)
            args = ta.propagator.get_graph_args()
            
            step_count = 1
            last_msg_id = None
            final_decision = "UNKNOWN"
            
            # 1. 运行分析师 (并发执行)
            yield f"data: {json.dumps({'type': 'system', 'message': '正在并发拉取市场、情绪、新闻、基本面数据...'})}\n\n"
            
            analyst_results = {}
            
            async def run_analyst_async(a_type):
                logger.info(f"Task {ticker}: 开始异步执行分析师 -> {a_type}")
                # LangGraph 的 invoke 是同步阻塞的，必须用 run_in_threadpool 放入线程池执行
                invoke_args = {k: v for k, v in args.items() if k != "stream_mode"}
                result = await run_in_threadpool(ta.analyst_graphs[a_type].invoke, init_agent_state.copy(), **invoke_args)
                return a_type, result
                
            tasks = [run_analyst_async(a_type) for a_type in ta.selected_analysts]
            
            for coro in asyncio.as_completed(tasks):
                a_type, final_analyst_state = await coro
                analyst_results[a_type] = final_analyst_state
                
                # 某个分析师拉取完毕，通知前端
                cn_name = {"market": "技术面", "social": "情绪面", "news": "新闻面", "fundamentals": "基本面"}.get(a_type, a_type)
                yield f"data: {json.dumps({'type': 'analyst_done', 'analyst': cn_name, 'message': f'{cn_name}分析师 数据收集完毕'})}\n\n"
                # 给前端一点喘息时间渲染
                await asyncio.sleep(0.1)

            # 合并分析师报告
            merged_state = init_agent_state.copy()
            for a_type in ta.selected_analysts:
                final_analyst_state = analyst_results[a_type]
                if a_type == "market":
                    merged_state["market_report"] = final_analyst_state.get("market_report", "")
                elif a_type == "social":
                    merged_state["sentiment_report"] = final_analyst_state.get("sentiment_report", "")
                elif a_type == "news":
                    merged_state["news_report"] = final_analyst_state.get("news_report", "")
                elif a_type == "fundamentals":
                    merged_state["fundamentals_report"] = final_analyst_state.get("fundamentals_report", "")

            from langchain_core.messages import HumanMessage
            merged_state["messages"] = [HumanMessage(content="继续")]
            
            yield f"data: {json.dumps({'type': 'system', 'message': '数据收集完毕，开始进入多智能体深度辩论环节...'})}\n\n"
            await asyncio.sleep(0.5)

            # 2. 流式运行主 Graph (研究员辩论、风控会审、最终决策)
            # 使用 astream 异步流式获取每个节点的执行结果
            # 在 LangGraph 中，astream 返回的 chunk 可能包含不可序列化的对象，我们需要提取内容
            async for chunk in ta.main_graph.astream(merged_state, **args):
                # 检查客户端是否已经断开连接
                if await request.is_disconnected():
                    break
                    
                if not isinstance(chunk, dict):
                    continue
                    
                # stream_mode="updates" 时，chunk 是 {node_name: state_update}
                # 发送当前正在执行的节点提示
                node_name = list(chunk.keys())[0]
                state_update = chunk[node_name]
                
                # 节点执行完成的提示
                node_cn_names = {
                    "bull_researcher": "牛方研究员",
                    "bear_researcher": "熊方研究员",
                    "research_manager": "投资总监",
                    "trader": "交易员",
                    "aggressive_risk_debator": "激进风控",
                    "conservative_risk_debator": "保守风控",
                    "neutral_risk_debator": "中立风控",
                    "portfolio_manager": "基金经理"
                }
                
                if node_name in node_cn_names:
                    yield f"data: {json.dumps({'type': 'system', 'message': f'🔄 {node_cn_names[node_name]} 刚刚完成了一轮思考...'})}\n\n"
                    
                # 兼容处理：不仅监听 messages，也监听各个智能体的专属汇报字段
                # 如果某个节点更新了以下专属字段，我们也将其作为消息发给前端
                for field, sender_name in [
                    ("market_report", "技术分析师"),
                    ("sentiment_report", "情绪分析师"),
                    ("news_report", "新闻分析师"),
                    ("fundamentals_report", "基本面分析师"),
                    ("investment_debate_state", "投资研究团队"),
                    ("trader_investment_plan", "交易员"),
                    ("risk_debate_state", "风控团队"),
                    ("final_trade_decision", "基金经理")
                ]:
                    if field in state_update and state_update[field]:
                        current_val = state_update[field]
                        # 处理 investment_debate_state 里的增量对话
                        if field == "investment_debate_state" and "current_response" in current_val:
                            latest_speech = current_val["current_response"]
                            if latest_speech:
                                val_hash = hash(f"{field}_{latest_speech}")
                                if val_hash != last_msg_id:
                                    last_msg_id = val_hash
                                    
                                    # 智能体内部生成的是 "牛方分析师: xxx"
                                    if latest_speech.startswith("牛方"):
                                        sender_name = "牛方研究员"
                                        content_to_send = latest_speech.split(":", 1)[-1].strip() if ":" in latest_speech else latest_speech
                                    elif latest_speech.startswith("熊方"):
                                        sender_name = "熊方研究员"
                                        content_to_send = latest_speech.split(":", 1)[-1].strip() if ":" in latest_speech else latest_speech
                                    else:
                                        sender_name = "投资研究员"
                                        content_to_send = latest_speech
                                        
                                    import json
                                    yield f"data: {json.dumps({'type': 'agent_message', 'sender': sender_name, 'content': content_to_send})}\n\n"
                                    await asyncio.sleep(0.1)
                                    
                        elif field == "risk_debate_state":
                            # 风控智能体分别写入了各自的 current_xxx_response
                            latest_speech = None
                            sender_name = "风控专员"
                            
                            if "current_aggressive_response" in current_val and current_val["current_aggressive_response"]:
                                latest_speech = current_val["current_aggressive_response"]
                                sender_name = "激进型风控专员"
                            elif "current_conservative_response" in current_val and current_val["current_conservative_response"]:
                                latest_speech = current_val["current_conservative_response"]
                                sender_name = "保守型风控专员"
                            elif "current_neutral_response" in current_val and current_val["current_neutral_response"]:
                                latest_speech = current_val["current_neutral_response"]
                                sender_name = "中立型风控专员"
                                
                            if latest_speech:
                                val_hash = hash(f"{field}_{latest_speech}")
                                if val_hash != last_msg_id:
                                    last_msg_id = val_hash
                                    
                                    # 剔除可能存在的前缀 "激进风控员:" 等
                                    content_to_send = latest_speech.split(":", 1)[-1].strip() if ":" in latest_speech else latest_speech
                                        
                                    import json
                                    yield f"data: {json.dumps({'type': 'agent_message', 'sender': sender_name, 'content': content_to_send})}\n\n"
                                    await asyncio.sleep(0.1)
                                    
                        elif isinstance(current_val, str) and len(current_val) > 10:
                            # 处理单节点的简单字符串输出
                            val_hash = hash(f"{field}_{current_val}")
                            if val_hash != last_msg_id:
                                last_msg_id = val_hash
                                import json
                                # 提取最后一段话作为增量更新发送
                                content_to_send = current_val.split("\n\n")[-1] if "\n\n" in current_val else current_val
                                yield f"data: {json.dumps({'type': 'agent_message', 'sender': sender_name, 'content': content_to_send})}\n\n"
                                await asyncio.sleep(0.1)

                # 原有的 messages 监听逻辑
                if "messages" in state_update and len(state_update["messages"]) > 0:
                    msg = state_update["messages"][-1]
                    msg_id = getattr(msg, "id", None) or hash(getattr(msg, "content", ""))
                    
                    if msg_id and msg_id != last_msg_id:
                        last_msg_id = msg_id
                        msg_type = type(msg).__name__
                        
                        if "AIMessage" in msg_type and hasattr(msg, "content") and msg.content:
                            sender = getattr(msg, "name", "AI Agent")
                            if not sender and hasattr(msg, "additional_kwargs"):
                                sender = msg.additional_kwargs.get("name", "AI Agent")
                                
                            import json
                            yield f"data: {json.dumps({'type': 'agent_message', 'sender': sender, 'content': msg.content})}\n\n"
                            await asyncio.sleep(0.1)
                
                if "final_trade_decision" in state_update:
                    final_decision = state_update["final_trade_decision"]
                
                step_count += 1
            
            # 3. 提取最终决策
            # 获取最后一次 chunk 中的状态，通常包含了 final_trade_decision
            yield f"data: {json.dumps({'type': 'completed', 'decision': final_decision, 'message': '全部分析完成！'})}\n\n"
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            yield f"data: {json.dumps({'type': 'error', 'message': f'执行过程中发生错误: {str(e)}'})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

def _complete_prompt_sync(prompt: str, max_chars: Optional[int] = None) -> str:
    config = build_runtime_config()
    client = create_llm_client(
        config["llm_provider"],
        config["quick_think_llm"],
        config["backend_url"],
        timeout=float(os.getenv("TRADINGAGENTS_PROMPT_TIMEOUT_SECONDS", "90")),
    )
    response = normalize_content(client.get_llm().invoke(prompt))
    text = str(getattr(response, "content", "") or "").strip()
    if max_chars and max_chars > 0:
        text = "".join(list(text)[:max_chars])
    if not text:
        raise RuntimeError("LLM returned empty content")
    return text


async def _complete_prompt(request: PromptRequest) -> str:
    if not request.prompt.strip():
        raise HTTPException(status_code=422, detail="prompt is required")
    try:
        return await run_in_threadpool(_complete_prompt_sync, request.prompt, request.max_chars)
    except HTTPException:
        raise
    except Exception as error:
        logger.error("Prompt completion failed: %s", error)
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/market-brief")
async def market_brief(request: PromptRequest):
    return {"status": "OK", "data": {"view": await _complete_prompt(request)}}


@app.post("/api/attribution-summary")
async def attribution_summary(request: PromptRequest):
    return {"summary": await _complete_prompt(request)}


@app.post("/api/diary-summary")
async def diary_summary(request: PromptRequest):
    return {"diary": await _complete_prompt(request)}


@app.post("/api/trading-journal")
async def trading_journal(request: PromptRequest):
    return {
        "status": "OK",
        "data": {"markdown": await _complete_prompt(request), "mood": "AI", "tags": ["AI复盘"]},
    }


@app.post("/api/nlp-summary")
async def nlp_summary(payload: dict):
    title = str(payload.get("title") or "").strip()
    prompt = (
        "请把下面这条 A 股公告标题压缩成不超过 120 字的中文摘要，只陈述事实，"
        "不要给买卖建议。\n"
        f"股票：{payload.get('stock_code') or '未知'}\n"
        f"类型：{payload.get('announcement_type') or '未知'}\n"
        f"标题：{title}"
    )
    summary = await _complete_prompt(PromptRequest(prompt=prompt, max_chars=120))
    return {
        "status": "OK",
        "data": {
            "summary": summary,
            "sentiment": "中性",
            "key_amounts": [],
            "key_topics": [],
            "entities": [],
        },
    }


@app.post("/api/nlp-technical-analysis")
async def nlp_technical_analysis(payload: dict):
    close = float(payload.get("last_close") or 0)
    low = float(payload.get("recent_low") or close)
    high = float(payload.get("recent_high") or close)
    momentum = float(payload.get("momentum_pct") or 0)
    trend = "uptrend" if momentum > 5 else "downtrend" if momentum < -5 else "sideways"
    prompt = (
        "你是 A 股技术分析员。请用不超过 160 字中文解释下列指标，不承诺收益。\n"
        f"代码：{payload.get('stock_code')}；收盘：{close}；区间低点：{low}；"
        f"区间高点：{high}；动量：{momentum}%；RSI：{payload.get('last_rsi')}；"
        f"量比：{payload.get('vol_ratio')}。"
    )
    summary = await _complete_prompt(PromptRequest(prompt=prompt, max_chars=160))
    return {
        "status": "OK",
        "data": {
            "trend": trend,
            "support_levels": [low] if low > 0 else [],
            "resistance_levels": [high] if high > 0 else [],
            "buy_zone": [round(low * 0.99, 3), round(low * 1.01, 3)] if low > 0 else [],
            "sell_zone": [round(high * 0.99, 3), round(high * 1.01, 3)] if high > 0 else [],
            "summary": summary,
            "confidence": 60,
        },
    }


@app.get("/health")
def health_check():
    config = build_runtime_config()
    provider = str(config.get("llm_provider") or "").lower()
    credential_name = {
        "volcengine": "ARK_API_KEY",
        "ark": "ARK_API_KEY",
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "google": "GOOGLE_API_KEY",
    }.get(provider)
    credential_ready = bool(os.getenv(credential_name or ""))
    internal_api_ready = bool(os.getenv("INTERNAL_API_KEY"))
    database_ready = engine is not None
    ready = credential_ready and internal_api_ready and database_ready
    return {
        "status": "ok" if ready else "degraded",
        "ready": ready,
        "runtime": "vendored",
        "provider": provider,
        "model": config.get("quick_think_llm"),
        "credential_ready": credential_ready,
        "internal_api_ready": internal_api_ready,
        "database_ready": database_ready,
    }

def main():
    uvicorn.run(app, host="0.0.0.0", port=8000)


if __name__ == "__main__":
    main()
