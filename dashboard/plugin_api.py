"""WhatsFree dashboard plugin backend — enhanced.

Mounted by Hermes dashboard at /api/plugins/whatsfree/.

Discoveries performed:
  1. Scans os.environ + ~/.hermes/.env + ~/.hermes/config.yaml for all known
     Hermes provider API keys (28 providers).
  2. Fetches free model lists from public endpoints (no key) -- OpenRouter,
     HuggingFace Inference Router, Ollama Cloud.
  3. For each provider where a key IS detected, attempts to probe their
     /v1/models endpoint to report available models.
  4. Falls back to curated free-tier model data for key-required providers
     when no key is present or the probe fails.
  5. Caches everything for 24 hours with manual refresh.

No API keys are exposed in the response -- only a boolean indicating presence.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    from fastapi import APIRouter, Query
except Exception:
    class APIRouter:
        def get(self, *_args, **_kwargs):
            return lambda fn: fn
        def post(self, *_args, **_kwargs):
            return lambda fn: fn
    def Query(default=None, **_kwargs):
        return default

router = APIRouter()

PLUGIN_VERSION = "1.0.0"
CACHE_TTL = 86400  # 24 hours
CACHE_DIR_NAME = "cache"
CACHE_FILE_NAME = "whatsfree_models.json"
USER_AGENT = "hermes-cli/whatsfree-plugin/1.0"

# Every Hermes-supported provider, its env vars, and model listing
# endpoint. Source: hermes-agent/plugins/model-providers/*/__init__.py

PROVIDER_REGISTRY: List[Dict[str, Any]] = [
    # -- No-key-required providers (public listing endpoints) --
    {
        "id": "openrouter",
        "name": "OpenRouter",
        "display_name": "OpenRouter",
        "env_vars": [],
        "model_endpoint": "https://openrouter.ai/api/v1/models",
        "no_key_ok": True,
        "models_need_auth": False,
        "description": "Free $0-pricing models via OpenRouter's public model list.",
        "free_tier_type": "public",
        "order": 1,
    },
    {
        "id": "huggingface",
        "name": "HuggingFace",
        "display_name": "HuggingFace Community",
        "env_vars": ["HF_TOKEN"],
        "model_endpoint": "https://huggingface.co/api/models?pipeline_tag=text-generation&sort=downloads&direction=-1&limit=100",
        "no_key_ok": True,
        "models_need_auth": False,
        "description": "Community inference API on HuggingFace -- 120+ models, rate-limited.",
        "free_tier_type": "community",
        "order": 2,
    },
    {
        "id": "ollama-cloud",
        "name": "Ollama Cloud",
        "display_name": "Ollama Cloud",
        "env_vars": ["OLLAMA_API_KEY"],
        "model_endpoint": "https://ollama.com/api/tags",
        "no_key_ok": True,
        "models_need_auth": False,
        "description": "Ollama Cloud -- 40+ models, shared inference.",
        "free_tier_type": "community",
        "order": 3,
    },
    # -- Key-based free-tier providers --
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "display_name": "DeepSeek",
        "env_vars": ["DEEPSEEK_API_KEY"],
        "model_endpoint": "https://api.deepseek.com/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "DeepSeek -- free tier for chat & reasoning models (128K ctx).",
        "free_tier_type": "key_free_quota",
        "order": 10,
    },
    {
        "id": "gemini",
        "name": "Google Gemini",
        "display_name": "Google Gemini",
        "env_vars": ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
        "model_endpoint": "https://generativelanguage.googleapis.com/v1beta/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Gemini Flash models with generous free quota (1M ctx, 60 RPM).",
        "free_tier_type": "key_free_quota",
        "order": 11,
    },
    {
        "id": "copilot",
        "name": "GitHub Copilot",
        "display_name": "GitHub Copilot",
        "env_vars": ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
        "model_endpoint": "https://api.githubcopilot.com/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Free for verified students, teachers & OSS maintainers.",
        "free_tier_type": "key_free_quota",
        "order": 12,
    },
    {
        "id": "nvidia",
        "name": "NVIDIA NIM",
        "display_name": "NVIDIA NIM",
        "env_vars": ["NVIDIA_API_KEY"],
        "model_endpoint": "https://integrate.api.nvidia.com/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "NVIDIA NIM -- accelerated inference with free tier models.",
        "free_tier_type": "key_free_quota",
        "order": 13,
    },
    {
        "id": "opencode-zen",
        "name": "OpenCode Zen",
        "display_name": "OpenCode Zen",
        "env_vars": ["OPENCODE_ZEN_API_KEY"],
        "model_endpoint": "https://opencode.ai/zen/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Multi-model API gateway with free tier.",
        "free_tier_type": "key_free_quota",
        "order": 14,
    },
    {
        "id": "opencode-go",
        "name": "OpenCode Go",
        "display_name": "OpenCode Go",
        "env_vars": ["OPENCODE_GO_API_KEY"],
        "model_endpoint": "https://opencode.ai/go/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "OpenCode Go relay -- multi-model API gateway.",
        "free_tier_type": "key_free_quota",
        "order": 15,
    },
    # -- OAuth / browser-login providers --
    {
        "id": "openai-codex",
        "name": "OpenAI Codex",
        "display_name": "OpenAI Codex",
        "env_vars": [],
        "oauth": True,
        "model_endpoint": None,
        "no_key_ok": False,
        "models_need_auth": False,
        "description": "Free GPT-OSS models via OAuth browser flow.",
        "free_tier_type": "oauth_free",
        "order": 20,
    },
    {
        "id": "nous",
        "name": "Nous Research",
        "display_name": "Nous Research",
        "env_vars": ["NOUS_API_KEY"],
        "oauth": False,
        "model_endpoint": "https://inference.nousresearch.com/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Hermes 3 models via Nous Portal (OAuth or API key).",
        "free_tier_type": "oauth_free",
        "order": 21,
    },
    # -- Key-based providers (free tier uncertain) --
    {
        "id": "alibaba",
        "name": "Alibaba Cloud",
        "display_name": "Alibaba DashScope",
        "env_vars": ["DASHSCOPE_API_KEY"],
        "model_endpoint": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Alibaba Cloud DashScope -- multi-model API.",
        "free_tier_type": "unknown",
        "order": 30,
    },
    {
        "id": "anthropic",
        "name": "Anthropic",
        "display_name": "Anthropic",
        "env_vars": ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
        "model_endpoint": None,
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Anthropic Claude -- no free tier (paid API).",
        "free_tier_type": "no_free_tier",
        "order": 31,
    },
    {
        "id": "arcee",
        "name": "Arcee AI",
        "display_name": "Arcee AI",
        "env_vars": ["ARCEEAI_API_KEY"],
        "model_endpoint": "https://api.arcee.ai/api/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Arcee AI -- specialized fine-tuned models.",
        "free_tier_type": "unknown",
        "order": 32,
    },
    {
        "id": "azure-foundry",
        "name": "Azure Foundry",
        "display_name": "Azure AI Foundry",
        "env_vars": ["AZURE_FOUNDRY_API_KEY", "AZURE_FOUNDRY_BASE_URL"],
        "model_endpoint": None,
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Microsoft Azure Foundry -- pay-as-you-go.",
        "free_tier_type": "no_free_tier",
        "order": 33,
    },
    {
        "id": "bedrock",
        "name": "AWS Bedrock",
        "display_name": "AWS Bedrock",
        "env_vars": [],
        "model_endpoint": None,
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "AWS Bedrock -- pay-per-token, AWS SDK auth.",
        "free_tier_type": "no_free_tier",
        "order": 34,
    },
    {
        "id": "gmi",
        "name": "GMI Cloud",
        "display_name": "GMI Cloud",
        "env_vars": ["GMI_API_KEY"],
        "model_endpoint": "https://api.gmi-serving.com/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "GMI Cloud -- multi-model direct API.",
        "free_tier_type": "unknown",
        "order": 35,
    },
    {
        "id": "kilocode",
        "name": "Kilo Code",
        "display_name": "Kilo Code",
        "env_vars": ["KILOCODE_API_KEY"],
        "model_endpoint": "https://api.kilo.ai/api/gateway/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Kilo Code -- AI code gateway.",
        "free_tier_type": "unknown",
        "order": 36,
    },
    {
        "id": "kimi-coding",
        "name": "Kimi / Moonshot",
        "display_name": "Kimi (Moonshot AI)",
        "env_vars": ["KIMI_API_KEY", "KIMI_CN_API_KEY", "KIMI_CODING_API_KEY"],
        "model_endpoint": "https://api.moonshot.ai/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Kimi K2 models via Moonshot API.",
        "free_tier_type": "unknown",
        "order": 37,
    },
    {
        "id": "minimax",
        "name": "MiniMax",
        "display_name": "MiniMax",
        "env_vars": ["MINIMAX_API_KEY"],
        "model_endpoint": None,
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "MiniMax -- OAuth or API key access.",
        "free_tier_type": "unknown",
        "order": 38,
    },
    {
        "id": "novita",
        "name": "NovitaAI",
        "display_name": "NovitaAI",
        "env_vars": ["NOVITA_API_KEY"],
        "model_endpoint": "https://api.novita.ai/v3/openai/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "NovitaAI -- cloud inference, previously had free models.",
        "free_tier_type": "unknown",
        "order": 39,
    },
    {
        "id": "qwen-oauth",
        "name": "Qwen (Alibaba)",
        "display_name": "Qwen Portal",
        "env_vars": ["QWEN_API_KEY"],
        "model_endpoint": "https://portal.qwen.ai/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Qwen models via OAuth browser flow or API key.",
        "free_tier_type": "oauth_free",
        "order": 40,
    },
    {
        "id": "stepfun",
        "name": "StepFun",
        "display_name": "StepFun",
        "env_vars": ["STEPFUN_API_KEY"],
        "model_endpoint": "https://api.stepfun.ai/step_plan/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "StepFun -- AI API with step-3.5-flash free tier.",
        "free_tier_type": "unknown",
        "order": 41,
    },
    {
        "id": "xai",
        "name": "xAI (Grok)",
        "display_name": "xAI (Grok)",
        "env_vars": ["XAI_API_KEY"],
        "model_endpoint": "https://api.x.ai/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "xAI Grok models -- paid API.",
        "free_tier_type": "no_free_tier",
        "order": 42,
    },
    {
        "id": "xiaomi",
        "name": "Xiaomi MiMo",
        "display_name": "Xiaomi MiMo",
        "env_vars": ["XIAOMI_API_KEY"],
        "model_endpoint": "https://api.xiaomimimo.com/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Xiaomi MiMo -- multi-modal models.",
        "free_tier_type": "unknown",
        "order": 43,
    },
    {
        "id": "zai",
        "name": "Z.AI (GLM)",
        "display_name": "Z.AI (GLM / Zhipu)",
        "env_vars": ["GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"],
        "model_endpoint": "https://api.z.ai/api/paas/v4/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Z.AI / GLM -- Zhipu AI models.",
        "free_tier_type": "unknown",
        "order": 44,
    },
    {
        "id": "alibaba-coding-plan",
        "name": "Alibaba Coding Plan",
        "display_name": "Alibaba Coding Plan",
        "env_vars": ["ALIBABA_CODING_PLAN_API_KEY"],
        "model_endpoint": "https://coding-intl.dashscope.aliyuncs.com/v1/models",
        "no_key_ok": False,
        "models_need_auth": True,
        "description": "Alibaba Cloud dedicated coding tier.",
        "free_tier_type": "unknown",
        "order": 45,
    },
    {
        "id": "custom",
        "name": "Custom / Ollama",
        "display_name": "Custom / Local",
        "env_vars": [],
        "model_endpoint": None,
        "no_key_ok": True,
        "models_need_auth": False,
        "description": "Custom / local endpoints (Ollama, etc.) -- user-configured in config.",
        "free_tier_type": "local",
        "order": 100,
    },
]

# -- Curated free models --
# When a provider cannot be probed live, we supply curated data based
# on known free-tier models.

CURATED_FREE_MODELS: List[Dict[str, Any]] = [
    # DeepSeek
    {
        "id": "deepseek-chat",
        "provider": "deepseek",
        "provider_display": "DeepSeek",
        "name": "DeepSeek V3 Chat",
        "context_length": 65536,
        "free_tier_type": "key_free_quota",
        "auth_required": "DEEPSEEK_API_KEY",
        "endpoint": "https://api.deepseek.com/v1",
        "description": "DeepSeek's V3 chat model with strong general reasoning.",
    },
    {
        "id": "deepseek-reasoner",
        "provider": "deepseek",
        "provider_display": "DeepSeek",
        "name": "DeepSeek R1 Reasoner",
        "context_length": 65536,
        "free_tier_type": "key_free_quota",
        "auth_required": "DEEPSEEK_API_KEY",
        "endpoint": "https://api.deepseek.com/v1",
        "description": "DeepSeek's reasoning model, chain-of-thought (limited free tier).",
    },
    # Gemini
    {
        "id": "gemini-2.0-flash",
        "provider": "gemini",
        "provider_display": "Google Gemini",
        "name": "Gemini 2.0 Flash",
        "context_length": 1048576,
        "free_tier_type": "key_free_quota",
        "auth_required": "GOOGLE_API_KEY or GEMINI_API_KEY",
        "endpoint": "https://generativelanguage.googleapis.com/v1beta",
        "description": "Google's fastest multimodal, 1M ctx, 60 RPM free.",
    },
    {
        "id": "gemini-2.0-flash-lite",
        "provider": "gemini",
        "provider_display": "Google Gemini",
        "name": "Gemini 2.0 Flash Lite",
        "context_length": 1048576,
        "free_tier_type": "key_free_quota",
        "auth_required": "GOOGLE_API_KEY or GEMINI_API_KEY",
        "endpoint": "https://generativelanguage.googleapis.com/v1beta",
        "description": "Lighter Gemini 2.0 Flash, 1M ctx, free quota.",
    },
    {
        "id": "gemini-1.5-flash",
        "provider": "gemini",
        "provider_display": "Google Gemini",
        "name": "Gemini 1.5 Flash",
        "context_length": 1048576,
        "free_tier_type": "key_free_quota",
        "auth_required": "GOOGLE_API_KEY or GEMINI_API_KEY",
        "endpoint": "https://generativelanguage.googleapis.com/v1beta",
        "description": "Previous-gen flash, still free with generous quota.",
    },
    # GitHub Copilot
    {
        "id": "copilot-gpt-4o",
        "provider": "copilot",
        "provider_display": "GitHub Copilot",
        "name": "Copilot GPT-4o (free tier)",
        "context_length": 128000,
        "free_tier_type": "key_free_quota",
        "auth_required": "COPILOT_GITHUB_TOKEN or GH_TOKEN",
        "endpoint": "https://api.githubcopilot.com",
        "description": "Free tier: 2K completions/mo for all, unlimited for students/OSS.",
    },
    {
        "id": "copilot-claude-sonnet",
        "provider": "copilot",
        "provider_display": "GitHub Copilot",
        "name": "Copilot Claude Sonnet 4 (free tier)",
        "context_length": 200000,
        "free_tier_type": "key_free_quota",
        "auth_required": "COPILOT_GITHUB_TOKEN or GH_TOKEN",
        "endpoint": "https://api.githubcopilot.com",
        "description": "Claude Sonnet 4 via GitHub Models.",
    },
    # HuggingFace (key optional models)
    {
        "id": "meta-llama/Llama-3.1-8B-Instruct",
        "provider": "huggingface",
        "provider_display": "HuggingFace Community",
        "name": "Llama 3.1 8B Instruct",
        "context_length": 131072,
        "free_tier_type": "community",
        "auth_required": "None (HF_TOKEN optional for higher rate limits)",
        "endpoint": "https://huggingface.co/api/models",
        "description": "Community inference, rate-limited, no key required.",
    },
    {
        "id": "microsoft/Phi-4",
        "provider": "huggingface",
        "provider_display": "HuggingFace Community",
        "name": "Phi-4",
        "context_length": 16384,
        "free_tier_type": "community",
        "auth_required": "None (HF_TOKEN optional)",
        "endpoint": "https://huggingface.co/api/models",
        "description": "Microsoft's small capable model, community inference.",
    },
    {
        "id": "deepseek-ai/DeepSeek-V4-Flash",
        "provider": "huggingface",
        "provider_display": "HuggingFace Community",
        "name": "DeepSeek V4 Flash",
        "context_length": 65536,
        "free_tier_type": "community",
        "auth_required": "None",
        "endpoint": "https://huggingface.co/api/models",
        "description": "DeepSeek V4 via HuggingFace community inference.",
    },
    # Nous Research
    {
        "id": "hermes-3-llama-3.1-405b",
        "provider": "nous",
        "provider_display": "Nous Research",
        "name": "Hermes 3 405B Instruct",
        "context_length": 131072,
        "free_tier_type": "oauth_free",
        "auth_required": "OAuth browser flow or NOUS_API_KEY",
        "endpoint": "https://inference.nousresearch.com/v1",
        "description": "Nous Research's flagship, free via Portal or API key.",
    },
    {
        "id": "hermes-3-llama-3.1-70b",
        "provider": "nous",
        "provider_display": "Nous Research",
        "name": "Hermes 3 70B Instruct",
        "context_length": 131072,
        "free_tier_type": "oauth_free",
        "auth_required": "OAuth browser flow or NOUS_API_KEY",
        "endpoint": "https://inference.nousresearch.com/v1",
        "description": "Smaller Hermes 3, free via Portal or API key.",
    },
    # OpenAI Codex
    {
        "id": "gpt-oss-120b",
        "provider": "openai-codex",
        "provider_display": "OpenAI Codex",
        "name": "GPT-OSS 120B",
        "context_length": 131072,
        "free_tier_type": "oauth_free",
        "auth_required": "OAuth: `hermes auth add openai-codex`",
        "endpoint": "https://chatgpt.com/backend-api/codex",
        "description": "OpenAI's open-weight 117B MoE model, free via Codex OAuth.",
    },
    {
        "id": "gpt-oss-20b",
        "provider": "openai-codex",
        "provider_display": "OpenAI Codex",
        "name": "GPT-OSS 20B",
        "context_length": 131072,
        "free_tier_type": "oauth_free",
        "auth_required": "OAuth: `hermes auth add openai-codex`",
        "endpoint": "https://chatgpt.com/backend-api/codex",
        "description": "OpenAI's open-weight 21B model, free via Codex OAuth.",
    },
    # Qwen
    {
        "id": "qwen-max",
        "provider": "qwen-oauth",
        "provider_display": "Qwen Portal",
        "name": "Qwen Max",
        "context_length": 131072,
        "free_tier_type": "oauth_free",
        "auth_required": "OAuth: `hermes auth add qwen-oauth` or QWEN_API_KEY",
        "endpoint": "https://portal.qwen.ai/v1",
        "description": "Alibaba's largest Qwen model, free via OAuth or key.",
    },
    # NVIDIA NIM
    {
        "id": "nvidia/llama-3.1-nemotron-70b-instruct",
        "provider": "nvidia",
        "provider_display": "NVIDIA NIM",
        "name": "Nemotron 70B Instruct",
        "context_length": 128000,
        "free_tier_type": "key_free_quota",
        "auth_required": "NVIDIA_API_KEY",
        "endpoint": "https://integrate.api.nvidia.com/v1",
        "description": "NVIDIA NIM -- free tier Nemotron model.",
    },
    # OpenCode Zen
    {
        "id": "opencode-zen-default",
        "provider": "opencode-zen",
        "provider_display": "OpenCode Zen",
        "name": "OpenCode Zen (free tier gateway)",
        "context_length": 128000,
        "free_tier_type": "key_free_quota",
        "auth_required": "OPENCODE_ZEN_API_KEY",
        "endpoint": "https://opencode.ai/zen/v1",
        "description": "Multi-model aggregator with free tier.",
    },
]


# -- Key detection helpers -----------------------------------------

def _hermes_home() -> Path:
    env = os.environ.get("HERMES_HOME") or ""
    if env:
        return Path(env)
    return Path.home() / ".hermes"


def _parse_env_file(path: Path) -> Dict[str, str]:
    """Parse a .env file into key-value pairs (no expansion)."""
    result: Dict[str, str] = {}
    if not path.exists():
        return result
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("\"'").strip("'")
        if not value or value.startswith("$"):
            continue
        result[key] = value
    return result


def _parse_config_yaml(path: Path) -> Dict[str, str]:
    """Parse a config.yaml to extract provider api_key / token fields."""
    if not path.exists():
        return {}
    text = path.read_text()
    result: Dict[str, str] = {}
    sec_key_count: int = 0
    for match in re.finditer(
        r'(?:api_key|token|access_token)\s*:\s*["\']?([^"\'{}\n]+)["\']?\s*(?:#.*)?$',
        text, re.MULTILINE
    ):
        val = match.group(1).strip()
        if val:
            sec_key_count += 1
            result[f"_config_key_{sec_key_count}"] = val
    return result


def _detect_all_keys() -> Dict[str, List[str]]:
    """Detect all configured API keys from all sources.

    Returns a dict: {provider_id: [list of matched env var names]}.
    Keys themselves are NOT exposed in the output.
    """
    all_source_keys: Dict[str, str] = {}

    # 1. os.environ
    for key, val in os.environ.items():
        if val:
            all_source_keys[key] = val

    # 2. ~/.hermes/.env (ignores already-set env vars)
    env_path = _hermes_home() / ".env"
    for key, val in _parse_env_file(env_path).items():
        if key not in all_source_keys:
            all_source_keys[key] = val

    # 3. ~/.hermes/config.yaml (api_key/token fields)
    config_path = _hermes_home() / "config.yaml"
    for key, val in _parse_config_yaml(config_path).items():
        if key not in all_source_keys:
            all_source_keys[key] = val

    # Match against provider registry
    provider_keys: Dict[str, List[str]] = {}
    for prov in PROVIDER_REGISTRY:
        provider_id = prov["id"]
        matched: List[str] = []
        for env_var in prov.get("env_vars", []):
            if env_var in all_source_keys and all_source_keys[env_var]:
                matched.append(env_var)
        if matched:
            provider_keys[provider_id] = matched

    return provider_keys


def _get_detected_key_names() -> List[str]:
    """Return the list of env var names that have values configured."""
    keys = _detect_all_keys()
    names: List[str] = []
    seen: set = set()
    for prov_id, matched_vars in keys.items():
        for v in matched_vars:
            if v not in seen:
                names.append(v)
                seen.add(v)
    return sorted(names)


def _has_key_for(provider_id: str) -> bool:
    """Check if at least one env var for this provider is configured."""
    keys = _detect_all_keys()
    return provider_id in keys


def _get_env_var_value(name: str) -> Optional[str]:
    """Get a raw env var value from the three sources.

    Only used for live API probing (never exposed in output).
    """
    val = os.environ.get(name)
    if val:
        return val
    env_path = _hermes_home() / ".env"
    parsed = _parse_env_file(env_path)
    if name in parsed and parsed[name]:
        return parsed[name]
    return None


# -- Live model fetchers --------------------------------------------

def _fetch_openrouter_models() -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Fetch free models from OpenRouter (no key needed)."""
    try:
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/models",
            headers={"User-Agent": USER_AGENT},
        )
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read().decode())
        models = []
        for m in data.get("data", []):
            pricing = m.get("pricing", {})
            prompt_price = float(pricing.get("prompt", 999))
            completion_price = float(pricing.get("completion", 999))
            if prompt_price == 0 and completion_price == 0:
                mid = m["id"]
                if "lyria" in mid:
                    continue
                models.append({
                    "id": mid,
                    "provider": "openrouter",
                    "provider_display": "OpenRouter",
                    "name": m.get("name", mid).split(" (")[0],
                    "context_length": m.get("context_length", 0) or 0,
                    "free_tier_type": "public",
                    "auth_required": "None",
                    "requires_key": False,
                    "key_present": None,
                    "endpoint": "https://openrouter.ai/api/v1",
                    "description": ((m.get("description") or "").split(". ")[0])[:150],
                    "_source": "live",
                })
        return models, None
    except urllib.error.HTTPError as e:
        return [], f"OpenRouter HTTP {e.code}: {e.reason[:100] if e.reason else ''}"
    except urllib.error.URLError as e:
        return [], f"OpenRouter URL error: {e.reason[:100] if e.reason else 'timeout'}"
    except Exception as e:
        return [], f"OpenRouter: {type(e).__name__}: {str(e)[:100]}"


