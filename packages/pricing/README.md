# `@pid/pricing`

Local token pricing catalog and session cost estimator (`ctx.pricing`). Subscribes to `llm/response` for live cost telemetry, resolves per-million-token prices from user provider overrides first and built-in model rates second, and computes exact session and aggregate usage costs without double-counting `reasoningTokens` (already included in `outputTokens`).
