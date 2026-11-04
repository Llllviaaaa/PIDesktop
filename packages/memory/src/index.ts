/**
 * Local memory 2.0 (ADR 0009, M3): dual-layer Markdown memory (`<dataDir>/memory.md`
 * for global user preferences + `<cwd>/.pid/memory.md` for project conventions),
 * independent injection switches, and unified-diff confirmation before Agent writes.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import "@pid/permissions";
import "@pid/session";
import { SectionOrder } from "@pid/system-prompt";
import { textOutput, type ToolDefinition, type ToolEnv } from "@pid/tools";
import "@pid/ui";
import { buildMemoryDiff, nextMemoryContent, type MemoryScope, type MemoryWriteAction } from "./core.ts";

export * from "./core.ts";

export const name = "pid-memory";
export const inject = ["tools", "systemPrompt"];

export interface Config {
  /** Global user memory file, e.g. `<dataDir>/memory.md`. */
  file: string;
  /** Inject global `<memory>` section into the system prompt. Default `true`. */
  userEnabled?: boolean;
  /** Inject workspace `<project-memory>` section into the system prompt. Default `true`. */
  projectEnabled?: boolean;
  /** Optional workspace trust gate for `<cwd>/.pid/memory.md`. */
  isTrusted?: (cwd: string) => boolean;
}

export const MAX_MEMORY_BYTES = 256 * 1024;

export function projectMemoryPath(cwd: string): string {
  return join(cwd, ".pid", "memory.md");
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
      "Read or update the user's explicit local Pi Desktop memory Markdown file (`scope: 'user'` for global preferences, or `scope: 'project'` for `<workspace>/.pid/memory.md` project conventions).",
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
          description: "Target memory layer: 'user' (global preferences, default) or 'project' (<workspace>/.pid/memory.md)",
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
      const current = await readMemory(targetPath);
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
            return textOutput("Denied: Pi Desktop is in read-only mode", true);
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
          const label = scope === "project" ? ".pid/memory.md" : "memory.md";
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

export function apply(ctx: Context, config: Config): void {
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
            const memory = (await readMemory(projectMemoryPath(cwd))).trim();
            if (memory === "") return undefined;
            return `Project-specific conventions saved in .pid/memory.md for this workspace. Follow them unless the user says otherwise:\n<project-memory>\n${memory}\n</project-memory>`;
          },
          { order: SectionOrder.contextFiles + 60 },
        ),
      `${name}: project-section`,
    );
  }
}
