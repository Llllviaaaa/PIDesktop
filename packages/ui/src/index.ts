/**
 * The `ui` service (ADR 0002, 0009): plugins ask the user to confirm, pick or
 * type something, or tell them something, without knowing who answers. A
 * transport (the RPC gateway's `ui/request`, P4) delivers each request; with
 * none attached, as in a headless run, questions resolve at once with no
 * answer and callers fall back to their safe default.
 */
import { Context, Service } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    ui: Ui;
  }
}

export type UiRequest =
  | { kind: "confirm"; title: string; message: string }
  | { kind: "select"; title: string; options: string[] }
  | { kind: "input"; title: string; placeholder?: string };

export type NotifyLevel = "info" | "warning" | "error";

export interface PendingUiRequest {
  requestId: string;
  sessionId?: string;
  request: UiRequest;
}

export interface UiTransport {
  /** Show a question; the answer comes back through `Ui.respond`. */
  request(pending: PendingUiRequest): void;
  /** The question no longer needs an answer (answered elsewhere, aborted, or the transport left). */
  cancel(requestId: string): void;
  notify(sessionId: string | undefined, message: string, level: NotifyLevel): void;
}

interface Waiting extends PendingUiRequest {
  resolve(value: unknown): void;
}

export class Ui extends Service {
  private transport: UiTransport | undefined;
  private readonly waiting = new Map<string, Waiting>();
  private nextId = 0;

  constructor(ctx: Context) {
    super(ctx, "ui");
    ctx.effect(() => () => this.cancelAll(), "ui: cancel pending requests");
  }

  /** Whether anyone can answer questions. */
  get available(): boolean {
    return this.transport !== undefined;
  }

  /** Deliver requests through `transport`. Returns the disposer, which cancels what is pending. */
  attach(transport: UiTransport): () => void {
    if (this.transport !== undefined) throw new Error("A UI transport is already attached");
    this.transport = transport;
    return () => {
      if (this.transport !== transport) return;
      this.cancelAll();
      this.transport = undefined;
    };
  }

  /** Ask, resolving to the answer, or undefined when nobody can answer or `signal` aborts. */
  ask(sessionId: string | undefined, request: UiRequest, signal?: AbortSignal): Promise<unknown> {
    const transport = this.transport;
    if (transport === undefined || signal?.aborted) return Promise.resolve(undefined);
    this.nextId += 1;
    const requestId = `ui-${this.nextId}`;
    return new Promise((resolve) => {
      const onAbort = () => this.settle(requestId, undefined, true);
      const entry: Waiting = {
        requestId,
        ...(sessionId === undefined ? {} : { sessionId }),
        request,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
      };
      this.waiting.set(requestId, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      transport.request({ requestId, ...(sessionId === undefined ? {} : { sessionId }), request });
    });
  }

  async confirm(sessionId: string | undefined, title: string, message: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.ask(sessionId, { kind: "confirm", title, message }, signal)) === true;
  }

  async select(sessionId: string | undefined, title: string, options: string[], signal?: AbortSignal): Promise<string | undefined> {
    const answer = await this.ask(sessionId, { kind: "select", title, options }, signal);
    return typeof answer === "string" && options.includes(answer) ? answer : undefined;
  }

  async input(sessionId: string | undefined, title: string, placeholder?: string, signal?: AbortSignal): Promise<string | undefined> {
    const answer = await this.ask(sessionId, { kind: "input", title, ...(placeholder === undefined ? {} : { placeholder }) }, signal);
    return typeof answer === "string" ? answer : undefined;
  }

  notify(sessionId: string | undefined, message: string, level: NotifyLevel = "info"): void {
    this.transport?.notify(sessionId, message, level);
  }

  /** Answer a pending request; false when it is unknown or already settled. */
  respond(requestId: string, value: unknown): boolean {
    return this.settle(requestId, value, false);
  }

  /** Questions still waiting, for a client that reconnects. */
  pending(): PendingUiRequest[] {
    return [...this.waiting.values()].map(({ requestId, sessionId, request }) => ({ requestId, ...(sessionId === undefined ? {} : { sessionId }), request }));
  }

  private settle(requestId: string, value: unknown, cancelled: boolean): boolean {
    const entry = this.waiting.get(requestId);
    if (entry === undefined) return false;
    this.waiting.delete(requestId);
    if (cancelled) this.transport?.cancel(requestId);
    entry.resolve(value);
    return true;
  }

  private cancelAll(): void {
    for (const requestId of [...this.waiting.keys()]) this.settle(requestId, undefined, true);
  }
}
