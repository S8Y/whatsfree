"""WhatsFree plugin package.

This plugin provides a dashboard tab showing currently available free
LLM API models across Hermes-supported providers. The dashboard backend
fetches model lists from public endpoints (no API key required) and
caches results.

The generic Hermes plugin loader imports enabled plugins from their
repository root, so expose a minimal no-op register() hook to keep
that loader quiet while the dashboard runtime mounts dashboard/
plugin_api.py separately.
"""

def register(ctx):
    """Register root-level Hermes extensions.

    WhatsFree currently provides only dashboard assets and API routes,
    so there are no root-level tools, commands, or hooks to register.
    """
    return None