def _fetch_huggingface_models() -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Fetch models from HuggingFace Inference Router (no key needed)."""
    try:
        req = urllib.request.Request(
            "https://huggingface.co/api/models?pipeline_tag=text-generation&sort=downloads&direction=-1&limit=100",
            headers={"User-Agent": USER_AGENT},
        )
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read().decode())
        models = []
        for m in data if isinstance(data, list) else data.get("data", data.get("models", [])):
            if isinstance(m, dict):
                mid = m.get("id", "")
                if not mid:
                    continue
                models.append({
                    "id": mid,
                    "provider": "huggingface",
                    "provider_display": "HuggingFace Community",
                    "name": m.get("name", mid).split(" (")[0],
                    "context_length": m.get("context_length", m.get("max_context_length", 0)) or 0,
                    "free_tier_type": "community",
                    "auth_required": "None",
                    "requires_key": False,
                    "key_present": _has_key_for("huggingface"),
                    "endpoint": "https://huggingface.co/api/models",
                    "description": m.get("description", "")[:150] if m.get("description") else "",
                    "_source": "live_hf",
                })
        return models, None
    except urllib.error.HTTPError as e:
        return [], f"HuggingFace HTTP {e.code}"
    except Exception as e:
        return [], f"HuggingFace: {type(e).__name__}: {str(e)[:100]}"


def _fetch_ollama_models() -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Fetch models from Ollama (no key needed)."""
    try:
        req = urllib.request.Request(
            "https://ollama.com/api/tags",
            headers={"User-Agent": USER_AGENT},
        )
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read().decode())
        models = []
        raw = data.get("models", [])
        for m in raw if isinstance(raw, list) else []:
            if isinstance(m, dict):
                mid = m.get("name", "")
                if not mid:
                    continue
                models.append({
                    "id": mid,
                    "provider": "ollama-cloud",
                    "provider_display": "Ollama Cloud",
                    "name": mid,
                    "context_length": 0,
                    "free_tier_type": "community",
                    "auth_required": "None",
                    "requires_key": False,
                    "key_present": _has_key_for("ollama-cloud"),
                    "endpoint": "https://ollama.com",
                    "description": "",
                    "_source": "live_ollama",
                })
        return models, None
    except urllib.error.HTTPError as e:
        return [], f"Ollama HTTP {e.code}"
    except Exception as e:
        return [], f"Ollama: {type(e).__name__}: {str(e)[:100]}"


