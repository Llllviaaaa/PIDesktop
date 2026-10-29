/**
 * User hooks (ADR 0009): shell commands run on agent events, with the event
 * as JSON on stdin. The Pi extension's event names map onto the harness's:
 *
 * | hook event           | harness event                         |
 * |----------------------|---------------------------------------|
 * | `session_start`      | `session/created`                     |
 * | `before_agent_start` | `agent/before-start`                  |
 * | `agent_end`          | `agent/settled` (first)               |
 * | `agent_settled`      | `agent/settled` (then)                |
 * | `tool_call`          | `tools/pre-execute` (may block)       |
 * | `tool_result`        | `tools/result`                        |
 *
 * A failing `tool_call` hook marked blocking denies the call; any other
 * failure is logged and shown with `ui.notify`.
 */
import { spawn } from "node:child_process";
import type { Context } from "@deepseek-ai/cordis";
import "@pid/agent";
import type { Session } from "@pid/session";
import "@pid/tools";
import "@pid/ui";
import { validateDesktopHooks, type DesktopHookConfig, type DesktopHookEvent } from "./core.ts";

export * from "./core.ts";

export const name = "pid-hooks";
export const inject = ["sessions", "tools", "ui"];

export interface Config {
  hooks: DesktopHookConfig[];
  /** Pass secrets-looking variables (keys, tokens, passwords) to hooks too. Default false. */
  inheritEnvironment?: boolean;
}

const OUTPUT_LIMIT = 64 * 1024;
const SENSITIVE = /(api.?key|token|secret|password|credential|authorization|cookie)/i;

export function hookEnvironment(inheritEnvironment: boolean, event: DesktopHookEvent, cwd: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = inheritEnvironment ? { ...env } : Object.fromEntries(Object.entries(env).filter(([key]) => !SENSITIVE.test(key)));
  environment.PIDESKTOP_HOOK_EVENT = event;
  environment.PIDESKTOP_WORKSPACE = cwd;
  return environment;
}

export function executeHook(hook: DesktopHookConfig, event: DesktopHookEvent, payload: unknown, cwd: string, inheritEnvironment: boolean): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    const executable = windows ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
    // cmd.exe does not understand the \" escaping Node applies to arguments,
    // so the command line goes through verbatim; /s strips the outer quotes.
    const args = windows ? ["/d", "/s", "/c", `"${hook.command}"`] : ["-lc", hook.command];
    const child = spawn(executable, args, {
      cwd,
      env: hookEnvironment(inheritEnvironment, event, cwd),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: windows,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (output.length < OUTPUT_LIMIT) output += chunk.toString("utf8").slice(0, OUTPUT_LIMIT - output.length);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => resolve({ ok: false, output: error.message }));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, hook.timeoutSeconds * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, output: timedOut ? `Timed out after ${hook.timeoutSeconds}s` : output.trim() });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ event, cwd, payload }));
  });
}

function lastPrompt(session: Session): string {
  const user = session.events.findLast((event) => event.type === "user");
  if (user?.type !== "user") return "";
  return user.data.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

export function apply(ctx: Context, config: Config): void {
  let hooks: DesktopHookConfig[];
  try {
    hooks = validateDesktopHooks(config.hooks ?? []);
  } catch (error) {
    ctx.logger("hooks").error("hooks config is invalid: %s", error instanceof Error ? error.message : String(error));
    return;
  }
  const inherit = config.inheritEnvironment === true;

  /** Run the hooks of `event`; the failure message of a blocking one, if any. */
  const run = async (event: DesktopHookEvent, payload: unknown, sessionId: string, cwd: string): Promise<string | undefined> => {
    for (const hook of hooks.filter((candidate) => candidate.enabled && candidate.event === event)) {
      const result = await executeHook(hook, event, payload, cwd, inherit);
      if (result.ok) continue;
      const message = `${hook.name}: ${result.output || "command failed"}`;
      ctx.logger("hooks").warn("hook failed: %s", message);
      if (hook.blocking && event === "tool_call") return message;
      ctx.ui.notify(sessionId, `Hook 失败：${message}`, "error");
    }
    return undefined;
  };
  const has = (event: DesktopHookEvent) => hooks.some((hook) => hook.enabled && hook.event === event);

  if (has("session_start")) {
    ctx.on("session/created", (session) => {
      void run("session_start", { sessionId: session.id }, session.id, session.header.cwd);
    });
  }
  if (has("before_agent_start")) {
    ctx.on("agent/before-start", async (session) => {
      await run("before_agent_start", { messageType: "user", prompt: lastPrompt(session) }, session.id, session.header.cwd);
    });
  }
  if (has("agent_end") || has("agent_settled")) {
    ctx.on("agent/settled", async (session, outcome) => {
      const messageCount = session.state().messages.length;
      await run("agent_end", { messageCount }, session.id, session.header.cwd);
      await run("agent_settled", { outcome }, session.id, session.header.cwd);
    });
  }
  if (has("tool_call")) {
    ctx.on("tools/pre-execute", async (call, env) => {
      const reason = await run("tool_call", { toolCallId: call.id, toolName: call.name, input: call.args }, env.sessionId, env.cwd);
      return reason === undefined ? undefined : { deny: true, reason };
    });
  }
  if (has("tool_result")) {
    ctx.on("tools/result", (call, env, output) => {
      void run("tool_result", { toolCallId: call.id, toolName: call.name, input: call.args, isError: output.isError === true, content: output.content }, env.sessionId, env.cwd);
    });
  }
}
