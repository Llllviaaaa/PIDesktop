/**
 * The built-in system prompt sections: who the agent is, how it works,
 * the project's context files (AGENTS.md, else CLAUDE.md), the available
 * skills (`<dir>/<skill>/SKILL.md`) and the environment.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { CommandDefinition } from "@pid/commands";
import {
  ErrorCode,
  type MemoryScope,
  type SkillCreateResult,
  type SkillInfo,
  type SkillListResult,
  type SkillReadResult,
} from "@pid/protocol";
import { RpcError } from "@pid/rpc";
import { SectionOrder, type PromptEnv } from "@pid/system-prompt";

export const name = "pid-prompt-context";
export const inject = ["systemPrompt"];

export interface Config {
  /** The user's data directory (`~/.pid`): its AGENTS.md and skills/ apply everywhere. */
  dataDir: string;
  /** Override for "today", for tests. */
  now?: () => Date;
  /** Include AGENTS.md / CLAUDE.md. Default true. */
  contextFiles?: boolean;
  /** The user's own instructions (personality, custom instructions), after the guidelines. */
  instructions?: string;
}

export const IDENTITY = `You are a coding agent running in Pi Desktop on the user's computer. You help with software tasks by reading and changing files and running commands with the tools you are given.`;

export const GUIDELINES = `Guidelines:
- Read the relevant code before changing it; prefer small, focused edits with the edit tool over rewriting files.
- Use find, grep and ls to explore instead of guessing paths.
- Run the project's tests or build after changes when you can, and report failures honestly.
- When the task is done, reply with a short summary of what changed.`;

const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"];
const MAX_SKILL_BYTES = 256 * 1024;

/** The context files that apply in `cwd`: global first, then from the root down. One per directory. */
export function contextFiles(dataDir: string, cwd: string): string[] {
  const files: string[] = [];
  const global = join(dataDir, "AGENTS.md");
  if (existsSync(global)) files.push(global);
  const dirs: string[] = [];
  let dir = resolve(cwd);
  const root = parse(dir).root;
  for (;;) {
    dirs.unshift(dir);
    if (dir === root) break;
    dir = dirname(dir);
  }
  for (const each of dirs) {
    const found = CONTEXT_FILES.map((file) => join(each, file)).find((file) => existsSync(file));
    if (found !== undefined && found !== global) files.push(found);
  }
  return files;
}

export interface Skill {
  name: string;
  description: string;
  path: string;
}

export interface ManagedSkillEntry {
  name: string;
  description: string;
  path: string;
  scope: "user" | "project";
  enabled: boolean;
}

export function normalizeSkillPathKey(filePath: string): string {
  const abs = resolve(filePath).replace(/\\/g, "/");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export function skillsStatePath(dataDir: string): string {
  return join(dataDir, "skills.json");
}

export function readDisabledSkillKeys(dataDir: string): Set<string> {
  const file = skillsStatePath(dataDir);
  if (!existsSync(file)) return new Set();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const disabled = (parsed as { disabled?: unknown } | null)?.disabled;
    if (!Array.isArray(disabled)) return new Set();
    return new Set(
      disabled
        .filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .map((item) => normalizeSkillPathKey(item)),
    );
  } catch {
    return new Set();
  }
}

export function setSkillEnabledState(dataDir: string, skillPath: string, enabled: boolean): void {
  const file = skillsStatePath(dataDir);
  let rawDisabled: string[] = [];
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const existing = (parsed as { disabled?: unknown } | null)?.disabled;
      if (Array.isArray(existing)) {
        rawDisabled = existing.filter((item): item is string => typeof item === "string" && item.trim() !== "");
      }
    } catch {
      rawDisabled = [];
    }
  }
  const targetKey = normalizeSkillPathKey(skillPath);
  const filtered = rawDisabled.filter((item) => normalizeSkillPathKey(item) !== targetKey);
  if (!enabled) {
    filtered.push(resolve(skillPath));
  }
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, disabled: filtered }, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

/** The `name` and `description` of a SKILL.md's front matter. */
export function readFrontMatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields: Record<string, string> = {};
  for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (field?.[1] !== undefined && field[2] !== undefined) fields[field[1]] = field[2].replace(/^["']|["']$/g, "").trim();
  }
  return fields;
}

/** Skills under each dir; a later dir's skill replaces an earlier one of the same name. */
export function findSkills(dirs: readonly string[], options: { disabled?: ReadonlySet<string> } = {}): Skill[] {
  const skills = new Map<string, Skill>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name, "SKILL.md");
      if (!existsSync(path)) continue;
      if (options.disabled?.has(normalizeSkillPathKey(path))) continue;
      const fields = readFrontMatter(readFileSync(path, "utf8"));
      const skillName = fields.name || entry.name;
      if (!fields.description) continue;
      skills.set(skillName, { name: skillName, description: fields.description, path });
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Discover all skills (enabled and disabled, user and project) for Settings management. */
export function discoverSkillEntries(dataDir: string, cwd?: string): ManagedSkillEntry[] {
  const disabled = readDisabledSkillKeys(dataDir);
  const roots: Array<{ dir: string; scope: "user" | "project" }> = [
    { dir: join(dataDir, "skills"), scope: "user" },
  ];
  const trimmedCwd = cwd?.trim();
  if (trimmedCwd) {
    roots.push({ dir: join(trimmedCwd, ".pid", "skills"), scope: "project" });
    roots.push({ dir: join(trimmedCwd, ".agents", "skills"), scope: "project" });
  }
  const seenPaths = new Set<string>();
  const list: ManagedSkillEntry[] = [];
  for (const { dir, scope } of roots) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = resolve(join(dir, entry.name, "SKILL.md"));
      if (!existsSync(path)) continue;
      const key = normalizeSkillPathKey(path);
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      const fields = readFrontMatter(readFileSync(path, "utf8"));
      const skillName = fields.name || entry.name;
      list.push({
        name: skillName,
        description: fields.description ?? "",
        path,
        scope,
        enabled: !disabled.has(key),
      });
    }
  }
  return list.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "user" ? -1 : 1));
}

