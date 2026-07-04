import json
import logging
from typing import Optional, Dict, Any
import redis
from tradingagents.db.config import REDIS_URL

logger = logging.getLogger(__name__)

# Cache expiration time: 7 days in seconds
CACHE_EXPIRE_SECONDS = 7 * 24 * 60 * 60

try:
    redis_client = redis.from_url(REDIS_URL, decode_responses=True)
    # Test connection
    redis_client.ping()
except Exception as e:
    logger.error(f"Failed to connect to Redis: {e}")
    redis_client = None

def set_task_cache(task_id: str, task_data: Dict[str, Any]):
    """Set task data in Redis with 7-day expiration."""
    if not redis_client:
        return
    try:
        redis_client.setex(
            f"task:{task_id}",
            CACHE_EXPIRE_SECONDS,
            json.dumps(task_data)
        )
    except Exception as e:
        logger.error(f"Redis set error for task {task_id}: {e}")

def get_task_cache(task_id: str) -> Optional[Dict[str, Any]]:
    """Get task data from Redis."""
    if not redis_client:
        return None
    try:
        data = redis_client.get(f"task:{task_id}")
        if data:
            return json.loads(data)
    except Exception as e:
        logger.error(f"Redis get error for task {task_id}: {e}")
    return None

def delete_task_cache(task_id: str):
    """Delete task from Redis."""
    if not redis_client:
        return
    try:
        redis_client.delete(f"task:{task_id}")
    except Exception as e:
        logger.error(f"Redis delete error for task {task_id}: {e}")
