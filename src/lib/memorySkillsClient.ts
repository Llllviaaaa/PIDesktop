import type {
  MemoryExportResult,
  MemoryGetResult,
  MemoryScope,
  SkillCreateParams,
  SkillCreateResult,
  SkillInfo,
  SkillListResult,
  SkillReadResult,
} from "@pid/protocol";
import { harnessRuntimes, isRpcMethodNotFound } from "./harnessRuntime";

export const memorySkillsClient = {
  getMemory: async (scope: MemoryScope = "user", cwd?: string): Promise<MemoryGetResult> => {
    try {
      return await harnessRuntimes.call<MemoryGetResult>("memory.get", {
        scope,
        ...(cwd ? { cwd } : {}),
      });
    } catch (error) {
      if (isRpcMethodNotFound(error)) {
        return { scope, path: "", content: "", trusted: scope === "user" };
      }
      throw error;
    }
  },

  setMemory: (content: string, scope: MemoryScope = "user", cwd?: string): Promise<MemoryGetResult> =>
    harnessRuntimes.call<MemoryGetResult>("memory.set", {
      scope,
      content,
      ...(cwd ? { cwd } : {}),
    }),

  deleteMemory: async (scope: MemoryScope = "user", cwd?: string): Promise<void> => {
    await harnessRuntimes.call("memory.delete", {
      scope,
      ...(cwd ? { cwd } : {}),
    });
  },

  exportMemory: async (destination: string, scope: MemoryScope = "user", cwd?: string): Promise<string> => {
    const result = await harnessRuntimes.call<MemoryExportResult>("memory.export", {
      scope,
      destination,
      ...(cwd ? { cwd } : {}),
    });
    return result.path;
  },

  listSkills: async (cwd?: string): Promise<SkillInfo[]> => {
    try {
      const result = await harnessRuntimes.call<SkillListResult>("skill.list", cwd ? { cwd } : {});
      return result.skills;
    } catch (error) {
      if (isRpcMethodNotFound(error)) return [];
      throw error;
    }
  },

  readSkill: (path: string, cwd?: string): Promise<SkillReadResult> =>
    harnessRuntimes.call<SkillReadResult>("skill.read", {
      path,
      ...(cwd ? { cwd } : {}),
    }),

  createSkill: (params: SkillCreateParams): Promise<SkillCreateResult> =>
    harnessRuntimes.call<SkillCreateResult>("skill.create", { ...params }),

  saveSkill: async (path: string, content: string, cwd?: string): Promise<SkillInfo[]> => {
    const result = await harnessRuntimes.call<SkillListResult>("skill.save", {
      path,
      content,
      ...(cwd ? { cwd } : {}),
    });
    return result.skills;
  },

  toggleSkill: async (path: string, enabled: boolean, cwd?: string): Promise<SkillInfo[]> => {
    const result = await harnessRuntimes.call<SkillListResult>("skill.toggle", {
      path,
      enabled,
      ...(cwd ? { cwd } : {}),
    });
    return result.skills;
  },

  deleteSkill: async (path: string, cwd?: string): Promise<SkillInfo[]> => {
    const result = await harnessRuntimes.call<SkillListResult>("skill.delete", {
      path,
      ...(cwd ? { cwd } : {}),
    });
    return result.skills;
  },
};
