import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import {
  validateDesktopHooks,
  type DesktopHookConfig,
  type DesktopHookEvent,
} from "./pidesktop-hooks-core.ts";

const OUTPUT_LIMIT = 64 * 1024;

function loadHooks(): DesktopHookConfig[] {
  const encoded = process.env.PIDESKTOP_HOOKS_CONFIG_B64;
  delete process.env.PIDESKTOP_HOOKS_CONFIG_B64;
  if (!encoded) return [];
  try {
    return validateDesktopHooks(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
  } catch (error) {
    console.error(`Pi Desktop hooks config is invalid: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function hookEnvironment(inheritEnvironment: boolean, event: DesktopHookEvent, cwd: string): NodeJS.ProcessEnv {
  const sensitive = /(api.?key|token|secret|password|credential|authorization|cookie)/i;
  const environment = inheritEnvironment
    ? { ...process.env }
    : Object.fromEntries(Object.entries(process.env).filter(([key]) => !sensitive.test(key)));
  delete environment.PIDESKTOP_HOOKS_CONFIG_B64;
  environment.PIDESKTOP_HOOK_EVENT = event;
  environment.PIDESKTOP_WORKSPACE = cwd;
  return environment;
}

function executeHook(
  hook: DesktopHookConfig,
  event: DesktopHookEvent,
  payload: unknown,
  cwd: string,
  inheritEnvironment: boolean,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    const executable = windows ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
    const args = windows ? ["/d", "/s", "/c", hook.command] : ["-lc", hook.command];
    const child = spawn(executable, args, {
      cwd,
      env: hookEnvironment(inheritEnvironment, event, cwd),
      shell: false,
      windowsHide: true,
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
      resolve({
        ok: !timedOut && code === 0,
        output: timedOut ? `Timed out after ${hook.timeoutSeconds}s` : output.trim(),
      });
    });
    child.stdin.end(JSON.stringify({ event, cwd, payload }));
  });
}

export default function (pi: ExtensionAPI) {
  const hooks = loadHooks();
  const inheritEnvironment = process.env.PIDESKTOP_HOOKS_INHERIT_ENV === "1";

  const run = async (event: DesktopHookEvent, payload: unknown, ctx: ExtensionContext) => {
    for (const hook of hooks.filter((candidate) => candidate.enabled && candidate.event === event)) {
      const result = await executeHook(hook, event, payload, ctx.cwd, inheritEnvironment);
      if (result.ok) continue;
      const message = `${hook.name}: ${result.output || "command failed"}`;
      console.error(`Pi Desktop hook failed: ${message}`);
      if (hook.blocking && event === "tool_call") return message;
      if (ctx.hasUI) ctx.ui.notify(`Hook 失败：${message}`, "error");
    }
    return null;
  };

  pi.on("session_start", async (event, ctx) => { await run("session_start", event, ctx); });
  pi.on("before_agent_start", async (event, ctx) => { await run("before_agent_start", { prompt: event.prompt }, ctx); });
  pi.on("agent_end", async (event, ctx) => { await run("agent_end", { messageCount: event.messages.length }, ctx); });
  pi.on("agent_settled", async (event, ctx) => { await run("agent_settled", event, ctx); });
  pi.on("tool_call", async (event, ctx) => {
    const reason = await run("tool_call", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    }, ctx);
    return reason ? { block: true, reason } : undefined;
  });
  pi.on("tool_result", async (event, ctx) => {
    await run("tool_result", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      isError: event.isError,
      content: event.content,
    }, ctx);
  });
}
