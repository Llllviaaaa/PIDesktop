import { errorFromResponse } from "./errors.ts";
import { parseSse, type SseEvent } from "./sse.ts";

/** POST JSON and stream the SSE answer; a non-2xx status throws a classified LlmError. */
export async function* postSse(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  provider: string,
): AsyncGenerator<SseEvent> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await errorFromResponse(response, provider);
  if (response.body === null) return;
  yield* parseSse(response.body as unknown as AsyncIterable<Uint8Array>);
}

/** GET a JSON document; a non-2xx status throws a classified LlmError. */
export async function getJson(url: string, headers: Record<string, string>, provider: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json", ...headers }, signal });
  if (!response.ok) throw await errorFromResponse(response, provider);
  return response.json();
}

/** Join a base URL and a path without doubling or dropping the slash. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
