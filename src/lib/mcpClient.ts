import type {
  McpGetPromptResult,
  McpPromptInfo,
  McpPromptsResult,
  McpReadResourceResult,
  McpResourceInfo,
  McpResourcesResult,
  McpServerStatus,
  McpStatusResult,
} from "@qianji/protocol";
import { harnessRuntimes, isRpcMethodNotFound } from "./harnessRuntime";

export const mcpClient = {
  async status(): Promise<McpServerStatus[]> {
    try {
      const { servers } = await harnessRuntimes.call<McpStatusResult>("mcp.status");
      return servers;
    } catch (error) {
      if (isRpcMethodNotFound(error)) return [];
      throw error;
    }
  },

  async reconnect(serverId?: string): Promise<McpServerStatus[]> {
    try {
      const { servers } = await harnessRuntimes.call<McpStatusResult>(
        "mcp.reconnect",
        serverId ? { serverId } : {},
      );
      return servers;
    } catch (error) {
      if (isRpcMethodNotFound(error)) return [];
      throw error;
    }
  },

  async resources(serverId?: string): Promise<McpResourceInfo[]> {
    try {
      const { resources } = await harnessRuntimes.call<McpResourcesResult>(
        "mcp.resources",
        serverId ? { serverId } : {},
      );
      return resources;
    } catch (error) {
      if (isRpcMethodNotFound(error)) return [];
      throw error;
    }
  },

  readResource(serverId: string, uri: string): Promise<McpReadResourceResult> {
    return harnessRuntimes.call<McpReadResourceResult>("mcp.readResource", { serverId, uri });
  },

  async prompts(serverId?: string): Promise<McpPromptInfo[]> {
    try {
      const { prompts } = await harnessRuntimes.call<McpPromptsResult>(
        "mcp.prompts",
        serverId ? { serverId } : {},
      );
      return prompts;
    } catch (error) {
      if (isRpcMethodNotFound(error)) return [];
      throw error;
    }
  },

  getPrompt(serverId: string, name: string, args: Record<string, string> = {}): Promise<McpGetPromptResult> {
    return harnessRuntimes.call<McpGetPromptResult>("mcp.getPrompt", {
      serverId,
      name,
      arguments: args,
    });
  },
};
