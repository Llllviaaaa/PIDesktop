import {
  resolveWorkspaceBrowserAddress,
  webAccessKindForTool,
  webSearchQuery,
  webSearchSources,
} from "../src/lib/webAccess.ts";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

assert(webAccessKindForTool("web_search") === "web-search", "web search was not classified");
assert(webAccessKindForTool("grok_search") === "web-search", "Grok search was not classified");
assert(webAccessKindForTool("mcp__research__web_search") === "web-search", "MCP web search was not classified");
assert(webAccessKindForTool("browser") === "agent-browser", "agent browser was not classified");
assert(webAccessKindForTool("search") === null, "generic file search was misclassified as web search");
assert(webAccessKindForTool("read") === null, "non-web tool was misclassified");
assert(webSearchQuery({ query: "Pi Desktop" }) === "Pi Desktop", "query was not extracted");
assert(
  webSearchQuery({ search_query: [{ q: "Codex search UI" }] }) === "Codex search UI",
  "nested search query was not extracted",
);
const sources = webSearchSources({
  citations: [
    { title: "OpenAI Docs", url: "https://developers.openai.com/codex" },
    { title: "Duplicate", url: "https://developers.openai.com/codex" },
  ],
});
assert(sources.length === 1 && sources[0].title === "OpenAI Docs", "structured sources were not deduplicated");
const fallbackSources = webSearchSources(undefined, "Source: https://example.com/search?q=codex");
assert(fallbackSources[0]?.url === "https://example.com/search?q=codex", "result URL fallback failed");
assert(resolveWorkspaceBrowserAddress("https://example.com") === "https://example.com", "URL changed");
assert(resolveWorkspaceBrowserAddress("localhost:1420") === "http://localhost:1420", "localhost protocol missing");
assert(
  resolveWorkspaceBrowserAddress("pi desktop architecture") === "",
  "browser address text should not trigger a search-engine navigation",
);

console.log("web-access: search presentation and browser boundaries passed");
