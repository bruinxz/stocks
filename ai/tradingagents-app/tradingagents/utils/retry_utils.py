import time
import logging
from typing import Callable, Any, Type, Tuple, Union

logger = logging.getLogger(__name__)

def execute_with_retry(
    func: Callable[[], Any],
    exceptions: Union[Type[Exception], Tuple[Type[Exception], ...]],
    max_retries: int = 100,
    base_delay: float = 2.0,
    max_delay: float = 60.0,
    service_name: str = "API"
) -> Any:
    """
    Execute a function with exponential backoff on specified exceptions.
    
    Args:
        func: The zero-argument callable to execute.
        exceptions: The exception class or tuple of exception classes to catch and retry.
        max_retries: Maximum number of retry attempts.
        base_delay: Base delay in seconds for exponential backoff.
        max_delay: Maximum delay in seconds to cap the exponential growth.
        service_name: Name of the service for logging purposes (e.g., "Yahoo Finance").
        
    Returns:
        The result of the `func` execution.
        
    Raises:
        The caught exception if max_retries is exhausted or a non-specified exception occurs.
    """
    for attempt in range(max_retries + 1):
        try:
            return func()
        except exceptions as e:
            if attempt < max_retries:
                # Exponential backoff with a cap
                delay = min(base_delay * (1.5 ** attempt), max_delay)
                logger.warning(f"{service_name} error/rate limited, retrying in {delay:.1f}s (attempt {attempt + 1}/{max_retries}). Error: {e}")
                print(f"{service_name} 接口请求失败或触发限流，等待 {delay:.1f} 秒后进行重试 (第 {attempt + 1}/{max_retries} 次)...")
                time.sleep(delay)
            else:
                logger.error(f"{service_name} max retries ({max_retries}) exhausted.")
                print(f"{service_name} 已达到最大重试次数 ({max_retries})，任务终止。")
                raise
