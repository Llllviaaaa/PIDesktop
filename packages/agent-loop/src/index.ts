/**
 * The agent loop (ADR 0008), the one place that drives a run:
 *
 *   before-start → [turn-start → model call → tools → turn-end]* → settled
 *
 * Each turn derives the context from the session log, streams one model call
 * (chunks go out as `session/delta`), appends the assistant message, then runs
 * the tools it asked for in parallel and appends their results in call order.
 * Steering messages are delivered after a turn's tools; follow-ups once the
 * model would otherwise stop. A context-length error with no output compacts
 * the whole log once and retries.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import {
  AgentBusyError,
  NoModelError,
  type AgentDelta,
  type AgentStatus,
  type Agents,
  type RunOutcome,
} from "@pid/agent";
import { BlockAssembler, type LlmRequest, type StreamChunk, type ToolCallBlock, type UserContent } from "@pid/llm";
import { compactionPoint, deriveState, type EventOf, type ModelRef, type Session } from "@pid/session";
import "@pid/system-prompt";
import "@pid/tools";

export interface AgentLoopConfig {
  /** Model calls per run before it stops with `max-turns`. */
  maxTurns?: number;
  /**
   * Compact before a turn once the previous call used more tokens than this
   * (input, cached input and output together). Off by default.
   */
  compactAboveTokens?: number;
  /** Output budget of the compaction summary call. */
  summaryMaxTokens?: number;
}

export const COMPACTION_SYSTEM = `You summarize a conversation between a user and a coding agent so the agent can continue the work with only your summary as context.`;

export const COMPACTION_REQUEST = `Summarize the conversation above for the agent that will continue it. Include:
- the user's goals and requests, including the current one, in their own words where it matters;
- decisions made and constraints given;
- files read or changed and what was learned about them;
- commands run and their important results;
- what is done, what is in progress and what remains.
Be specific (paths, names, values) and concise. Reply with the summary only.`;

interface Run {
  controller: AbortController;
  done: Promise<void>;
  steer: UserContent[][];
  followUp: UserContent[][];
  streaming: StreamChunk[];
  runningTools: Map<string, string>;
}

const IDLE_QUEUE = { steer: 0, followUp: 0 };

