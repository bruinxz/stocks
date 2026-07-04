import functools

from tradingagents.agents.utils.agent_utils import build_instrument_context, get_language_instruction, get_stock_data, get_realtime_quotes


def create_trader(llm, memory):
    def trader_node(state, name):
        current_date = state.get("trade_date")
        company_name = state.get("instrument_info", state.get("company_of_interest"))
        instrument_context = build_instrument_context(company_name)
        
        # Give trader access to real-time quotes to make better immediate decisions
        tools = [get_stock_data, get_realtime_quotes]
        investment_plan = state["investment_plan"]
        market_research_report = state["market_report"]
        sentiment_report = state["sentiment_report"]
        news_report = state["news_report"]
        fundamentals_report = state["fundamentals_report"]

        curr_situation = f"{market_research_report}\n\n{sentiment_report}\n\n{news_report}\n\n{fundamentals_report}"
        past_memories = memory.get_memories(curr_situation, n_matches=2)

        past_memory_str = ""
        if past_memories:
            for i, rec in enumerate(past_memories, 1):
                past_memory_str += rec["recommendation"] + "\n\n"
        else:
            past_memory_str = "No past memories found."

        context = {
            "role": "user",
            "content": f"Based on a comprehensive analysis by a team of analysts, here is an investment plan tailored for {company_name}. {instrument_context} This plan incorporates insights from current technical market trends, macroeconomic indicators, and social media sentiment. Use this plan as a foundation for evaluating your next trading decision.\n\nProposed Investment Plan: {investment_plan}\n\nLeverage these insights to make an informed and strategic decision. Before making a decision, you MAY use the `get_realtime_quotes` tool to check the current real-time price and market performance for today.",
        }

        messages = [
            {
                "role": "system",
                "content": f"""You are a trading agent analyzing market data to make investment decisions. Based on your analysis, provide a specific recommendation to buy, sell, or hold. End with a firm decision and always conclude your response with '最终交易提案：**BUY/HOLD/SELL**' to confirm your recommendation. Apply lessons from past decisions to strengthen your analysis. Here are reflections from similar situations you traded in and the lessons learned: {past_memory_str}{get_language_instruction()}""",
            },
            context,
        ]

        chain = llm.bind_tools(tools)
        result = chain.invoke(messages)
        
        # Check if the LLM called a tool (e.g. get_realtime_quotes)
        report = ""
        if not result.tool_calls:
            report = result.content

        return {
            "messages": [result],
            "trader_investment_plan": report,
            "sender": name,
        }

    return functools.partial(trader_node, name="Trader")
