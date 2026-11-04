/**
 * Host RPC endpoints for Memory 2.0 (`memory.*`) and in-app Skills lifecycle
 * management (`skill.*`). Keeping these on the Harness Host guarantees path
 * parity across Tauri Desktop, standalone CLI/Web runs, and browser E2E suites.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import "@pid/commands";
import { MAX_MEMORY_BYTES, projectMemoryPath, readMemory, saveMemory } from "@pid/memory";
import {
  discoverSkillEntries,
  normalizeSkillPathKey,
  readFrontMatter,
  setSkillEnabledState,
} from "@pid/prompt-context";
import {
  ErrorCode,
  type MemoryExportResult,
  type MemoryGetResult,
  type MemoryScope,
  type SkillCreateResult,
  type SkillInfo,
  type SkillListResult,
  type SkillReadResult,
} from "@pid/protocol";
import { readHarnessConfig } from "./harness-config.ts";
import { RpcError } from "./rpc.ts";

export const name = "pid-memory-skills-rpc";
export const inject = ["rpc"];

export interface Config {
  dataDir: string;
}

type Params = Record<string, unknown>;

function recordOf(raw: unknown): Params {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
  }
  return raw as Params;
}

function optionalCwd(p: Params): string | undefined {
  if (p.cwd === undefined || p.cwd === "") return undefined;
  if (typeof p.cwd !== "string") throw new RpcError(ErrorCode.InvalidParams, "cwd must be a string");
  const trimmed = p.cwd.trim();
  if (trimmed === "") return undefined;
  if (!isAbsolute(trimmed)) throw new RpcError(ErrorCode.InvalidParams, "cwd must be an absolute path");
  return resolve(trimmed);
}

function requiredExistingCwd(p: Params): string {
  const cwd = optionalCwd(p);
  if (cwd === undefined || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new RpcError(ErrorCode.InvalidParams, "需要打开有效的工作区目录才能操作当前项目配置");
  }
  return cwd;
}

function scopeOf(p: Params): MemoryScope {
  if (p.scope === undefined || p.scope === "user") return "user";
  if (p.scope === "project") return "project";
  throw new RpcError(ErrorCode.InvalidParams, "scope must be 'user' or 'project'");
}

function globalMemoryPath(dataDir: string): string {
  const { config } = readHarnessConfig(join(dataDir, "harness.json"));
  return resolve(config.memory.file ?? join(dataDir, "memory.md"));
}

function allowedSkillRoots(dataDir: string, cwd?: string): string[] {
  const roots = [resolve(join(dataDir, "skills"))];
  if (cwd !== undefined) {
    roots.push(resolve(join(cwd, ".pid", "skills")));
    roots.push(resolve(join(cwd, ".agents", "skills")));
  }
  return roots;
}

/** Confines skill file operations strictly to `<allowedRoot>/<skillFolder>/SKILL.md`. */
function resolveAllowedSkillFile(dataDir: string, cwd: string | undefined, rawPath: unknown): string {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new RpcError(ErrorCode.InvalidParams, "path must be a non-empty string");
  }
  const resolved = resolve(rawPath.trim());
  if (basename(resolved) !== "SKILL.md") {
    throw new RpcError(ErrorCode.InvalidParams, "技能文件路径必须指向 SKILL.md");
  }
  const fileKey = normalizeSkillPathKey(resolved);
  for (const root of allowedSkillRoots(dataDir, cwd)) {
    const rootPrefix = `${normalizeSkillPathKey(root)}/`;
    if (!fileKey.startsWith(rootPrefix)) continue;
    const rel = relative(root, resolved);
    const parts = rel.split(sep).filter(Boolean);
    if (parts.length === 2 && parts[1] === "SKILL.md" && parts[0] !== "." && parts[0] !== "..") {
      return resolved;
    }
  }
  throw new RpcError(ErrorCode.InvalidParams, "不允许访问技能目录之外的路径");
}

function slugifySkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function listSkills(dataDir: string, cwd?: string): SkillInfo[] {
  return discoverSkillEntries(dataDir, cwd).map((entry) => ({
    ...entry,
    trusted: true,
  }));
}

function buildSkillMarkdown(name: string, description: string, body?: string): string {
  const cleanName = name.trim();
  const cleanDesc = description.trim().replace(/\r?\n/g, " ");
  const trimmedBody = body?.trim();
  const contentBody = trimmedBody && trimmedBody !== ""
    ? trimmedBody
    : [
        `# ${cleanName}`,
        "",
        "## 适用场景",
        cleanDesc,
        "",
        "## 执行步骤",
        "1. 先使用 `read` / `grep` 了解相关代码上下文。",
        "2. 按最小改动原则完成修改并补充测试。",
        "3. 运行测试确认通过后汇报结果。",
      ].join("\n");
  return `---\nname: ${cleanName}\ndescription: ${JSON.stringify(cleanDesc)}\n---\n\n${contentBody}\n`;
}

function writeFileAtomically(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, file);
}

