import type {
  SkillCreateParams,
  SkillCreateResult,
  SkillDeleteParams,
  SkillInfo,
  SkillListResult,
  SkillReadParams,
  SkillReadResult,
  SkillSaveParams,
  SkillToggleParams,
} from "@qianji/protocol";
import { harnessRuntimes } from "./harnessRuntime";

function withCwd<T extends { cwd?: string }>(params: T): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params };
  const raw = typeof params.cwd === "string" ? params.cwd.trim() : "";
  if (raw !== "") next.cwd = raw;
  else delete next.cwd;
  return next;
}

export const skillClient = {
  async list(cwd?: string): Promise<SkillInfo[]> {
    const { skills } = await harnessRuntimes.call<SkillListResult>(
      "skill.list",
      withCwd({ cwd }),
    );
    return skills;
  },

  read(params: SkillReadParams): Promise<SkillReadResult> {
    return harnessRuntimes.call<SkillReadResult>("skill.read", withCwd(params));
  },

  create(params: SkillCreateParams): Promise<SkillCreateResult> {
    return harnessRuntimes.call<SkillCreateResult>("skill.create", withCwd(params));
  },

  save(params: SkillSaveParams): Promise<SkillListResult> {
    return harnessRuntimes.call<SkillListResult>("skill.save", withCwd(params));
  },

  toggle(params: SkillToggleParams): Promise<SkillListResult> {
    return harnessRuntimes.call<SkillListResult>("skill.toggle", withCwd(params));
  },

  delete(params: SkillDeleteParams): Promise<SkillListResult> {
    return harnessRuntimes.call<SkillListResult>("skill.delete", withCwd(params));
  },
};