export function skillDirs(dataDir: string, cwd: string): string[] {
  return [join(dataDir, "skills"), join(cwd, ".pid", "skills"), join(cwd, ".agents", "skills")];
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

function allowedSkillRoots(dataDir: string, cwd?: string): string[] {
  const roots = [resolve(join(dataDir, "skills"))];
  if (cwd !== undefined) {
    roots.push(resolve(join(cwd, ".pid", "skills")));
    roots.push(resolve(join(cwd, ".agents", "skills")));
  }
  return roots;
}

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

function buildSkillMarkdown(skillName: string, description: string, body?: string): string {
  const cleanName = skillName.trim();
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
  const now = config.now ?? (() => new Date());

  ctx.effect(() => ctx.systemPrompt.section("identity", () => IDENTITY, { order: SectionOrder.identity }), `${name}: identity`);
  ctx.effect(() => ctx.systemPrompt.section("guidelines", () => GUIDELINES, { order: SectionOrder.guidelines }), `${name}: guidelines`);

  const instructions = config.instructions?.trim();
  if (instructions) {
    ctx.effect(() => ctx.systemPrompt.section("instructions", () => `The user's instructions:\n${instructions}`, { order: SectionOrder.guidelines + 50 }), `${name}: instructions`);
  }

  ctx.effect(() => ctx.systemPrompt.section("context-files", ({ cwd }: PromptEnv) => {
    if (config.contextFiles === false) return undefined;
    const files = contextFiles(config.dataDir, cwd);
    if (files.length === 0) return undefined;
    return [
      "Project instructions from context files. Follow them; more specific (deeper) files win over general ones.",
      ...files.map((file) => `<context-file path="${file}">\n${readFileSync(file, "utf8").trim()}\n</context-file>`),
    ].join("\n\n");
  }, { order: SectionOrder.contextFiles }), `${name}: context-files`);

  ctx.effect(() => ctx.systemPrompt.section("skills", ({ cwd, tools }: PromptEnv) => {
    if (!tools.some((tool) => tool.name === "read")) return undefined;
    const disabled = readDisabledSkillKeys(config.dataDir);
    const skills = findSkills(skillDirs(config.dataDir, cwd), { disabled });
    if (skills.length === 0) return undefined;
    return [
      "Skills are instructions for specific tasks. When a task matches a skill's description, read its SKILL.md with the read tool before starting and follow it.",
      "<skills>",
      ...skills.map((skill) => `<skill name="${skill.name}" path="${skill.path}">${skill.description}</skill>`),
      "</skills>",
    ].join("\n");
  }, { order: SectionOrder.skills }), `${name}: skills`);

  ctx.effect(() => ctx.systemPrompt.section("environment", ({ cwd }: PromptEnv) => [
    "Environment:",
    `- Working directory: ${cwd}`,
    `- Platform: ${process.platform}`,
    `- Date: ${now().toISOString().slice(0, 10)}`,
  ].join("\n"), { order: SectionOrder.environment }), `${name}: environment`);

  ctx.inject(["commands"], (inner) => {
    inner.effect(() => inner.commands.registerProvider((cwd) => {
      const targetCwd = cwd && cwd.trim() !== "" ? cwd : process.cwd();
      const disabled = readDisabledSkillKeys(config.dataDir);
      return findSkills(skillDirs(config.dataDir, targetCwd), { disabled }).map((skill): CommandDefinition => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        argsHint: "[任务说明]",
        source: "skill",
        execute(rawArgs) {
          const suffix = rawArgs.trim() ? `\n\n用户任务：${rawArgs.trim()}` : "";
          return {
            prompt: `请先使用 \`read\` 工具阅读技能说明文件 \`${skill.path}\`（技能：${skill.name}），并严格遵循该技能的步骤完成工作。${suffix}`,
          };
        },
      }));
    }), `${name}: skill commands`);
  });

  ctx.inject(["rpc"], (rpcCtx) => {
    const { dataDir } = config;
    const notifyCommands = () => {
      rpcCtx.get("commands")?.notifyChanged("skills");
    };
    const methods: Record<string, (raw: unknown) => unknown> = {
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
        if (Buffer.byteLength(p.content, "utf8") > MAX_SKILL_BYTES) {
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
      rpcCtx.effect(() => rpcCtx.rpc.method(method, handler), `${name}: ${method}`);
    }
  });
}
