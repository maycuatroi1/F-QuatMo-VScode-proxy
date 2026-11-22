# -*- coding: utf-8 -*-
"""
Configuration module for PhaseSUMMARY Engine.
Provides centralized, validated configuration adhering to quatmo-proxy upstream conventions (CUSTOM_*).
"""

import os
from pathlib import Path
from typing import Dict, Any, Optional

# Search potential .env locations (local tool directory, working directory, and proxy root)
ENV_LOCATIONS = [
    Path.cwd() / ".env",
    Path(__file__).resolve().parent.parent / ".env",
    Path(__file__).resolve().parent.parent.parent.parent / "proxy" / "quatmo-proxy" / ".env",
]

try:
    from dotenv import load_dotenv
    for p in ENV_LOCATIONS:
        if p.exists():
            load_dotenv(dotenv_path=p, override=False)
except Exception:
    pass

class ModelConfig:
    """Upstream Model Configuration matching quatmo-proxy conventions (CUSTOM_* and SUMMARY_LLM_*)."""
    def __init__(self,
                 base_url: Optional[str] = None,
                 api_key: Optional[str] = None,
                 model_name: Optional[str] = None,
                 aliases: Optional[str] = None,
                 enabled: Optional[bool] = None,
                 temperature: Optional[float] = None,
                 timeout_s: Optional[int] = None,
                 max_retries: Optional[int] = None):
        # 1. Base URL
        raw_base_url = (base_url or 
                        os.getenv("SUMMARY_LLM_BASE_URL") or 
                        os.getenv("CUSTOM_BASE_URL") or 
                        os.getenv("CLASSIFIER_API_URL") or 
                        os.getenv("LLM_BASE_URL") or 
                        "https://quatmo-api.iahn.hanoi.vn/v1").strip()
        if raw_base_url.endswith("/chat/completions"):
            raw_base_url = raw_base_url[:-len("/chat/completions")]
        self.base_url = raw_base_url.rstrip("/")

        # 2. API Key
        self.api_key = (api_key or 
                        os.getenv("SUMMARY_LLM_API_KEY") or 
                        os.getenv("CUSTOM_API_KEY") or 
                        os.getenv("CLASSIFIER_API_KEY") or 
                        os.getenv("LLM_API_KEY") or 
                        "").strip()

        # 3. Model Name: default gemma-4-26b
        self.model_name = (model_name or 
                           os.getenv("SUMMARY_LLM_MODEL") or 
                           os.getenv("CUSTOM_MODEL_NAME") or 
                           os.getenv("CLASSIFIER_MODEL") or 
                           os.getenv("LLM_MODEL") or 
                           "gemma-4-26b").strip()

        # 4. Aliases: fallback model (qwen3-coder) used strictly when gemma-4-26b is unreachable
        raw_aliases = aliases if aliases is not None else (os.getenv("SUMMARY_LLM_ALIASES") if os.getenv("SUMMARY_LLM_ALIASES") is not None else os.getenv("CUSTOM_MODEL_ALIASES"))
        if raw_aliases is not None and isinstance(raw_aliases, str) and raw_aliases.strip().lower() in ("none", "false", "null", "disabled", "empty"):
            self.aliases = ""
        else:
            self.aliases = raw_aliases or "qwen3-coder"

        # 5. M5 Realizer Execution Parameters
        if enabled is not None:
            self.enabled = bool(enabled)
        else:
            self.enabled = (os.getenv("SUMMARY_LLM_ENABLED") or os.getenv("LLM_ENABLED", "true")).lower() in ("true", "1", "yes")

        self.temperature = float(temperature if temperature is not None else os.getenv("LLM_TEMPERATURE", "0.0"))
        self.timeout_s = int(timeout_s if timeout_s is not None else (os.getenv("SUMMARY_LLM_TIMEOUT_S") or os.getenv("LLM_TIMEOUT_S") or "75"))
        self.max_retries = int(max_retries if max_retries is not None else os.getenv("LLM_MAX_RETRIES", "2"))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "model_name": self.model_name,
            "base_url": self.base_url,
            "api_key": "",
            "api_key_set": bool(self.api_key),
            "aliases": self.aliases,
            "temperature": self.temperature,
            "timeout_s": self.timeout_s,
            "max_retries": self.max_retries
        }

    def to_pipeline_params(self) -> Dict[str, Any]:
        """Convert model configuration into pipeline parameter dictionary."""
        return {
            "llm.enabled": self.enabled,
            "llm.model": self.model_name,
            "llm.aliases": self.aliases,
            "llm.base_url": self.base_url,
            "llm.api_key": self.api_key,
            "llm.temperature": self.temperature,
            "llm.timeout_s": self.timeout_s,
            "llm.max_retries": self.max_retries,
        }

    def update(self, **kwargs):
        """Update configuration parameters in-memory."""
        if "enabled" in kwargs and kwargs["enabled"] is not None:
            self.enabled = bool(kwargs["enabled"])
        if "model_name" in kwargs and kwargs["model_name"]:
            self.model_name = str(kwargs["model_name"]).strip()
        elif "model" in kwargs and kwargs["model"]:
            self.model_name = str(kwargs["model"]).strip()
        if "base_url" in kwargs and kwargs["base_url"]:
            b_url = str(kwargs["base_url"]).strip()
            if b_url.endswith("/chat/completions"):
                b_url = b_url[:-len("/chat/completions")]
            self.base_url = b_url.rstrip("/")
        if "api_key" in kwargs and kwargs["api_key"] is not None:
            self.api_key = str(kwargs["api_key"])
        if "aliases" in kwargs and kwargs["aliases"] is not None:
            self.aliases = str(kwargs["aliases"]).strip()
        if "temperature" in kwargs and kwargs["temperature"] is not None:
            self.temperature = float(kwargs["temperature"])
        if "timeout_s" in kwargs and kwargs["timeout_s"] is not None:
            self.timeout_s = int(kwargs["timeout_s"])
        if "max_retries" in kwargs and kwargs["max_retries"] is not None:
            self.max_retries = int(kwargs["max_retries"])

    def save_to_env_file(self, target_path: Optional[Path] = None):
        """Persists upstream configuration to .env file and updates os.environ."""
        target = target_path or ENV_PATH
        content = f"""# ==============================================================================
# PhaseSUMMARY Upstream Model Configuration (quatmo-proxy compatible)
# ==============================================================================

# Custom Upstream Model Configuration (Gemma)
CUSTOM_BASE_URL={self.base_url}
CUSTOM_API_KEY={self.api_key}
CUSTOM_MODEL_NAME={self.model_name}
CUSTOM_MODEL_ALIASES={self.aliases}

# M5 Realizer Execution Parameters
LLM_ENABLED={'true' if self.enabled else 'false'}
LLM_TEMPERATURE={self.temperature}
LLM_TIMEOUT_S={self.timeout_s}
LLM_MAX_RETRIES={self.max_retries}

# Server & Storage Paths
PORT={os.getenv('PORT', '5050')}
OUTPUT_DIR={os.getenv('OUTPUT_DIR', r'd:\Fedu\PhaseSUMMARY\output_survey')}
"""
        with open(target, "w", encoding="utf-8") as f:
            f.write(content)

        # Synchronize active process environment variables
        os.environ["CUSTOM_BASE_URL"] = self.base_url
        os.environ["CUSTOM_API_KEY"] = self.api_key
        os.environ["CUSTOM_MODEL_NAME"] = self.model_name
        os.environ["CUSTOM_MODEL_ALIASES"] = self.aliases
        os.environ["LLM_ENABLED"] = "true" if self.enabled else "false"
        os.environ["LLM_TEMPERATURE"] = str(self.temperature)
        os.environ["LLM_TIMEOUT_S"] = str(self.timeout_s)
        os.environ["LLM_MAX_RETRIES"] = str(self.max_retries)

class AppConfig:
    """Application-level configuration SSOT."""
    def __init__(self):
        self.port = int(os.getenv("PORT", "5050"))
        self.output_dir = os.getenv("OUTPUT_DIR", str(Path(__file__).resolve().parent.parent / "output"))
        self.default_zip = os.getenv("DEFAULT_ZIP", "")
        self.model = ModelConfig()

    def reload(self):
        if ENV_PATH.exists():
            try:
                from dotenv import load_dotenv
                load_dotenv(dotenv_path=ENV_PATH, override=True)
            except Exception:
                pass
        self.port = int(os.getenv("PORT", "5050"))
        self.output_dir = os.getenv("OUTPUT_DIR", str(Path(__file__).resolve().parent.parent / "output"))
        self.default_zip = os.getenv("DEFAULT_ZIP", "")
        self.model = ModelConfig()

# Global Singleton
config = AppConfig()
