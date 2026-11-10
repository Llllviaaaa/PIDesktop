/**
 * Local memory 2.0 (ADR 0009, M3): dual-layer Markdown memory (`<dataDir>/memory.md`
 * for global user preferences + `<cwd>/.qianji/memory.md` for project conventions),
 * independent injection switches, and unified-diff confirmation before Agent writes.
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/permissions";
import { ErrorCode, type MemoryExportResult, type MemoryGetResult } from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import "@qianji/session";
import { SectionOrder } from "@qianji/system-prompt";
import { textOutput, type ToolDefinition, type ToolEnv } from "@qianji/tools";
import "@qianji/ui";
import { buildMemoryDiff, nextMemoryContent, type MemoryScope, type MemoryWriteAction } from "./core.ts";

export * from "./core.ts";

export const name = "qianji-memory";
export const inject = ["tools", "systemPrompt"];

export interface Config {
  /** Global user memory file, e.g. `<dataDir>/memory.md`. */
  file: string;
  /** Inject global `<memory>` section into the system prompt. Default `true`. */
  userEnabled?: boolean;
  /** Inject workspace `<project-memory>` section into the system prompt. Default `true`. */
  projectEnabled?: boolean;
  /** Optional workspace trust gate for `<cwd>/.qianji/memory.md`. */
  isTrusted?: (cwd: string) => boolean;
}

export const MAX_MEMORY_BYTES = 256 * 1024;

export function projectMemoryPath(cwd: string): string {
  return join(cwd, ".qianji", "memory.md");
}

function readableProjectMemoryPath(cwd: string): string {
  const primary = projectMemoryPath(cwd);
  if (existsSync(primary)) return primary;
  const legacy = join(cwd, ".pid", "memory.md");
  return existsSync(legacy) ? legacy : primary;
}

export async function readMemory(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function saveMemory(path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES) throw new Error("Local memory cannot exceed 256 KB");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
}

export interface MemoryToolOptions {
  file: string;
  ctx?: Context;
  isTrusted?: (cwd: string) => boolean;
}