export function apply(ctx: Context, config: Config): void {
  const { dataDir } = config;
  const notifyCommands = () => {
    ctx.get("commands")?.notifyChanged("skills");
  };

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
        return { scope: "project", path, content: await readMemory(path), trusted: true };
      }
      const path = globalMemoryPath(dataDir);
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
      const path = scope === "project"
        ? resolve(projectMemoryPath(requiredExistingCwd(p)))
        : globalMemoryPath(dataDir);
      await saveMemory(path, p.content);
      return { scope, path, content: p.content, trusted: true };
    },

    "memory.delete": async (raw): Promise<{ ok: true }> => {
      const p = recordOf(raw);
      const scope = scopeOf(p);
      const path = scope === "project"
        ? resolve(projectMemoryPath(requiredExistingCwd(p)))
        : globalMemoryPath(dataDir);
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
        : globalMemoryPath(dataDir);
      const content = await readMemory(sourcePath);
      writeFileAtomically(destination, content);
      return { path: destination };
    },

    "skill.list": (raw): SkillListResult => {
      const p = recordOf(raw);
      const cwd = optionalCwd(p);
      return { skills: listSkills(dataDir, cwd) };
    },

    "skill.read": (raw): SkillReadResult => {
      const p = recordOf(raw);
      const cwd = optionalCwd(p);
      const file = resolveAllowedSkillFile(dataDir, cwd, p.path);
      if (!existsSync(file)) {
        throw new RpcError(ErrorCode.InvalidParams, `找不到技能文件：${file}`);
      }
      const content = readFileSync(file, "utf8");
      const fields = readFrontMatter(content);
      const fallbackName = basename(dirname(file));
      return {
        path: file,
        content,
        name: fields.name || fallbackName,
        description: fields.description ?? "",
      };
    },

    "skill.create": (raw): SkillCreateResult => {
      const p = recordOf(raw);
      const scope = scopeOf(p);
      const rawName = typeof p.name === "string" ? p.name.trim() : "";
      const rawDesc = typeof p.description === "string" ? p.description.trim() : "";
      if (rawName === "") {
        throw new RpcError(ErrorCode.InvalidParams, "请填写技能标识名称（如 fix-ci）");
      }
      const slug = slugifySkillName(rawName);
      if (slug === "" || !/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
        throw new RpcError(ErrorCode.InvalidParams, "技能标识只能包含英文字母、数字、点、下划线和连字符");
      }
      if (rawDesc === "") {
        throw new RpcError(ErrorCode.InvalidParams, "请填写技能触发描述（description）");
      }
      const cwd = scope === "project" ? requiredExistingCwd(p) : optionalCwd(p);
      const rootDir = scope === "project" && cwd !== undefined
        ? join(cwd, ".pid", "skills")
        : join(dataDir, "skills");
      const skillFile = resolve(join(rootDir, slug, "SKILL.md"));
      if (existsSync(skillFile)) {
        throw new RpcError(ErrorCode.InvalidParams, `技能 ${slug} 已存在`);
      }
      const content = buildSkillMarkdown(slug, rawDesc, typeof p.body === "string" ? p.body : undefined);
      writeFileAtomically(skillFile, content);
      setSkillEnabledState(dataDir, skillFile, true);
      notifyCommands();
      return {
        skill: {
          name: slug,
          description: rawDesc,
          path: skillFile,
          scope,
          enabled: true,
          trusted: true,
        },
        content,
      };
    },

    "skill.save": (raw): SkillListResult => {
      const p = recordOf(raw);
      const cwd = optionalCwd(p);
      const file = resolveAllowedSkillFile(dataDir, cwd, p.path);
      if (typeof p.content !== "string") {
        throw new RpcError(ErrorCode.InvalidParams, "content must be a string");
      }
      if (Buffer.byteLength(p.content, "utf8") > MAX_MEMORY_BYTES) {
        throw new RpcError(ErrorCode.InvalidParams, "SKILL.md 内容不能超过 256 KB");
      }
      const fields = readFrontMatter(p.content);
      if (!fields.description || fields.description.trim() === "") {
        throw new RpcError(ErrorCode.InvalidParams, "SKILL.md 顶部 Frontmatter 必须包含非空的 description 字段");
      }
      writeFileAtomically(file, p.content);
      notifyCommands();
      return { skills: listSkills(dataDir, cwd) };
    },

    "skill.toggle": (raw): SkillListResult => {
      const p = recordOf(raw);
      const cwd = optionalCwd(p);
      const file = resolveAllowedSkillFile(dataDir, cwd, p.path);
      if (typeof p.enabled !== "boolean") {
        throw new RpcError(ErrorCode.InvalidParams, "enabled must be a boolean");
      }
      setSkillEnabledState(dataDir, file, p.enabled);
      notifyCommands();
      return { skills: listSkills(dataDir, cwd) };
    },

    "skill.delete": (raw): SkillListResult => {
      const p = recordOf(raw);
      const cwd = optionalCwd(p);
      const file = resolveAllowedSkillFile(dataDir, cwd, p.path);
      rmSync(dirname(file), { recursive: true, force: true });
      setSkillEnabledState(dataDir, file, true);
      notifyCommands();
      return { skills: listSkills(dataDir, cwd) };
    },
  };

  for (const [method, handler] of Object.entries(methods)) {
    ctx.effect(() => ctx.rpc.method(method, handler), `${name}: ${method}`);
  }
}
