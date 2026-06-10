/* Hermes WhatsFree Plugin — dashboard UI tab.
 * Fetches free models directly from public internet endpoints (OpenRouter,
 * HuggingFace Router, Ollama Cloud) so no dashboard auth is needed for the
 * core feature. Backend key-detection API is called only when available.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var React = SDK.React;
  var hooks = SDK.hooks;
  var components = SDK.components;
  var Card = components.Card;
  var CardHeader = components.CardHeader;
  var CardTitle = components.CardTitle;
  var CardContent = components.CardContent;
  var Badge = components.Badge;
  var Button = components.Button;
  var Separator = components.Separator;
  var useState = hooks.useState;
  var useEffect = hooks.useEffect;
  var useMemo = hooks.useMemo;
  var e = React.createElement;

  function fmtTime(value) {
    if (!value) return "\u2014";
    var d = typeof value === "number"
      ? new Date(value < 1000000000000 ? value * 1000 : value)
      : new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
  }

  function classNames() {
    var cls = [];
    for (var i = 0; i < arguments.length; i++) {
      var arg = arguments[i];
      if (!arg) continue;
      if (typeof arg === "string") cls.push(arg);
      else if (Array.isArray(arg)) cls.push(classNames.apply(null, arg));
      else if (typeof arg === "object") for (var k in arg) if (arg[k]) cls.push(k);
    }
    return cls.join(" ");
  }

  /* ─── Data Sources ───────────────────────────────────────*/

  /* OpenRouter: GET /api/v1/models, filter where pricing.completion=0
   * and pricing.prompt=0. Public endpoint, no key needed for listing. */
  var OR_API = "https://openrouter.ai/api/v1/models";

  /* HuggingFace: public model API (no auth needed), filter to text-generation */
  var HF_API = "https://huggingface.co/api/models?pipeline_tag=text-generation&sort=downloads&direction=-1&limit=100";

  /* Ollama cloud listing */
  var OLLAMA_API = "https://cloud.ollama.com/api/v1/models";

  /* Backend (dashboard auth-gated) for key detection */
  var API_BASE = "/api/plugins/whatsfree";

  /* Free tier classification by provider id */
  var PROVIDER_FREE_TYPES = {
    openrouter: "public",
    huggingface: "community",
    "ollama-cloud": "community",
    deepseek: "key_free_quota",
    gemini: "key_free_quota",
    copilot: "key_free_quota",
    nvidia: "key_free_quota",
    "opencode-zen": "key_free_quota",
    "opencode-go": "key_free_quota",
    "openai-codex": "oauth_free",
    nous: "oauth_free",
    "qwen-oauth": "oauth_free",
    anthropic: "no_free_tier",
    "azure-foundry": "no_free_tier",
    bedrock: "no_free_tier",
    xai: "no_free_tier",
    custom: "local",
  };

  var PROVIDER_DISPLAY = {
    openrouter: "OpenRouter (Free)",
    huggingface: "HuggingFace Community",
    "ollama-cloud": "Ollama Cloud",
    deepseek: "DeepSeek",
    gemini: "Google Gemini",
    copilot: "GitHub Copilot",
    nvidia: "NVIDIA NIM",
    "opencode-zen": "OpenCode Zen",
    "opencode-go": "OpenCode Go",
    "openai-codex": "OpenAI Codex",
    nous: "Nous Research",
    "qwen-oauth": "Qwen Portal",
    anthropic: "Anthropic",
    "azure-foundry": "Azure AI Foundry",
    bedrock: "AWS Bedrock",
    xai: "xAI",
    custom: "Custom / Local",
    alibaba: "Alibaba",
    "alibaba-coding-plan": "Alibaba Coding Plan",
    arcee: "Arcee",
    gmi: "GMI",
    kilocode: "Kilocode",
    "kimi-coding": "Kimi Coding",
    minimax: "MiniMax",
    novita: "Novita",
    stepfun: "StepFun",
    xiaomi: "Xiaomi",
    zai: "Z.AI",
  };

  /* Known free models from key-required providers (curated fallback) */
  var CURATED_FREE = [
    { id: "deepseek-chat",           provider: "deepseek",    free_type: "key_free_quota", context: 65536 },
    { id: "deepseek-reasoner",       provider: "deepseek",    free_type: "key_free_quota", context: 65536 },
    { id: "gemini-2.0-flash-exp",    provider: "gemini",      free_type: "key_free_quota", context: 1048576 },
    { id: "gemini-2.0-flash-lite-preview-02-05", provider: "gemini", free_type: "key_free_quota", context: 1048576 },
    { id: "gemini-1.5-flash",        provider: "gemini",      free_type: "key_free_quota", context: 1048576 },
    { id: "gpt-4o-mini",             provider: "copilot",     free_type: "key_free_quota", context: 128000 },
    { id: "gpt-4o",                  provider: "copilot",     free_type: "key_free_quota", context: 128000 },
    { id: "nvidia/llama-3.1-nemotron-70b-instruct", provider: "nvidia", free_type: "key_free_quota", context: 128000 },
    { id: "opencode-zen-7b",         provider: "opencode-zen", free_type: "key_free_quota", context: 32768 },
    { id: "opencode-go-nemotron",    provider: "opencode-go",  free_type: "key_free_quota", context: 128000 },
    { id: "codex-claude-sonnet-4",   provider: "openai-codex", free_type: "oauth_free", context: 200000 },
    { id: "codex-gpt-4o",           provider: "openai-codex", free_type: "oauth_free", context: 128000 },
    { id: "nous-chat-v1",           provider: "nous",         free_type: "oauth_free", context: 65536 },
    { id: "nous-chat-v1-32k",       provider: "nous",         free_type: "oauth_free", context: 32768 },
    { id: "qwen-turbo",             provider: "qwen-oauth",   free_type: "oauth_free", context: 131072 },
    { id: "qwen-plus",              provider: "qwen-oauth",   free_type: "oauth_free", context: 131072 },
    { id: "qwen-max",               provider: "qwen-oauth",   free_type: "oauth_free", context: 32768 },
  ];

  /* ─── Live Fetch Functions ──────────────────────────────*/

  function fetchOpenRouter() {
    return fetch(OR_API, { headers: { "User-Agent": "hermes-whatsfree" } })
      .then(function (r) { if (!r.ok) throw new Error("OR " + r.status); return r.json(); })
      .then(function (data) {
        if (!data || !data.data) return [];
        return data.data
          .filter(function (m) {
            var p = m.pricing || {};
            return parseFloat(p.completion || 0) === 0 && parseFloat(p.prompt || 0) === 0 && m.id;
          })
          .map(function (m) {
            return {
              id: m.id,
              provider: "openrouter",
              provider_display: "OpenRouter (Free)",
              free_tier_type: "public",
              context: m.context_length || null,
              _source: "live",
            };
          });
      });
  }

  function fetchHuggingFace() {
    return fetch(HF_API, { headers: { "User-Agent": "hermes-whatsfree" } })
      .then(function (r) { if (!r.ok) throw new Error("HF " + r.status); return r.json(); })
      .then(function (data) {
        var arr = Array.isArray(data) ? data : (data.models || data.data || []);
        return arr
          .filter(function (m) { return m.id; })
          .slice(0, 100)
          .map(function (m) {
            return {
              id: m.id,
              provider: "huggingface",
              provider_display: "HuggingFace Community",
              free_tier_type: "community",
              context: null,
              _source: "live_hf",
            };
          });
      });
  }

  function fetchOllama() {
    return fetch(OLLAMA_API, { headers: { "User-Agent": "hermes-whatsfree" } })
      .then(function (r) { if (!r.ok) throw new Error("Ollama " + r.status); return r.json(); })
      .then(function (data) {
        var models = data && (data.models || data.data);
        if (!Array.isArray(models)) return [];
        return models
          .filter(function (m) { return m.name || m.id; })
          .map(function (m) {
            return {
              id: m.name || m.id,
              provider: "ollama-cloud",
              provider_display: "Ollama Cloud",
              free_tier_type: "community",
              context: null,
              _source: "live_ollama",
            };
          });
      });
  }

  function fetchBackendKeyStatus() {
    return SDK.fetchJSON(API_BASE + "/keys")
      .then(function (data) { return data; })
      .catch(function () { return { env_vars_found: [], total_env_vars_found: 0, sources_scanned: [] }; });
  }

  function fetchBackendProviderStatus() {
    return SDK.fetchJSON(API_BASE + "/provider-status")
      .then(function (data) { return data; })
      .catch(function () { return { providers: [] }; });
  }

  /* ─── Aggregate All Sources ────────────────────────────*/

  function aggregateModels(orModels, hfModels, ollamaModels, curated) {
    var all = orModels.concat(hfModels).concat(ollamaModels).concat(curated);
    var grouped = {};
    all.forEach(function (m) {
      var key = m.provider + "|" + m.id;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(m);
    });
    var deduped = [];
    for (var key in grouped) {
      var ms = grouped[key];
      var live = ms.filter(function (m) { return m._source && m._source.indexOf("live") === 0; });
      deduped.push(live.length > 0 ? live[0] : ms[0]);
    }

    var bySource = {};
    var byFreeType = {};
    var providerSet = {};
    deduped.forEach(function (m) {
      bySource[m._source] = (bySource[m._source] || 0) + 1;
      byFreeType[m.free_tier_type] = (byFreeType[m.free_tier_type] || 0) + 1;
      providerSet[m.provider_display] = true;
    });

    var noKey = deduped.filter(function (m) { return m.free_tier_type === "public" || m.free_tier_type === "community"; });
    var needsKey = deduped.filter(function (m) { return m.free_tier_type !== "public" && m.free_tier_type !== "community"; });

    return {
      models: deduped,
      summary: {
        total: deduped.length,
        providers_count: Object.keys(providerSet).length,
        no_key_needed: noKey.length,
        key_needed: needsKey.length,
        by_source: bySource,
        by_free_type: byFreeType,
      },
    };
  }

  /* ─── View Helpers ─────────────────────────────────────*/

  function sourceLabel(s) {
    var map = { live: "Live", live_hf: "Live (HF)", live_ollama: "Live (Ollama)", curated: "Curated" };
    return map[s] || s;
  }

  function sourceTone(s) {
    var map = { live: "success", live_hf: "info", live_ollama: "info", curated: "outline" };
    return map[s] || "outline";
  }

  function freeTone(t) {
    var map = { public: "success", community: "info", key_free_quota: "warning", oauth_free: "info", no_free_tier: "critical", local: "secondary" };
    return map[t] || "outline";
  }

  function freeLabel(t) {
    var map = {
      public: "Public", community: "Community", key_free_quota: "Free w/ Key",
      oauth_free: "Free (OAuth)", no_free_tier: "Paid", local: "Local", unknown: "Unknown"
    };
    return map[t] || t;
  }

  /* ─── Sub-components ───────────────────────────────────*/

  function LoadingState() {
    return e("div", { className: "wf-loading" },
      e("div", { className: "wf-spinner" }),
      e("p", null, "Fetching free models from OpenRouter, HuggingFace, and Ollama...")
    );
  }

  function ErrorState(_ref) {
    var message = _ref.message, onRetry = _ref.onRetry;
    return e(Card, { className: "wf-error-card" },
      e(CardContent, null,
        e("p", { className: "wf-error-title" }, "\u26A0\uFE0F Failed to load models"),
        e("p", { className: "wf-error-detail" }, message),
        onRetry ? e(Button, { onClick: onRetry, size: "sm", variant: "outline", className: "wf-retry-btn" }, "Retry") : null
      )
    );
  }

  function SummaryCards(_ref2) {
    var summary = _ref2.summary;
    if (!summary) return null;
    var items = [
      { label: "Free Models", value: summary.total, tone: "success" },
      { label: "Providers", value: summary.providers_count, tone: "info" },
      { label: "No Key Needed", value: summary.no_key_needed, tone: "success" },
      { label: "Key Required", value: summary.key_needed, tone: "warning" },
    ];
    return e("div", { className: "wf-summary-grid" },
      items.map(function (item) {
        return e(Card, { key: item.label, className: "wf-summary-card" },
          e(CardContent, null,
            e("div", { className: "wf-summary-value" }, String(item.value)),
            e("div", { className: "wf-summary-label" }, item.label)
          )
        );
      })
    );
  }

  function ProviderIcon(_ref3) {
    var provider = _ref3.provider;
    var icon = (provider || "").toLowerCase().charAt(0);
    return e("span", { className: "wf-provider-icon" }, icon);
  }

  function SourceBadge(_ref4) {
    var source = _ref4.source;
    return e(Badge, { tone: sourceTone(source), size: "sm" }, sourceLabel(source));
  }

  function FreeTierBadge(_ref5) {
    var freeType = _ref5.freeType;
    return e(Badge, { tone: freeTone(freeType), size: "sm" }, freeLabel(freeType));
  }

  function ModelCard(_ref6) {
    var model = _ref6.model;
    return e("div", { className: "wf-model-card" },
      e("div", { className: "wf-model-name" }, model.id),
      e("div", { className: "wf-model-tags" },
        e(FreeTierBadge, { freeType: model.free_tier_type }),
        e(SourceBadge, { source: model._source }),
        model.context ? e(Badge, { tone: "outline", size: "sm" }, String(model.context)) : null
      )
    );
  }

  function ProviderGroup(_ref7) {
    var provider = _ref7.provider, models = _ref7.models;
    var _useState = useState(true), collapsed = _useState[0], setCollapsed = _useState[1];
    return e("div", { className: "wf-provider-group" },
      e("button", {
        className: "wf-provider-toggle",
        onClick: function () { setCollapsed(!collapsed); },
      },
        e("span", { className: classNames("wf-chevron", collapsed ? "wf-chevron-collapsed" : "") }, ""),
        e(ProviderIcon, { provider: provider }),
        e("span", { className: "wf-provider-name" }, provider),
        e(Badge, { tone: "outline", size: "sm" }, models.length + " model" + (models.length === 1 ? "" : "s"))
      ),
      collapsed ? null : e("div", { className: "wf-model-grid" },
        models.map(function (m, i) {
          return e(ModelCard, { key: m.id + "-" + i, model: m });
        })
      )
    );
  }

  function KeyStatusPanel(_ref8) {
    var keys = _ref8.keys, providerStatus = _ref8.providerStatus;
    if (!keys && !providerStatus) return null;

    // Build provider status map
    var statusByProvider = {};
    var hasLiveData = false;
    if (providerStatus && providerStatus.providers) {
      hasLiveData = true;
      providerStatus.providers.forEach(function (p) {
        statusByProvider[p.id] = p;
      });
    }

    var envKeys = (keys && keys.env_vars_found) || [];
    var keyIntro = envKeys.length > 0
      ? "Detected " + envKeys.length + " API key" + (envKeys.length === 1 ? "" : "s") + ": " + envKeys.join(", ")
      : "No API keys detected. Add keys to ~/.hermes/.env for deeper provider probing.";

    return e(Card, { className: "wf-key-card" },
      e(CardHeader, null,
        e(CardTitle, { size: "sm" }, "API Key Status")
      ),
      e(CardContent, null,
        e("p", { className: "wf-key-intro" }, keyIntro),
        hasLiveData ? e("div", { className: "wf-provider-grid" },
          Object.keys(PROVIDER_FREE_TYPES).map(function (pid) {
            var ps = statusByProvider[pid];
            var name = PROVIDER_DISPLAY[pid] || pid;
            var freeType = PROVIDER_FREE_TYPES[pid] || "unknown";
            var keyFound = ps && ps.key_present;
            var modelCount = ps ? (ps.model_count_live || ps.model_count_curated || 0) : 0;
            return e("div", {
              key: pid,
              className: classNames("wf-provider-cell", keyFound ? "wf-cell-key" : "wf-cell-nokey"),
            },
              e("span", { className: "wf-provider-cell-name" }, name),
              e("span", { className: "wf-provider-cell-type" },
                keyFound ? e(Badge, { tone: "success", size: "sm" }, "Key OK") : e(Badge, { tone: "outline", size: "sm" }, "No Key")
              ),
              e("span", { className: "wf-provider-cell-models" }, modelCount + " free")
            );
          })
        ) : null
      )
    );
  }

  function BySourceBreakdown(_ref9) {
    var bySource = _ref9.bySource;
    if (!bySource) return null;
    var labels = { live: "OpenRouter (live)", live_hf: "HuggingFace (live)", live_ollama: "Ollama (live)", curated: "Curated fallback" };
    return e(Card, { className: "wf-source-card" },
      e(CardHeader, null,
        e(CardTitle, { size: "sm" }, "Data Sources")
      ),
      e(CardContent, null,
        e("div", { className: "wf-source-list" },
          Object.keys(bySource).map(function (key) {
            return e("div", { key: key, className: "wf-source-item" },
              e("span", { className: "wf-source-label" }, labels[key] || key),
              e(Badge, { tone: sourceTone(key), size: "sm" }, bySource[key] + " models")
            );
          })
        )
      )
    );
  }

  function FreeTierBreakdown(_ref10) {
    var byFreeType = _ref10.byFreeType;
    if (!byFreeType) return null;
    var labels = {
      public: "Public endpoint (no key)", community: "Community inference",
      key_free_quota: "Free tier via API key", oauth_free: "Free via OAuth login",
      no_free_tier: "Paid only (no free tier)", unknown: "Free tier uncertain", local: "Local / self-hosted"
    };
    return e(Card, { className: "wf-ft-card" },
      e(CardHeader, null,
        e(CardTitle, { size: "sm" }, "Free Tier Breakdown")
      ),
      e(CardContent, null,
        e("div", { className: "wf-source-list" },
          Object.keys(byFreeType).map(function (key) {
            return e("div", { key: key, className: "wf-source-item" },
              e("span", { className: "wf-source-label" }, labels[key] || key),
              e(Badge, { tone: freeTone(key), size: "sm" }, byFreeType[key] + " models")
            );
          })
        )
      )
    );
  }

  /* ─── Main Page Component ──────────────────────────────*/

  function WhatsFreePage() {
    var _useState2 = useState(null), data = _useState2[0], setData = _useState2[1];
    var _useState3 = useState(true), loading = _useState3[0], setLoading = _useState3[1];
    var _useState4 = useState(null), error = _useState4[0], setError = _useState4[1];
    var _useState5 = useState(false), keyStatus = _useState5[0], setKeyStatus = _useState5[1];
    var _useState6 = useState(null), providerStatus = _useState6[0], setProviderStatus = _useState6[1];

    function loadData(forceRefresh) {
      setLoading(true);
      setError(null);

      // Fetch from public endpoints — each isolated so one failure
      // doesn't crash the rest
      var orPromise = fetchOpenRouter();
      var hfPromise = fetchHuggingFace();
      var ollamaPromise = fetchOllama();

      // Helper: call a promise, return [result, error]
      function safeFetch(p) {
        return p.then(function (r) { return { ok: true, data: r, error: null }; })
                .catch(function (e) { return { ok: false, data: [], error: e.message || String(e) }; });
      }

      Promise.all([safeFetch(orPromise), safeFetch(hfPromise), safeFetch(ollamaPromise)])
        .then(function (results) {
          var orResult = results[0];
          var hfResult = results[1];
          var ollamaResult = results[2];

          var orModels = orResult.data;
          var hfModels = hfResult.data;
          var ollamaModels = ollamaResult.data;

          // Collect errors
          var fetchErrors = [];
          if (!orResult.ok) fetchErrors.push("OpenRouter: " + orResult.error);
          if (!hfResult.ok) fetchErrors.push("HuggingFace: " + hfResult.error);
          if (!ollamaResult.ok) fetchErrors.push("Ollama: " + ollamaResult.error);

          var curated = CURATED_FREE.map(function (m) {
            return {
              id: m.id,
              provider: m.provider,
              provider_display: PROVIDER_DISPLAY[m.provider] || m.provider,
              free_tier_type: m.free_type || "unknown",
              context: m.context || null,
              _source: "curated",
            };
          });

          var aggregated = aggregateModels(orModels, hfModels, ollamaModels, curated);
          aggregated.fetch_errors = fetchErrors;
          setData(aggregated);
          setLoading(false);
        });

      // Try backend for key status (best-effort, may 401)
      fetchBackendKeyStatus().then(function (ks) { setKeyStatus(ks); });
      fetchBackendProviderStatus().then(function (ps) { setProviderStatus(ps); });
    }

    function handleRefresh() {
      setData(null);
      loadData(true);
    }

    useEffect(function () { loadData(false); }, []);

    // Group models by provider_display
    var grouped = useMemo(function () {
      if (!data || !data.models) return {};
      var groups = {};
      data.models.forEach(function (m) {
        var p = m.provider_display || "Other";
        if (!groups[p]) groups[p] = [];
        groups[p].push(m);
      });
      // Sort: live sources first, then alpha
      var sorted = {};
      var liveKeys = [];
      var curatedKeys = [];
      Object.keys(groups).forEach(function (k) {
        var hasLive = groups[k].some(function (m) { return m._source && m._source.indexOf("live") === 0; });
        if (hasLive) liveKeys.push(k);
        else curatedKeys.push(k);
      });
      liveKeys.sort();
      curatedKeys.sort();
      liveKeys.concat(curatedKeys).forEach(function (k) { sorted[k] = groups[k]; });
      return sorted;
    }, [data]);

    return e("div", { className: "wf-page" },

      // Header
      e("div", { className: "wf-header" },
        e("div", { className: "wf-header-text" },
          e("h1", { className: "wf-title" }, "Free Models"),
          e("p", { className: "wf-subtitle" },
            "Live free LLM model availability across Hermes-supported providers. ",
            "Fetched directly from public APIs."
          )
        ),
        e("div", { className: "wf-header-actions" },
          e(Button, {
            onClick: handleRefresh,
            disabled: loading,
            variant: "outline",
            size: "sm",
          }, loading ? "Loading\u2026" : "Refresh Now")
        )
      ),

      // Loading indicator
      loading && !data ? e(LoadingState, null) : null,

      // Error
      error ? e(ErrorState, { message: error, onRetry: function () { loadData(false); } }) : null,

      // Summary cards
      data && data.summary ? e(SummaryCards, { summary: data.summary }) : null,

      // Key status + provider grid (from backend, may be null if 401)
      keyStatus || providerStatus
        ? e(KeyStatusPanel, { keys: keyStatus, providerStatus: providerStatus })
        : null,

      // Breakdown cards
      data && data.summary
        ? e("div", { className: "wf-breakdown-row" },
            e(BySourceBreakdown, { bySource: data.summary.by_source }),
            e(FreeTierBreakdown, { byFreeType: data.summary.by_free_type })
          )
        : null,

      // Upstream fetch warnings
      data && data.fetch_errors && data.fetch_errors.length > 0
        ? e(Card, { className: "wf-error-card" },
            e(CardContent, null,
              e("p", { className: "wf-error-title" }, "Upstream fetch notes"),
              data.fetch_errors.map(function (err, i) {
                return e("p", { key: i, className: "wf-error-detail" }, err);
              })
            )
          )
        : null,

      // Separator before model list
      data && Object.keys(grouped).length > 0 ? e(Separator, null) : null,

      // Provider groups
      Object.keys(grouped).length > 0
        ? e("div", { className: "wf-provider-list" },
            Object.keys(grouped).map(function (provider) {
              return e(ProviderGroup, { key: provider, provider: provider, models: grouped[provider] });
            })
          )
        : (loading ? null : null)
    );
  }

  // Register with the Hermes plugin SDK
  window.__HERMES_PLUGINS__.register("whatsfree", WhatsFreePage);
})();