export function memoryTool(
  fileOrOptions: string | MemoryToolOptions,
): ToolDefinition<{ action: "read" | MemoryWriteAction; scope?: MemoryScope; content?: string }> {
  const options: MemoryToolOptions = typeof fileOrOptions === "string" ? { file: fileOrOptions } : fileOrOptions;
  return {
    name: "desktop_memory",
    description: [
      "Read or update the user's explicit local Qianji memory Markdown file (`scope: 'user'` for global preferences, or `scope: 'project'` for `<workspace>/.qianji/memory.md` project conventions).",
      "Use append or replace only when the user explicitly asks you to remember something, or states a stable preference/convention that will clearly help future tasks.",
      "Do not store secrets, credentials, transient task details, guesses, or sensitive personal data.",
      "Use read before replacing. Prefer append for a new independent entry and keep entries concise.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "append", "replace", "clear"] },
        scope: {
          type: "string",
          enum: ["user", "project"],
          description: "Target memory layer: 'user' (global preferences, default) or 'project' (<workspace>/.qianji/memory.md)",
        },
        content: { type: "string", description: "Markdown content for append or replace" },
      },
      required: ["action"],
    },
    async execute({ action, scope: rawScope, content }, env: ToolEnv) {
      const scope: MemoryScope = rawScope === "project" ? "project" : "user";
      if (scope === "project" && options.isTrusted?.(env.cwd) === false) {
        return textOutput("Project memory is disabled because the current workspace is not trusted.", true);
      }
      const targetPath = scope === "project" ? projectMemoryPath(env.cwd) : options.file;
      const readPath = scope === "project" ? readableProjectMemoryPath(env.cwd) : options.file;
      const current = await readMemory(readPath);
      if (action === "read") {
        return textOutput(current || (scope === "project" ? "Project memory is empty." : "Local memory is empty."));
      }
      if (!["append", "replace", "clear"].includes(action)) {
        return textOutput(`Unknown action ${action}.`, true);
      }
      const next = nextMemoryContent(current, action, content);
      if (next === current) {
        return textOutput(scope === "project" ? "Project memory is already up to date." : "Local memory is already up to date.");
      }

      const ctx = options.ctx;
      if (ctx !== undefined) {
        const permissions = ctx.get("permissions");
        const ui = ctx.get("ui");
        const sessions = ctx.get("sessions");
        let needsConfirm = false;
        if (permissions !== undefined) {
          const session = sessions !== undefined && env.sessionId ? await sessions.get(env.sessionId) : undefined;
          const effective = session !== undefined ? permissions.modes(session).effective : permissions.defaultModes().effective;
          if (effective === "read-only") {
            return textOutput("Denied: Qianji is in read-only mode", true);
          }
          needsConfirm = effective !== "full-access";
        } else if (ui !== undefined && ui.canAsk(env.sessionId)) {
          needsConfirm = true;
        }

        if (needsConfirm) {
          if (ui === undefined || !ui.canAsk(env.sessionId)) {
            return textOutput("Denied: Confirmation required to update memory, but no UI is available", true);
          }
          const title = scope === "project" ? "更新当前项目记忆？" : "更新全局本地记忆？";
          const label = scope === "project" ? ".qianji/memory.md" : "memory.md";
          const scopeLabel = scope === "project" ? "当前项目记忆" : "全局本地记忆";
          const summary = action === "clear"
            ? `清空${scopeLabel}（${label}）`
            : `通过 ${action} 更新${scopeLabel}（${label}）`;
          const diffBlock = buildMemoryDiff(current, next, label);
          const allowed = await ui.confirm(env.sessionId, title, `${summary}\n\n${diffBlock}`, env.signal);
          if (!allowed) {
            return textOutput(`Denied: ${title} denied by user`, true);
          }
        }
      }

      await saveMemory(targetPath, next);
      if (scope === "project") {
        return textOutput(
          action === "append"
            ? "Preference added to project memory."
            : action === "clear"
              ? "Project memory cleared."
              : "Project memory replaced.",
        );
      }
      return textOutput(
        action === "append"
          ? "Preference added to local memory."
          : action === "clear"
            ? "Local memory cleared."
            : "Local memory replaced.",
      );
    },
  };
}

type RpcParams = Record<string, unknown>;

function recordOf(raw: unknown): RpcParams {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
  }
  return raw as RpcParams;
}

function optionalCwd(p: RpcParams): string | undefined {
  if (p.cwd === undefined || p.cwd === "") return undefined;
  if (typeof p.cwd !== "string") throw new RpcError(ErrorCode.InvalidParams, "cwd must be a string");
  const trimmed = p.cwd.trim();
  if (trimmed === "") return undefined;
  if (!isAbsolute(trimmed)) throw new RpcError(ErrorCode.InvalidParams, "cwd must be an absolute path");
  return resolve(trimmed);
}

function requiredExistingCwd(p: RpcParams): string {
  const cwd = optionalCwd(p);
  if (cwd === undefined || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new RpcError(ErrorCode.InvalidParams, "需要打开有效的工作区目录才能操作当前项目配置");
  }
  return cwd;
}

function scopeOf(p: RpcParams): MemoryScope {
  if (p.scope === undefined || p.scope === "user") return "user";
  if (p.scope === "project") return "project";
  throw new RpcError(ErrorCode.InvalidParams, "scope must be 'user' or 'project'");
}

function writeFileAtomically(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, file);
}

