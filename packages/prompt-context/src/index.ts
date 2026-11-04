/**
 * The built-in system prompt sections: who the agent is, how it works,
 * the project's context files (AGENTS.md, else CLAUDE.md), the available
 * skills (`<dir>/<skill>/SKILL.md`) and the environment.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { CommandDefinition } from "@pid/commands";
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
}
