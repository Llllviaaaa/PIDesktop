import { errorFromResponse, LlmError } from "./errors.ts";
import { parseSse, type SseEvent } from "./sse.ts";

/** Maximum silence while waiting for response headers or the next SSE byte chunk before resetting the connection. */
export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 90_000;

async function* withIdleTimeout(
  body: AsyncIterable<Uint8Array>,
  idleTimeoutMs: number,
  onIdleTimeout: () => void,
): AsyncGenerator<Uint8Array> {
  if (idleTimeoutMs <= 0 || !Number.isFinite(idleTimeoutMs)) {
    yield* body;
    return;
  }
  const iterator = body[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              onIdleTimeout();
              reject(new Error(`SSE stream timed out after ${Math.round(idleTimeoutMs / 1000)}s of inactivity`));
            }, idleTimeoutMs);
          }),
        ]);
        if (next.done) return;
        yield next.value;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
}

/** POST JSON and stream the SSE answer; a non-2xx status throws a classified LlmError. */
export async function* postSse(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  provider: string,
  idleTimeoutMs = DEFAULT_SSE_IDLE_TIMEOUT_MS,
): AsyncGenerator<SseEvent> {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", onParentAbort, { once: true });

  let headersTimer: ReturnType<typeof setTimeout> | undefined;
  if (idleTimeoutMs > 0 && Number.isFinite(idleTimeoutMs)) {
    headersTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  }

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut && !signal.aborted) {
        throw new LlmError({
          kind: "network",
          message: `${provider} timed out after ${Math.round(idleTimeoutMs / 1000)}s waiting for response`,
          retryable: true,
        });
      }
      throw error;
    } finally {
      if (headersTimer !== undefined) clearTimeout(headersTimer);
    }

    if (!response.ok) throw await errorFromResponse(response, provider);
    if (response.body === null) return;

    const stream = withIdleTimeout(
      response.body as unknown as AsyncIterable<Uint8Array>,
      idleTimeoutMs,
      () => {
        timedOut = true;
        controller.abort();
      },
    );
    try {
      yield* parseSse(stream);
    } catch (error) {
      if (timedOut && !signal.aborted) {
        throw new LlmError({
          kind: "network",
          message: `${provider} SSE stream timed out after ${Math.round(idleTimeoutMs / 1000)}s of inactivity`,
          retryable: true,
        });
      }
      throw error;
    }
  } finally {
    signal.removeEventListener("abort", onParentAbort);
  }
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
