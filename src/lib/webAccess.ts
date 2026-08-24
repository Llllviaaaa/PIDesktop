export type WebAccessKind = "web-search" | "agent-browser";

export const WEB_ACCESS_LABELS: Record<WebAccessKind, string> = {
  "web-search": "网页搜索",
  "agent-browser": "Agent 浏览器",
};

export interface WebSearchSource {
  title: string;
  url: string;
}

const WEB_SEARCH_TOOL_NAMES = new Set([
  "brave_search",
  "exa_search",
  "grok_search",
  "perplexity_search",
  "search_web",
  "tavily_search",
  "web__run",
  "web_run",
  "web_search",
]);

function normalizedToolName(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[.\-\s]+/g, "_");
}

export function isWebSearchTool(toolName: string): boolean {
  const name = normalizedToolName(toolName);
  return WEB_SEARCH_TOOL_NAMES.has(name)
    || name.includes("web_search")
    || name.includes("search_web");
}

export function webAccessKindForTool(toolName: string): WebAccessKind | null {
  const name = normalizedToolName(toolName);
  if (isWebSearchTool(name) || name.includes("web_fetch") || name.includes("fetch_url")) {
    return "web-search";
  }
  if (name === "browser") {
    return "agent-browser";
  }
  return null;
}

function firstNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (typeof item === "string" && item.trim()) return item.trim();
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const nested = firstNonEmptyString(record.q ?? record.query ?? record.search_query);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function webSearchQuery(args: Record<string, unknown>): string | undefined {
  for (const value of [args.query, args.q, args.search_query, args.searchQuery, args.queries, args.search]) {
    const query = firstNonEmptyString(value);
    if (query) return query;
  }
  return undefined;
}

function sourceTitle(value: unknown, url: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function collectStructuredSources(value: unknown, output: WebSearchSource[]): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredSources(item, output);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (/^https?:\/\//i.test(url)) {
    output.push({ title: sourceTitle(record.title ?? record.name, url), url });
  }
  for (const key of ["citations", "sources", "url_citation", "action"]) {
    collectStructuredSources(record[key], output);
  }
}

function urlsFromResult(result: string): WebSearchSource[] {
  const matches = result.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return matches.map((candidate) => {
    const url = candidate.replace(/[),.;:\]}]+$/, "");
    return { title: sourceTitle(undefined, url), url };
  });
}

export function webSearchSources(
  details: Record<string, unknown> | undefined,
  result = "",
  limit = 8,
): WebSearchSource[] {
  const candidates: WebSearchSource[] = [];
  collectStructuredSources(details, candidates);
  if (candidates.length === 0 && result) candidates.push(...urlsFromResult(result));

  const seen = new Set<string>();
  const sources: WebSearchSource[] = [];
  for (const source of candidates) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

export function resolveWorkspaceBrowserAddress(value: string): string {
  const input = value.trim();
  if (!input) return "";
  if (/^https?:\/\//i.test(input)) return input;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(input)) return `http://${input}`;
  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(input)) return `https://${input}`;
  return "";
}
