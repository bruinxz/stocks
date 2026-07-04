import os
import json
from typing import Any, Optional
from dotenv import load_dotenv

# load default .env if exists
load_dotenv()

# Optionally load config.json if it exists
CONFIG_JSON = {}
_config_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "config.json"))
if os.path.exists(_config_path):
    try:
        with open(_config_path, "r", encoding="utf-8") as f:
            CONFIG_JSON = json.load(f)
    except Exception as e:
        print(f"Warning: Failed to load config.json: {e}")

def get_env_or_config(key: str, default: Optional[Any] = None) -> Optional[str]:
    """
    Get configuration value.
    
    Priority:
    1. config.json file in root directory
    2. Environment variables (including loaded .env file values)
    3. Default value
    
    This acts as a centralized compatibility layer for reading config variables.
    """
    # 1. Check JSON config first
    if key in CONFIG_JSON:
        return CONFIG_JSON[key]
        
    # 2. Check environment variable
    val = os.environ.get(key)
    if val is not None:
        return val
        
    # 3. Fallback to default
    return default

