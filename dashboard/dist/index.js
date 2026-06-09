/* WhatsFree dashboard plugin -- enhanced frontend (IIFE) */
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const React = SDK.React;
  const hooks = SDK.hooks;
  const components = SDK.components;
  const Card = components.Card;
  const CardHeader = components.CardHeader;
  const CardTitle = components.CardTitle;
  const CardContent = components.CardContent;
  const Badge = components.Badge;
  const Button = components.Button;
  const Separator = components.Separator;
  const useState = hooks.useState;
  const useEffect = hooks.useEffect;
  const useMemo = hooks.useMemo;
  const e = React.createElement;

  const API_BASE = "/api/plugins/whatsfree";

  function fmtTime(value) {
    if (!value) return "\u2014";
    try {
      var date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "medium",
      });
    } catch {
      return String(value);
    }
  }

  function fmtCtx(tokens) {
    if (!tokens || tokens === 0) return "\u2014";
    var n = Number(tokens);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(0) + "K";
    return String(n);
  }

  function classNames() {
    var result = [];
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i]) result.push(arguments[i]);
    }
    return result.join(" ");
  }

  function ProviderIcon(_ref) {
    var provider = _ref.provider;
    var icons = {
      "OpenRouter (Free)": "\u26A1",
      DeepSeek: "\u00D6",
      "Google Gemini": "\u2601",
      "HuggingFace Community": "\u00D7A4",
      "Nous Research": "\u2728",
      "OpenCode Zen": "\u26A1",
      "OpenCode Go": "\u26A1",
      "OpenAI Codex": "\u25B6",
      "GitHub Copilot": "\uD83D\uDC4A",
      "Ollama Cloud": "\u2601",
      MiniMax: "\u25A8",
      "Qwen Portal": "\u8D2D",
      "NVIDIA NIM": "\u25B3",
      "Alibaba DashScope": "\u963F",
      "Kimi (Moonshot AI)": "\u6708",
      "Z.AI (GLM / Zhipu)": "\u667A",
      "xAI (Grok)": "\uD7A4",
      "Custom / Local": "\uD83D\uDCBB",
    };
    return e("span", { className: "wf-provider-icon" }, icons[provider] || "\uD83E\uDE84");
  }

  function SourceBadge(_ref2) {
    var source = _ref2.source;
    var config = {
      live: { label: "Live", tone: "success" },
      live_hf: { label: "Live (HF)", tone: "success" },
      live_ollama: { label: "Live (Ollama)", tone: "success" },
      probed: { label: "Probed", tone: "info" },
      curated: { label: "Curated", tone: "secondary" },
    };
    var info = config[source] || { label: source, tone: "outline" };
    return e(Badge, { tone: info.tone, size: "sm" }, info.label);
  }

  function FreeTierBadge(_ref3) {
    var type = _ref3.type;
    var labels = {
      public: { label: "Public", tone: "success" },
      community: { label: "Community", tone: "info" },
      key_free_quota: { label: "Free w/ Key", tone: "warning" },
      oauth_free: { label: "Free (OAuth)", tone: "info" },
      no_free_tier: { label: "Paid", tone: "critical" },
      unknown: { label: "Unknown", tone: "outline" },
      local: { label: "Local", tone: "secondary" },
    };
    var info = labels[type] || { label: type, tone: "outline" };
    return e(Badge, { tone: info.tone, size: "sm" }, info.label);
  }

  function LoadingState() {
    return e("div", { className: "wf-loading" },
      e("div", { className: "wf-spinner" }),
      e("span", null, "Fetching free models\u2026")
    );
  }

  function ErrorState(_ref4) {
    var message = _ref4.message, onRetry = _ref4.onRetry;
    return e(Card, { className: "wf-error-card" },
      e(CardContent, null,
        e("div", { className: "wf-error-content" },
          e("div", { className: "wf-error-icon" }, "\u26A0"),
          e("div", null,
            e("p", { className: "wf-error-title" }, "Failed to load models"),
            e("p", { className: "wf-error-detail" }, message),
            onRetry ? e(Button, { onClick: onRetry, size: "sm", variant: "outline" }, "Retry") : null
          )
        )
      )
    );
  }

  function ModelCard(_ref5) {
    var model = _ref5.model;
    return e(Card, { className: "wf-model-card" },
      e(CardHeader, { className: "wf-model-header" },
        e("div", { className: "wf-model-title-row" },
          e("div", { className: "wf-model-info" },
            e("div", { className: "wf-model-name" },
              e(ProviderIcon, { provider: model.provider_display }),
              e("span", null, model.name || model.id)
            ),
            e("div", { className: "wf-model-meta" },
              e("span", { className: "wf-model-provider" }, model.provider_display),
              model.context_length ? e(React.Fragment, null,
                e("span", { className: "wf-model-sep" }, "\u00B7"),
                e("span", { className: "wf-model-ctx" }, fmtCtx(model.context_length) + " ctx")
              ) : null,
              model.key_present === true
                ? e(React.Fragment, null,
                    e("span", { className: "wf-model-sep" }, "\u00B7"),
                    e(Badge, { tone: "success", size: "sm" }, "Key OK")
                  )
                : null,
              model.requires_key && !model.key_present
                ? e(React.Fragment, null,
                    e("span", { className: "wf-model-sep" }, "\u00B7"),
                    e(Badge, { tone: "warning", size: "sm" }, "No Key")
                  )
                : null,
            )
          ),
          e("div", { className: "wf-model-badges" },
            e(SourceBadge, { source: model._source }),
            e(FreeTierBadge, { type: model.free_tier_type })
          )
        ),
        model.description
          ? e("p", { className: "wf-model-desc" }, model.description)
          : null,
        e("div", { className: "wf-model-footer" },
          e("code", { className: "wf-model-id" }, model.id),
          model.auth_required && model.auth_required !== "None"
            ? e("span", { className: "wf-model-auth" }, model.auth_required)
            : null
        )
      )
    );
  }

  function ProviderGroup(_ref6) {
    var provider = _ref6.provider, models = _ref6.models;
    var _useState = useState(true), collapsed = _useState[0], setCollapsed = _useState[1];
    return e("div", { className: "wf-provider-group" },
      e("button", {
        className: "wf-provider-toggle",
        onClick: function () { setCollapsed(!collapsed); },
      },
        e("span", { className: classNames("wf-chevron", collapsed ? "wf-chevron-collapsed" : "") }, "\u25BC"),
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

  function SummaryCards(_ref7) {
    var summary = _ref7.summary;
    if (!summary) return null;
    var items = [
      { label: "Total Free Models", value: String(summary.total || 0) },
      { label: "Providers", value: String(summary.providers_count || 0) },
      { label: "No Key Needed", value: String(summary.no_key_needed || 0) },
      { label: "With Key Present", value: String(summary.key_present || 0) },
    ];
    return e("div", { className: "wf-summary-grid" },
      items.map(function (item) {
        return e(Card, { key: item.label, className: "wf-summary-card" },
          e(CardContent, { className: "wf-summary-content" },
            e("div", { className: "wf-summary-label" }, item.label),
            e("div", { className: "wf-summary-value" }, item.value)
          )
        );
      })
    );
  }

  function KeyStatus(_ref8) {
    var envKeysFound = _ref8.envKeysFound, providerStatus = _ref8.providerStatus;
    // Count providers by key presence
    var withKeys = 0, noKeys = 0, oauth = 0, freeProviders = 0;
    if (providerStatus) {
      providerStatus.forEach(function (p) {
        if (p.public_listing) freeProviders++;
        else if (p.key_present) withKeys++;
        else if (p.oauth) oauth++;
        else noKeys++;
      });
    }

    var total = providerStatus ? providerStatus.length : 0;

    return e("div", { className: "wf-key-section" },
      e(Card, { className: "wf-key-card" },
        e(CardContent, null,
          envKeysFound && envKeysFound.length > 0
            ? e("p", { className: "wf-key-found" },
                "Configured keys: ",
                e("code", { className: "wf-key-list" }, envKeysFound.join(", "))
              )
            : e("p", { className: "wf-key-hint" },
                "No Hermes API keys detected. Models marked \"Free w/ Key\" or ",
                "\"Free (OAuth)\" need a configured key. ",
                "Run \u2018hermes setup\u2019 or visit provider signup pages."
              )
        )
      ),
      e("div", { className: "wf-provider-stats" },
        e("span", { className: "wf-ps-label" }, "Provider status: "),
        e(Badge, { tone: "info", size: "sm" }, withKeys + " key-configured"),
        e(Badge, { tone: "warning", size: "sm" }, noKeys + " key-required"),
        e(Badge, { tone: "secondary", size: "sm" }, oauth + " OAuth"),
        e(Badge, { tone: "success", size: "sm" }, freeProviders + " public"),
        e("span", { className: "wf-ps-total" }, "/ " + total + " total")
      )
    );
  }

  function ProviderGrid(_ref9) {
    var providerStatus = _ref9.providerStatus;
    if (!providerStatus || providerStatus.length === 0) return null;
    return e(Card, { className: "wf-provider-status-card" },
      e(CardHeader, null,
        e(CardTitle, { size: "sm" }, "Provider Key Status")
      ),
      e(CardContent, null,
        e("div", { className: "wf-pgrid" },
          providerStatus.map(function (p) {
            var icon = p.key_present ? "\u2705" : p.public_listing ? "\uD83D\uDD0D" : p.oauth ? "\uD83D\uDD11" : "\u26A0";
            var statusClass = p.key_present ? "wf-pok" : p.public_listing ? "wf-ppub" : p.oauth ? "wf-poath" : "wf-pnok";
            return e("div", { key: p.id, className: classNames("wf-pitem", statusClass) },
              e("span", { className: "wf-picon" }, icon),
              e("span", { className: "wf-pname" }, p.name),
              p.model_count_live !== null
                ? e("span", { className: "wf-pcount" }, p.model_count_live + " probed")
                : null,
              p.error
                ? e("span", { className: "wf-perror" }, p.error.substring(0, 20))
                : null,
              e("span", { className: "wf-ptype" }, p.free_tier_type)
            );
          })
        )
      )
    );
  }

  function BySourceBreakdown(_ref10) {
    var bySource = _ref10.bySource;
    if (!bySource) return null;
    var labels = {
      live: "OpenRouter (free)",
      live_hf: "HuggingFace (free)",
      live_ollama: "Ollama Cloud (free)",
      probed: "Probed via API key",
      curated: "Curated (known free tiers)"
    };
    return e(Card, { className: "wf-source-card" },
      e(CardHeader, null,
        e(CardTitle, { size: "sm" }, "Data Sources")
      ),
      e(CardContent, null,
        e("div", { className: "wf-source-list" },
          Object.keys(bySource).map(function (key) {
            return e("div", { key: key, className: "wf-source-item" },
              e("span", { className: "wf-source-label" }, labels[key] || key),
              e(Badge, { tone: "outline", size: "sm" }, bySource[key] + " models")
            );
          })
        )
      )
    );
  }

  function FreeTierBreakdown(_ref11) {
    var byFreeType = _ref11.byFreeType;
    if (!byFreeType) return null;
    var labels = {
      public: "Public endpoint (no key)",
      community: "Community inference",
      key_free_quota: "Free tier via API key",
      oauth_free: "Free via OAuth login",
      no_free_tier: "Paid only (no free tier)",
      unknown: "Free tier uncertain",
      local: "Local / self-hosted"
    };
    var tones = {
      public: "success", community: "info", key_free_quota: "warning",
      oauth_free: "info", no_free_tier: "critical", unknown: "outline", local: "secondary"
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
              e(Badge, { tone: tones[key] || "outline", size: "sm" }, byFreeType[key] + " models")
            );
          })
        )
      )
    );
  }

  function WhatsFreePage() {
    var _useState2 = useState(null), data = _useState2[0], setData = _useState2[1];
    var _useState3 = useState(true), loading = _useState3[0], setLoading = _useState3[1];
    var _useState4 = useState(null), error = _useState4[0], setError = _useState4[1];
    var _useState5 = useState(false), refreshing = _useState5[0], setRefreshing = _useState5[1];

    function loadData(forceRefresh) {
      setLoading(true);
      setError(null);
      var url = API_BASE + "/models" + (forceRefresh ? "?refresh=true" : "");
      fetch(url)
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status + ": " + r.statusText);
          return r.json();
        })
        .then(function (result) {
          setData(result);
          setLoading(false);
        })
        .catch(function (err) {
          setError(err.message || "Unknown error");
          setLoading(false);
        });
    }

    function handleRefresh() {
      setRefreshing(true);
      fetch(API_BASE + "/refresh", { method: "POST" })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (result) {
          setData(result);
          setRefreshing(false);
        })
        .catch(function (err) {
          setError(err.message || "Refresh failed");
          setRefreshing(false);
        });
    }

    useEffect(function () {
      loadData(false);
    }, []);

    // Group models by provider_display
    var grouped = useMemo(function () {
      if (!data || !data.models) return {};
      var groups = {};
      data.models.forEach(function (m) {
        var p = m.provider_display || "Other";
        if (!groups[p]) groups[p] = [];
        groups[p].push(m);
      });
      // Sort groups: live sources first, then by name
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
      liveKeys.concat(curatedKeys).forEach(function (k) {
        sorted[k] = groups[k];
      });
      return sorted;
    }, [data]);

    return e("div", { className: "wf-page" },
      // Header
      e("div", { className: "wf-header" },
        e("div", { className: "wf-header-text" },
          e("h1", { className: "wf-title" }, "Free Models"),
          e("p", { className: "wf-subtitle" },
            "Live free LLM model availability across Hermes-supported providers. ",
            e("strong", null, "185 models"), " available without any API key. ",
            "Keys are auto-detected from env, .env, and config.yaml."
          )
        ),
        e("div", { className: "wf-header-actions" },
          e(Button, {
            onClick: handleRefresh,
            disabled: refreshing,
            variant: "outline",
            size: "sm",
          },
            refreshing ? "Refreshing\u2026" : "Refresh Now"
          )
        )
      ),

      // Last updated
      data && data.cached_at_iso
        ? e("p", { className: "wf-timestamp" },
            "Last updated: ", fmtTime(data.cached_at_iso)
          )
        : null,

      // Loading
      loading && !data ? e(LoadingState, null) : null,

      // Error
      error ? e(ErrorState, { message: error, onRetry: function () { loadData(false); } }) : null,

      // Summary cards
      data && data.summary ? e(SummaryCards, { summary: data.summary }) : null,

      // Key status + provider grid
      data
        ? e(KeyStatus, {
            envKeysFound: data.detected_env_vars,
            providerStatus: data.provider_status,
          })
        : null,

      // Breakdown cards
      data && data.summary
        ? e("div", { className: "wf-breakdown-row" },
            e(BySourceBreakdown, { bySource: data.summary.by_source }),
            e(FreeTierBreakdown, { byFreeType: data.summary.by_free_type })
          )
        : null,

      // Provider key status grid (compact)
      data && data.provider_status
        ? e(ProviderGrid, { providerStatus: data.provider_status })
        : null,

      // Errors from upstream
      data && data.errors
        ? (function () {
            var errs = [];
            if (data.errors.openrouter) errs.push("OpenRouter: " + data.errors.openrouter);
            if (data.errors.huggingface) errs.push("HuggingFace: " + data.errors.huggingface);
            if (data.errors.ollama) errs.push("Ollama: " + data.errors.ollama);
            if (data.errors.probes && data.errors.probes.length > 0)
              errs = errs.concat(data.errors.probes);
            if (errs.length === 0) return null;
            return e(Card, { className: "wf-error-card" },
              e(CardContent, null,
                e("p", { className: "wf-error-title" }, "Upstream fetch errors"),
                errs.map(function (err, i) {
                  return e("p", { key: i, className: "wf-error-detail" }, err);
                })
              )
            );
          })()
        : null,

      // Provider groups
      Object.keys(grouped).length > 0
        ? e("div", { className: "wf-provider-list" },
            Object.keys(grouped).map(function (provider) {
              return e(ProviderGroup, {
                key: provider,
                provider: provider,
                models: grouped[provider],
              });
            })
          )
        : (!loading ? null : null)
    );
  }

  // Register with the Hermes plugin SDK
  window.__HERMES_PLUGINS__.register("whatsfree", WhatsFreePage);
})();