def _probe_provider_models(
    provider_id: str,
    endpoint: Optional[str],
    env_vars: List[str],
    key_present: bool,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Probe a provider's /v1/models endpoint using its API key.

    Returns (models list, error string or None).
    """
    if not endpoint:
        return [], None

    if not key_present:
        return [], None

    key_value: Optional[str] = None
    for var in env_vars:
        val = _get_env_var_value(var)
        if val:
            key_value = val
            break

    if not key_value:
        return [], None

    try:
        req = urllib.request.Request(
            endpoint,
            headers={
                "User-Agent": USER_AGENT,
                "Authorization": f"Bearer {key_value}",
                "Accept": "application/json",
            },
        )
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read().decode())
        models = []
        raw = data if isinstance(data, list) else data.get("data", data.get("models", []))
        if isinstance(raw, list):
            for m in raw[:50]:
                if isinstance(m, dict):
                    mid = m.get("id", "")
                    if not mid:
                        continue
                    models.append({
                        "id": mid,
                        "provider": provider_id,
                        "name": m.get("name", mid).split(" (")[0],
                        "object": "model",
                        "context_length": m.get("context_length", m.get("max_context_length", 0)) or 0,
                        "_source": "probed",
                    })
            return models, None
        return [], "Unexpected response format"
    except urllib.error.HTTPError as e:
        if e.code == 401 or e.code == 403:
            return [], f"Auth failed (HTTP {e.code})"
        if e.code == 404:
            return [], None
        return [], f"HTTP {e.code}"
    except urllib.error.URLError:
        return [], "Connection failed"
    except Exception:
        return [], "Probe error"


# -- Main discovery -----------------------------------------------

def _get_provider_status() -> List[Dict[str, Any]]:
    """Get status for every provider: key detected, live probed, etc."""
    detected = _detect_all_keys()
    results: List[Dict[str, Any]] = []

    for prov in PROVIDER_REGISTRY:
        provider_id = prov["id"]
        key_present = provider_id in detected
        matched_vars = detected.get(provider_id, [])
        oauth = prov.get("oauth", False)

        status: Dict[str, Any] = {
            "id": provider_id,
            "name": prov["display_name"],
            "description": prov["description"],
            "key_present": key_present,
            "key_env_vars": matched_vars if key_present else [],
            "oauth": oauth,
            "free_tier_type": prov["free_tier_type"],
            "model_count_live": None,
            "public_listing": prov.get("no_key_ok", False),
            "error": None,
        }

        if key_present and prov.get("model_endpoint"):
            models, err = _probe_provider_models(
                provider_id,
                prov["model_endpoint"],
                prov.get("env_vars", []),
                key_present,
            )
            status["model_count_live"] = len(models) if models else 0
            status["error"] = err

        results.append(status)

    return results


def _aggregate_all_models() -> Dict[str, Any]:
    """Full model discovery from all sources."""
    # 1. Live from no-key endpoints
    or_models, or_err = _fetch_openrouter_models()
    hf_models, hf_err = _fetch_huggingface_models()
    ol_models, ol_err = _fetch_ollama_models()

    # 2. Probe key-protected provider endpoints
    detected = _detect_all_keys()
    probed_models: List[Dict[str, Any]] = []
    probe_errors: List[str] = []
    for prov in PROVIDER_REGISTRY:
        pid = prov["id"]
        if pid not in detected:
            continue
        if pid in ("openrouter", "huggingface", "ollama-cloud"):
            continue
        if not prov.get("model_endpoint"):
            continue
        models, err = _probe_provider_models(
            pid,
            prov["model_endpoint"],
            prov.get("env_vars", []),
            True,
        )
        if err:
            probe_errors.append(f"{prov['display_name']}: {err}")
        for m in models:
            m["provider_display"] = prov["display_name"]
            m["free_tier_type"] = prov["free_tier_type"]
            m["auth_required"] = ", ".join(prov.get("env_vars", []))
            m["requires_key"] = True
            m["key_present"] = True
            m["endpoint"] = prov["model_endpoint"]
            probed_models.append(m)

    # 3. Curated free models (fallback for key providers)
    curated = []
    for cm in CURATED_FREE_MODELS:
        curated_model = dict(cm)
        curated_model["_source"] = "curated"
        pid = cm["provider"]
        curated_model["key_present"] = _has_key_for(pid)
        curated_model["requires_key"] = not curated_model["key_present"]
        curated.append(curated_model)

    all_models = or_models + hf_models + ol_models + probed_models + curated

    # Build summary
    provider_counts: Dict[str, int] = {}
    free_type_counts: Dict[str, int] = {}
    source_counts: Dict[str, int] = {}
    for m in all_models:
        pd = m.get("provider_display", "Other")
        provider_counts[pd] = provider_counts.get(pd, 0) + 1
        ft = m.get("free_tier_type", "unknown")
        free_type_counts[ft] = free_type_counts.get(ft, 0) + 1
        src = m.get("_source", "curated")
        source_counts[src] = source_counts.get(src, 0) + 1

    no_key_count = sum(1 for m in all_models if m.get("requires_key") is False)
    key_req_count = sum(1 for m in all_models if m.get("requires_key") is True)
    key_present_count = sum(1 for m in all_models if m.get("key_present") is True)

    provider_status = _get_provider_status()

    return {
        "models": all_models,
        "summary": {
            "total": len(all_models),
            "by_provider": provider_counts,
            "by_free_type": free_type_counts,
            "by_source": source_counts,
            "no_key_needed": no_key_count,
            "key_needed": key_req_count,
            "key_present": key_present_count,
            "providers_count": len(provider_counts),
        },
        "provider_status": provider_status,
        "errors": {
            "openrouter": or_err,
            "huggingface": hf_err,
            "ollama": ol_err,
            "probes": probe_errors,
        },
        "detected_env_vars": _get_detected_key_names(),
        "version": PLUGIN_VERSION,
    }


# -- Cache ---------------------------------------------------------

def _cache_dir() -> Path:
    d = _hermes_home() / CACHE_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cache_path() -> Path:
    return _cache_dir() / CACHE_FILE_NAME


def _read_cache() -> Optional[Dict[str, Any]]:
    path = _cache_path()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        cached_at = data.get("cached_at", 0)
        if time.time() - cached_at > CACHE_TTL:
            return None
        return data
    except (json.JSONDecodeError, OSError):
        return None


def _write_cache(data: Dict[str, Any]) -> None:
    data["cached_at"] = time.time()
    data["cached_at_iso"] = datetime.now(timezone.utc).isoformat()
    try:
        _cache_path().write_text(json.dumps(data, indent=2, default=str))
    except OSError:
        pass


# -- API Endpoints --------------------------------------------------


@router.get("/status")
async def status() -> Dict[str, Any]:
    """Plugin version and cache status."""
    cached = _read_cache()
    det = _get_detected_key_names()
    return {
        "version": PLUGIN_VERSION,
        "cached": cached is not None,
        "cached_at": cached["cached_at_iso"] if cached else None,
        "cache_ttl_hours": CACHE_TTL // 3600,
        "detected_provider_keys": len(det),
        "detected_env_vars": det,
    }


@router.get("/models")
async def get_models(
    refresh: bool = Query(False, description="Force refresh from live endpoints"),
) -> Dict[str, Any]:
    """Return the full model discovery (cached with 24h TTL)."""
    if not refresh:
        cached = _read_cache()
        if cached is not None:
            return cached
    data = _aggregate_all_models()
    _write_cache(data)
    return data


@router.post("/refresh")
async def refresh_models() -> Dict[str, Any]:
    """Force refresh model data from all live sources."""
    data = _aggregate_all_models()
    _write_cache(data)
    data["refreshed"] = True
    return data


@router.get("/providers")
async def list_providers() -> Dict[str, Any]:
    """Return all Hermes-supported providers with their free tier info."""
    return {
        "version": PLUGIN_VERSION,
        "providers": PROVIDER_REGISTRY,
    }


@router.get("/keys")
async def list_detected_keys() -> Dict[str, Any]:
    """Return which provider env vars are detected (NOT the key values)."""
    det = _detect_all_keys()
    result = {}
    for prov_id, matched in det.items():
        result[prov_id] = {
            "env_vars_detected": matched,
            "key_present": True,
        }
    return {
        "version": PLUGIN_VERSION,
        "providers_with_keys": result,
        "total_providers_with_keys": len(result),
        "total_env_vars_found": len(_get_detected_key_names()),
    }


@router.get("/provider-status")
async def provider_status_endpoint() -> Dict[str, Any]:
    """Live status of every Hermes provider."""
    return {
        "version": PLUGIN_VERSION,
        "providers": _get_provider_status(),
    }
