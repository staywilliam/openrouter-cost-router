---
name: openrouter-cost-router
description: Launch or troubleshoot the bundled OpenRouter gateway for Codex when the user wants to select an inference supplier using recent input, output, and prompt-cache token usage.
---

# OpenRouter Cost Router

Resolve [cli.mjs](../../cli.mjs) relative to this installed skill. The launcher starts the gateway on loopback and launches a new Codex process with a temporary custom provider. In an interactive terminal, use `node /absolute/path/to/cli.mjs codex` and optionally pass a full OpenRouter model ID with `-m`. The gateway reads `OPENROUTER_API_KEY` from the environment.

For a separately running Codex client, start `node /absolute/path/to/cli.mjs serve 17863`. Set the custom provider's `base_url` to `http://127.0.0.1:17863/v1` and its `model_catalog_url` to `http://127.0.0.1:17863/v1/models`. Use `wire_api = "responses"`, `env_key = "OPENROUTER_API_KEY"`, and `supports_websockets = false`.

- Use `GET /health` to confirm the server is running. Send the configured Bearer key to `GET /status` to see the last selected endpoint, estimated cost, usage sample count, and recorded token counts. Treat `/status` as a diagnostic for the latest request through that gateway.
- Set `OPENROUTER_ROUTER_MAX_CACHE_READ` in USD per million cached reads when the user requests a ceiling. Set `OPENROUTER_ROUTER_IGNORE` to a comma-separated list when the user wants to exclude providers. Discuss availability if the user asks to increase `OPENROUTER_ROUTER_FALLBACK_RATIO` above its default of 1.
- Use a concrete OpenRouter model ID for pricing. If a preset, model router, or unknown continuation is rejected, start a new session with its underlying model ID. Review the gateway decision and the OpenRouter Logs entry when diagnosing an unexpected bill.
