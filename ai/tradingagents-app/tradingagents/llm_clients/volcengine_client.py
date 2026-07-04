import os
import httpx
from typing import Any, Optional

import openai
from langchain_openai import ChatOpenAI
from langchain_core.language_models.chat_models import BaseChatModel

from tradingagents.utils.env_config import get_env_or_config
from .base_client import BaseLLMClient
from .validators import validate_model


class VolcengineClient(BaseLLMClient):
    """Client for Volcengine (Ark) models.
    
    Uses langchain_openai.ChatOpenAI under the hood since Volcengine
    provides an OpenAI-compatible API endpoint.
    """

    def __init__(
        self,
        model: str,
        base_url: Optional[str] = None,
        **kwargs,
    ):
        # Default Volcengine Ark base URL
        if not base_url or "api.openai.com" in base_url:
            base_url = "https://ark.cn-beijing.volces.com/api/v3"
            
        super().__init__(model, base_url, **kwargs)

    def get_llm(self) -> Any:
        """Return configured ChatOpenAI instance for Volcengine."""
        self.warn_if_unknown_model()
        
        api_key = get_env_or_config("ARK_API_KEY")
        if not api_key:
            api_key = self.kwargs.get("api_key")
            
        # The key to making OpenAI compatible providers work reliably across all 
        # langchain versions and tool-bindings is using the raw `api_key` and `base_url`
        # arguments directly without any openai_ prefix tricks.
        http_client = httpx.Client(base_url=self.base_url)
        http_async_client = httpx.AsyncClient(base_url=self.base_url)
        
        # Monkey patch openai directly to ensure absolute fallback interception
        openai.api_key = api_key
        openai.base_url = self.base_url

        llm_kwargs = {
            "model": self.model,
            "api_key": api_key,
            "base_url": self.base_url,
            "max_retries": 2,
            "http_client": http_client,
            "http_async_client": http_async_client,
            "default_headers": {"Authorization": f"Bearer {api_key}"}
        }
        
        # Forward user-provided kwargs compatible with ChatOpenAI
        passthrough_kwargs = ["timeout", "callbacks", "temperature"]
        for key in passthrough_kwargs:
            if key in self.kwargs:
                llm_kwargs[key] = self.kwargs[key]

        return ChatOpenAI(**llm_kwargs)

    def validate_model(self) -> bool:
        """Validate model for the provider."""
        return validate_model("volcengine", self.model)
