/**
 * The `bash` tool: run a command in the session's cwd. On Windows it uses
 * Git Bash (never WSL's System32\bash.exe); `Config.shell` overrides the
 * choice. Output is stdout and stderr interleaved, keeping the tail.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { Service, type Context } from "@deepseek-ai/cordis";
import { ErrorCode, type SandboxConfigKind, type SandboxGenerateConfigResult } from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import { textOutput, type ToolDefinition } from "@qianji/tools";
import {
  attachWindowsJobObject,
  buildSandboxedEnv,
  generateDevContainerConfig,
  generateWindowsSandboxConfig,
} from "./sandbox.ts";

export * from "./sandbox.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    bashSandbox?: BashSandbox;
  }
}

export class BashSandbox extends Service {
  readonly enabled: boolean;

  constructor(ctx: Context, config: { enabled?: boolean } = {}) {
    super(ctx, "bashSandbox");
    this.enabled = config.enabled !== false;
  }
}

export const name = "qianji-tool-bash";
export const inject = ["tools"];

export interface Config {
  /** Shell executable taking `-c <command>`. */
  shell?: string;
  /** Upper bound for the `timeout` argument, in seconds. */
  maxTimeoutSeconds?: number;
  /** Force lightweight sandbox containment on every bash invocation. */
  sandbox?: boolean;
}

const DEFAULT_TIMEOUT_SECONDS = 120;
/** Output kept in memory while a command runs; the tool then keeps the tail of it. */
const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_OUTPUT_LINES = 2000;
const MAX_OUTPUT_BYTES = 50 * 1024;

function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const where = spawnSync("where", ["git"], { encoding: "utf8", windowsHide: true });
  for (const git of where.status === 0 ? where.stdout.split(/\r?\n/).filter(Boolean) : []) {
    // <Git>\cmd\git.exe or <Git>\bin\git.exe → <Git>\bin\bash.exe
    candidates.push(join(dirname(dirname(git)), "bin", "bash.exe"));
  }
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")]) {
    if (root) candidates.push(join(root, "Git", "bin", "bash.exe"));
  }
  return candidates;
}

/** The shell to run commands with, or undefined when none is found. */
export function findShell(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (platform === "win32") return gitBashCandidates(env).find((candidate) => existsSync(candidate));
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export interface RunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface RunCommandOptions {
  sandbox?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function runCommand(
  shell: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  options: RunCommandOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const baseEnv = options.env ?? process.env;
    const childEnv = options.sandbox === true ? buildSandboxedEnv(baseEnv, cwd) : baseEnv;
    const child = spawn(shell, ["-c", command], {
      cwd,
      env: childEnv,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let closeJob: (() => void) | undefined;
    if (options.sandbox === true && child.pid !== undefined) {
      void attachWindowsJobObject(child.pid).then((disposer) => {
        closeJob = disposer;
      });
    }
    const chunks: Buffer[] = [];
    let buffered = 0;
    const collect = (chunk: Buffer) => {
      chunks.push(chunk);
      buffered += chunk.length;
      while (buffered > MAX_BUFFER_BYTES && chunks.length > 1) buffered -= (chunks.shift() as Buffer).length;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let timedOut = false;
    let aborted = false;
    const stop = () => {
      closeJob?.();
      if (child.pid !== undefined) killTree(child.pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      closeJob?.();
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      closeJob?.();
      resolve({ output: Buffer.concat(chunks).toString("utf8"), exitCode, timedOut, aborted });
    });
  });
}

function tail(text: string): { text: string; truncated: boolean } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const kept: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    bytes += Buffer.byteLength(line) + 1;
    if (kept.length >= MAX_OUTPUT_LINES || bytes > MAX_OUTPUT_BYTES) return { text: kept.reverse().join("\n"), truncated: true };
    kept.push(line);
  }
  return { text: kept.reverse().join("\n"), truncated: false };
}

export function bashTool(
  config: Config = {},
  isSandboxed?: () => boolean,
): ToolDefinition<{ command: string; timeout?: number }> {
  const maxTimeout = config.maxTimeoutSeconds ?? 600;
  let shell = config.shell;
  return {
    name: "bash",
    description: `Run a bash command in the working directory and return its combined stdout and stderr (the last ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES / 1024} KB). Times out after \`timeout\` seconds (default ${DEFAULT_TIMEOUT_SECONDS}, at most ${maxTimeout}).`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line" },
        timeout: { type: "number", description: "Timeout in seconds" },
      },
      required: ["command"],
    },
    async execute({ command, timeout }, env) {
      shell ??= findShell();
      if (shell === undefined) return textOutput("No bash found. Install Git for Windows or set the bash tool's shell.", true);
      const seconds = Math.min(Math.max(1, timeout ?? DEFAULT_TIMEOUT_SECONDS), maxTimeout);
      const sandbox = config.sandbox === true || isSandboxed?.() === true;
      const result = await runCommand(shell, command, env.cwd, seconds * 1000, env.signal, { sandbox });
      const { text, truncated } = tail(result.output);
      const notes: string[] = [];
      if (truncated) notes.push("[Output truncated; showing the end.]");
      if (result.timedOut) notes.push(`[Timed out after ${seconds}s; the command was killed.]`);
      if (result.aborted) notes.push("[Aborted; the command was killed.]");
      if (!result.timedOut && !result.aborted && result.exitCode !== 0) notes.push(`[Exit code ${result.exitCode}]`);
      const body = [truncated ? notes.shift() : undefined, text === "" ? "(no output)" : text, ...notes].filter((part) => part !== undefined).join("\n");
      return {
        content: [{ type: "text", text: body }],
        isError: result.timedOut || result.aborted || result.exitCode !== 0,
        details: { exitCode: result.exitCode },
      };
    },
  };
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(
    () => ctx.tools.register(bashTool(config, () => ctx.get("bashSandbox")?.enabled === true)),
    `${name}: bash`,
  );

  ctx.inject(["rpc"], (rpcCtx) => {
    rpcCtx.effect(
      () =>
        rpcCtx.rpc.method("sandbox.generateConfig", (params): SandboxGenerateConfigResult => {
          if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params))) {
            throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
          }
          const p = (params ?? {}) as Record<string, unknown>;
          const requiredStr = (key: string): string => {
            const raw = p[key];
            if (typeof raw !== "string" || raw.trim() === "") {
              throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
            }
            return raw.trim();
          };
          const kindRaw = requiredStr("kind");
          if (kindRaw !== "wsb" && kindRaw !== "devcontainer") {
            throw new RpcError(ErrorCode.InvalidParams, "kind must be 'wsb' or 'devcontainer'");
          }
          const kind: SandboxConfigKind = kindRaw;
          const cwd = resolvePath(requiredStr("cwd"));
          const overwrite = p.overwrite === true;
          if (kind === "wsb") {
            const target = join(cwd, ".qianji", "sandbox.wsb");
            const content = generateWindowsSandboxConfig(cwd);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, content, "utf8");
            return { kind, path: target, content };
          }
          const primaryTarget = join(cwd, ".devcontainer", "devcontainer.json");
          const target = !overwrite && existsSync(primaryTarget)
            ? join(cwd, ".qianji", "devcontainer.generated.json")
            : primaryTarget;
          const content = generateDevContainerConfig(cwd);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content, "utf8");
          return { kind, path: target, content };
        }),
      `${name}: sandbox.generateConfig`,
    );
  });
}
