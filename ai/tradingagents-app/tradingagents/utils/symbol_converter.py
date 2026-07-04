import logging

logger = logging.getLogger(__name__)

class SymbolConverter:
    """
    统一的股票代码格式转换工具。
    在整个 Agent 系统中，我们推荐使用纯数字代码（如 '002463', '600000'）作为标准。
    在调用不同的底层 API 时，使用此工具类转换为对应的格式。
    """
    
    @staticmethod
    def to_pure_number(symbol: str) -> str:
        """
        提取纯数字代码，例如 'sh.600000' -> '600000', 'SZ002463' -> '002463'
        """
        if not symbol:
            return symbol
        # 移除常见的非数字字符
        clean_symbol = ''.join(filter(str.isdigit, str(symbol)))
        return clean_symbol

    @staticmethod
    def to_internal_api_format(symbol: str) -> str:
        """
        转换为 InternalStockAPI 需要的格式，例如 '600000' -> 'sh.600000'
        如果已经带有正确前缀，则保持不变。
        """
        symbol = str(symbol).lower()
        if symbol.startswith("sh.") or symbol.startswith("sz.") or symbol.startswith("bj."):
            return symbol
            
        pure_num = SymbolConverter.to_pure_number(symbol)
        
        # 简单的 A 股规则推断
        if pure_num.startswith("6") or pure_num.startswith("5"):
            return f"sh.{pure_num}"
        elif pure_num.startswith("0") or pure_num.startswith("3") or pure_num.startswith("1"):
            return f"sz.{pure_num}"
        elif pure_num.startswith("4") or pure_num.startswith("8"):
            return f"bj.{pure_num}"
            
        return symbol

    @staticmethod
    def to_akshare_prefix_format(symbol: str) -> str:
        """
        转换为部分 akshare 接口需要的连续前缀格式，例如 '600000' -> 'sh600000'
        """
        internal_fmt = SymbolConverter.to_internal_api_format(symbol)
        return internal_fmt.replace(".", "")
        
    @staticmethod
    def to_em_format(symbol: str) -> str:
        """
        转换为部分东方财富接口需要的大写前缀格式，例如 '600000' -> 'SH600000'
        """
        return SymbolConverter.to_akshare_prefix_format(symbol).upper()