function totalTokens(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export class AgentLoop extends Service implements Agents {
  static inject = ["llm", "sessions", "tools", "systemPrompt"];

  private readonly runs = new Map<string, Run>();
  private readonly maxTurns: number;

  constructor(ctx: Context, private readonly config: AgentLoopConfig = {}) {
    super(ctx, "agents");
    this.maxTurns = Math.max(1, config.maxTurns ?? 100);
    ctx.effect(() => () => {
      for (const run of this.runs.values()) run.controller.abort();
    }, "agent-loop: abort runs");
  }

  prompt(session: Session, content: UserContent[]): EventOf<"user"> {
    if (this.runs.has(session.id)) throw new AgentBusyError(session.id);
    if (session.state().model === undefined) throw new NoModelError(session.id);
    const event = session.append("user", { content });
    this.start(session);
    return event;
  }

  steer(session: Session, content: UserContent[]): EventOf<"user"> | undefined {
    const run = this.runs.get(session.id);
    if (run === undefined) return this.prompt(session, content);
    run.steer.push(content);
    this.queueDelta(session, run);
    return undefined;
  }

  followUp(session: Session, content: UserContent[]): EventOf<"user"> | undefined {
    const run = this.runs.get(session.id);
    if (run === undefined) return this.prompt(session, content);
    run.followUp.push(content);
    this.queueDelta(session, run);
    return undefined;
  }

  async abort(sessionId: string): Promise<void> {
    const run = this.runs.get(sessionId);
    if (run === undefined) return;
    run.steer.length = 0;
    run.followUp.length = 0;
    run.controller.abort();
    await run.done;
  }

  async compact(session: Session, signal?: AbortSignal): Promise<EventOf<"compaction"> | undefined> {
    if (this.runs.has(session.id)) throw new AgentBusyError(session.id);
    return this.summarize(session, signal ?? new AbortController().signal, true);
  }

  status(sessionId: string): AgentStatus {
    const run = this.runs.get(sessionId);
    if (run === undefined) return { running: false, streaming: [], runningTools: [], queue: { ...IDLE_QUEUE } };
    return {
      running: true,
      streaming: [...run.streaming],
      runningTools: [...run.runningTools].map(([callId, name]) => ({ callId, name })),
      queue: { steer: run.steer.length, followUp: run.followUp.length },
    };
  }

  async idle(sessionId: string): Promise<void> {
    await this.runs.get(sessionId)?.done;
  }

  private delta(session: Session, delta: AgentDelta): void {
    session.delta(delta);
  }

  private queueDelta(session: Session, run: Run): void {
    this.delta(session, { type: "queue", steer: run.steer.length, followUp: run.followUp.length });
  }

  private start(session: Session): void {
    const run: Run = {
      controller: new AbortController(),
      done: Promise.resolve(),
      steer: [],
      followUp: [],
      streaming: [],
      runningTools: new Map(),
    };
    this.runs.set(session.id, run);
    run.done = this.drive(session, run);
  }

  private async drive(session: Session, run: Run): Promise<void> {
    let outcome: RunOutcome = "error";
    this.delta(session, { type: "agent-start" });
    try {
      outcome = await this.loop(session, run);
    } catch (error) {
      this.ctx.logger("agent").error("run of %s failed: %s", session.id, error);
    }
    try {
      await session.flush();
    } catch (error) {
      this.ctx.logger("agent").error("flushing %s failed: %s", session.id, error);
    }
    this.runs.delete(session.id);
    this.delta(session, { type: "agent-end", outcome });
    await this.ctx.parallel("agent/settled", session, outcome);
  }

  private async loop(session: Session, run: Run): Promise<RunOutcome> {
    const { signal } = run.controller;
    await this.ctx.serial("agent/before-start", session);
    let compactedForLength = false;

    for (let turn = 1; ; turn += 1) {
      if (signal.aborted) return "aborted";
      if (turn > this.maxTurns) return "max-turns";
      await this.compactIfLarge(session, signal);

      this.delta(session, { type: "turn-start", turn });
      await this.ctx.serial("agent/turn-start", session, turn);

      const state = session.state();
      const model = state.model;
      if (model === undefined) throw new NoModelError(session.id);
      const response = await this.call(session, run, model, signal);

      if (response.reason === "error" && response.error?.kind === "context-length"
        && response.message.content.length === 0 && !compactedForLength) {
        // Nothing was said yet: shrink the context and try the same turn again.
        compactedForLength = true;
        if (await this.summarize(session, signal) !== undefined) {
          turn -= 1;
          continue;
        }
      }

      session.append("assistant", {
        content: response.message.content,
        model,
        usage: response.usage,
        stop: response.reason,
        ...(response.error === undefined ? {} : { error: response.error }),
      });

      const calls = response.message.content.filter((block): block is ToolCallBlock => block.type === "tool-call");
      if (response.reason === "aborted" || signal.aborted) {
        for (const call of calls) {
          session.append("tool-result", { callId: call.id, name: call.name, content: [{ type: "text", text: "Aborted before the tool ran." }], isError: true });
        }
        await this.ctx.serial("agent/turn-end", session, turn);
        return "aborted";
      }
      if (response.reason === "error") {
        await this.ctx.serial("agent/turn-end", session, turn);
        return "error";
      }

      if (calls.length > 0) await this.runTools(session, run, calls, signal);
      await this.ctx.serial("agent/turn-end", session, turn);
      if (signal.aborted) return "aborted";

      if (this.deliver(session, run, run.steer)) continue;
      if (calls.length > 0) continue;
      if (this.deliver(session, run, run.followUp)) continue;
      return "done";
    }
  }

  /** Append every queued message as a user event; whether there were any. */
  private deliver(session: Session, run: Run, queue: UserContent[][]): boolean {
    if (queue.length === 0) return false;
    for (const content of queue.splice(0)) session.append("user", { content });
    this.queueDelta(session, run);
    return true;
  }

  private async call(session: Session, run: Run, model: ModelRef, signal: AbortSignal) {
    const tools = this.ctx.tools.schemas();
    const system = await this.ctx.systemPrompt.build({ sessionId: session.id, cwd: session.header.cwd, model, tools });
    const state = session.state();
    const request: LlmRequest = {
      provider: model.provider,
      model: model.model,
      system,
      messages: state.messages,
      ...(tools.length === 0 ? {} : { tools }),
      ...(state.effort === undefined ? {} : { effort: state.effort }),
    };
    run.streaming = [];
    this.delta(session, { type: "llm-start", provider: model.provider, model: model.model });
    const assembler = new BlockAssembler();
    for await (const chunk of this.ctx.llm.stream(request, signal)) {
      assembler.push(chunk);
      run.streaming.push(chunk);
      this.delta(session, { type: "llm-chunk", chunk });
    }
    run.streaming = [];
    return assembler.result();
  }

  private async runTools(session: Session, run: Run, calls: ToolCallBlock[], signal: AbortSignal): Promise<void> {
    const env = { sessionId: session.id, cwd: session.header.cwd, signal };
    const pending = calls.map((call) => {
      session.append("tool-call", { callId: call.id, name: call.name, args: call.arguments });
      run.runningTools.set(call.id, call.name);
      this.delta(session, { type: "tool-start", callId: call.id, name: call.name });
      return this.ctx.tools.execute({ id: call.id, name: call.name, args: { ...call.arguments } }, env);
    });
    // Parallel execution, results appended in call order for a deterministic log.
    for (const [index, call] of calls.entries()) {
      const output = await pending[index];
      if (output === undefined) continue;
      session.append("tool-result", { callId: call.id, name: call.name, content: output.content, isError: output.isError === true });
      run.runningTools.delete(call.id);
      this.delta(session, { type: "tool-end", callId: call.id, isError: output.isError === true });
    }
  }

  private async compactIfLarge(session: Session, signal: AbortSignal): Promise<void> {
    const limit = this.config.compactAboveTokens;
    if (limit === undefined) return;
    const state = session.state();
    const last = session.events.findLast((event) => event.type === "assistant");
    if (last?.type !== "assistant" || totalTokens(last.data.usage) <= limit) return;
    if (state.compactedThrough !== undefined && state.compactedThrough > last.seq) return;
    await this.summarize(session, signal);
  }

  /**
   * Summarize the log and append a compaction; undefined when it failed.
   * Mid-run the latest turn is what grew, so it is summarized too; on request
   * the latest turn stays verbatim.
   */
  private async summarize(session: Session, signal: AbortSignal, keepLatestTurn = false): Promise<EventOf<"compaction"> | undefined> {
    const model = session.state().model;
    const throughSeq = compactionPoint(session.events, keepLatestTurn);
    if (model === undefined || throughSeq === undefined) return undefined;
    this.delta(session, { type: "compaction-start" });
    const head = deriveState(session.events.filter((event) => event.seq <= throughSeq));
    const response = await (async () => {
      const assembler = new BlockAssembler();
      const request: LlmRequest = {
        provider: model.provider,
        model: model.model,
        system: COMPACTION_SYSTEM,
        messages: [...head.messages, { role: "user", content: [{ type: "text", text: COMPACTION_REQUEST }] }],
        maxTokens: this.config.summaryMaxTokens ?? 8_192,
      };
      for await (const chunk of this.ctx.llm.stream(request, signal)) assembler.push(chunk);
      return assembler.result();
    })();
    const summary = response.message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
    const ok = response.reason !== "error" && response.reason !== "aborted" && summary !== "";
    if (!ok) this.ctx.logger("agent").warn("compacting %s failed: %s", session.id, response.error?.message ?? response.reason);
    const event = ok ? session.append("compaction", { throughSeq, summary }) : undefined;
    this.delta(session, { type: "compaction-end", ok });
    return event;
  }
}