export function apply(ctx: Context, config: Config): void {
  if (config.userEnabled !== false || config.projectEnabled !== false) {
    ctx.effect(
      () =>
        ctx.tools.register(
          memoryTool({
            file: config.file,
            ctx,
            ...(config.isTrusted === undefined ? {} : { isTrusted: config.isTrusted }),
          }),
        ),
      `${name}: desktop_memory`,
    );
  }

  if (config.userEnabled !== false) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section(
          "memory",
          async () => {
            const memory = (await readMemory(config.file)).trim();
            if (memory === "") return undefined;
            return `The user's saved preferences (local memory). Follow them unless the user says otherwise:\n<memory>\n${memory}\n</memory>`;
          },
          { order: SectionOrder.contextFiles + 50 },
        ),
      `${name}: section`,
    );
  }

  if (config.projectEnabled !== false) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section(
          "project-memory",
          async ({ cwd }) => {
            if (config.isTrusted?.(cwd) === false) return undefined;
            const memory = (await readMemory(readableProjectMemoryPath(cwd))).trim();
            if (memory === "") return undefined;
            return `Project-specific conventions saved in .qianji/memory.md for this workspace. Follow them unless the user says otherwise:\n<project-memory>\n${memory}\n</project-memory>`;
          },
          { order: SectionOrder.contextFiles + 60 },
        ),
      `${name}: project-section`,
    );
  }

  ctx.inject(["rpc"], (rpcCtx) => {
    const globalMemoryPath = () => resolve(config.file);
    const methods: Record<string, (raw: unknown) => unknown> = {
      "memory.get": async (raw): Promise<MemoryGetResult> => {
        const p = recordOf(raw);
        const scope = scopeOf(p);
        if (scope === "project") {
          const cwd = optionalCwd(p);
          if (cwd === undefined) {
            return { scope: "project", path: "", content: "", trusted: false };
          }
          const path = resolve(projectMemoryPath(cwd));
          const trusted = config.isTrusted ? config.isTrusted(cwd) : true;
          return { scope: "project", path, content: await readMemory(readableProjectMemoryPath(cwd)), trusted };
        }
        const path = globalMemoryPath();
        return { scope: "user", path, content: await readMemory(path), trusted: true };
      },

      "memory.set": async (raw): Promise<MemoryGetResult> => {
        const p = recordOf(raw);
        const scope = scopeOf(p);
        if (typeof p.content !== "string") {
          throw new RpcError(ErrorCode.InvalidParams, "content must be a string");
        }
        if (Buffer.byteLength(p.content, "utf8") > MAX_MEMORY_BYTES) {
          throw new RpcError(ErrorCode.InvalidParams, "记忆内容不能超过 256 KB");
        }
        const projectCwd = scope === "project" ? requiredExistingCwd(p) : undefined;
        const path = projectCwd !== undefined
          ? resolve(projectMemoryPath(projectCwd))
          : globalMemoryPath();
        await saveMemory(path, p.content);
        const trusted = projectCwd !== undefined && config.isTrusted ? config.isTrusted(projectCwd) : true;
        return { scope, path, content: p.content, trusted };
      },

      "memory.delete": async (raw): Promise<{ ok: true }> => {
        const p = recordOf(raw);
        const scope = scopeOf(p);
        const path = scope === "project"
          ? resolve(projectMemoryPath(requiredExistingCwd(p)))
          : globalMemoryPath();
        rmSync(path, { force: true });
        return { ok: true };
      },

      "memory.export": async (raw): Promise<MemoryExportResult> => {
        const p = recordOf(raw);
        const scope = scopeOf(p);
        if (typeof p.destination !== "string" || p.destination.trim() === "" || !isAbsolute(p.destination.trim())) {
          throw new RpcError(ErrorCode.InvalidParams, "destination must be an absolute path");
        }
        const destination = resolve(p.destination.trim());
        const sourcePath = scope === "project"
          ? resolve(projectMemoryPath(requiredExistingCwd(p)))
          : globalMemoryPath();
        const content = await readMemory(sourcePath);
        writeFileAtomically(destination, content);
        return { path: destination };
      },
    };

    for (const [method, handler] of Object.entries(methods)) {
      rpcCtx.effect(() => rpcCtx.rpc.method(method, handler), `${name}: ${method}`);
    }
  });
}
