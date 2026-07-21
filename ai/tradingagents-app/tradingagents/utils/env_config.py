import os
from typing import Any, Optional
from dotenv import load_dotenv

# load default .env if exists
load_dotenv()

def get_env_or_config(key: str, default: Optional[Any] = None) -> Optional[str]:
    """
    Read configuration from environment only.

    The vendored runtime used to prefer a local ``config.json`` containing the
    Ark secret. That file was outside release management and made the service
    silently depend on the old standalone checkout. The single-repo runtime now
    receives secrets exclusively from its systemd EnvironmentFile.
    """
    val = os.environ.get(key)
    if val is not None:
        return val
    return default
