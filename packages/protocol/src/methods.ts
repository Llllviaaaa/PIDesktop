/**
 * Params and results of the methods the host answers (ADR 0002). Each one is
 * added here when its phase lands; the host checks params at runtime.
 */

export interface HostInfoResult {
  version: string;
  protocolVersion: string;
  startedAt: string;
}

/** A configured model provider, without its secret. */
export interface ProviderSummary {
  id: string;
  name: string;
  /** The adapter's wire protocol: `openai-compat` or `anthropic`. */
  api: string;
  baseUrl: string;
  /**
   * Where the key comes from, for display: "environment variable X", "secret
   * store", ... Not named like a key, so log redaction and secret scanning
   * leave the description alone.
   */
  keySource: string;
}

export interface ProviderListResult {
  providers: ProviderSummary[];
}

export interface ModelListParams {
  provider: string;
}

export interface ModelSummary {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
}

export interface ModelListResult {
  models: ModelSummary[];
}
