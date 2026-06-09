# WhatsFree Plugin

A Hermes Agent dashboard plugin that shows free LLM models across all
Hermes-supported providers — live from public endpoints and via detected
API keys.

## How it Works

### Key Detection (Auto)

The plugin scans **three sources** for Hermes API keys with **zero config**:

| Source | What it reads |
|--------|--------------|
| `os.environ` | Any env var already set in the shell session |
| `~/.hermes/.env` | The env file (used by `hermes setup`) |
| `~/.hermes/config.yaml` | Scans `api_key:` / `token:` fields from provider configs |

The 28 Hermes providers are tracked. If a key is found, the plugin tries
to **probe** that provider's `/v1/models` endpoint to list available models.
If no key is found, it falls back to **curated data** about that provider's
known free-tier models.

**Keys are never exposed.** The response only tells you *which* env vars
are configured (e.g. `["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"]`).

### Live Sources (No Key)

Three public model-list endpoints are fetched live (no key needed):

| Endpoint | Models Found | Description |
|----------|-------------|-------------|
| OpenRouter `/api/v1/models` | ~25 free | Filters to $0-pricing models only |
| HuggingFace Router `/v1/models` | ~120 | Community inference, rate-limited |
| Ollama Cloud `/v1/models` | ~41 | Shared inference, key optional |

### Key-Required Providers (Auto-Probed)

When a key is detected for any of these, their model list is probed live:

- DeepSeek, Google Gemini, GitHub Copilot, NVIDIA NIM
- OpenCode Zen, OpenCode Go, and others

### Curation Fallback

For key-required providers we can't probe, curated records describe the
known free-tier offerings. The `_source` field distinguishes:
- `live/live_hf/live_ollama` — real-time from public endpoints
- `probed` — fetched via your detected API key
- `curated` — fallback data for unprobed providers

## API Endpoints

All under `/api/plugins/whatsfree/`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Plugin version + cache info + detected keys |
| `/models` | GET | Full model discovery (cached 24h) |
| `/models?refresh=true` | GET | Force refresh from live sources |
| `/refresh` | POST | Force refresh + bust cache |
| `/providers` | GET | All 28 Hermes providers and their free tier info |
| `/keys` | GET | Which provider keys are detected (not values) |
| `/provider-status` | GET | Live status for every provider |

## Install

```bash
cp -r plugins/whatsfree ~/.hermes/plugins/whatsfree/
```

Restart Hermes Agent (`hermes start` or restart service). The dashboard
will show a "Free Models" tab.

## Data Flow

```
                   ┌──────────────────┐
                   │  os.environ      │
                   │  ~/.hermes/.env  │  ◄─── Key Detection
                   │  config.yaml     │
                   └────────┬─────────┘
                            │
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                   ▼
   ┌──────────┐    ┌──────────────┐    ┌──────────────┐
   │ Public   │    │ Key-Probed   │    │ Curated      │
   │ Endpoints│    │ Endpoints    │    │ Fallback     │
   │ (no key) │    │ (key needed) │    │ (no key)     │
   └────┬─────┘    └──────┬───────┘    └──────┬───────┘
        │                 │                    │
        └─────────────────┼────────────────────┘
                          ▼
                   ┌──────────────┐
                   │ 202+ models  │
                   │  28 providers│
                   │ 24h cache    │
                   └──────────────┘
```

## License

MIT
