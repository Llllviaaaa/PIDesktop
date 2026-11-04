import type {
  McpGetPromptResult,
  McpPromptInfo,
  McpPromptsResult,
  McpReadResourceResult,
  McpResourceInfo,
  McpResourcesResult,
  McpServerStatus,
  McpStatusResult,
} from "@pid/protocol";
import { harnessRuntimes } from "./harnessRuntime";

export const mcpClient = {
  async status(): Promise<McpServerStatus[]> {
    const { servers } = await harnessRuntimes.call<McpStatusResult>("mcp.status");
    return servers;
  },

  async reconnect(serverId?: string): Promise<McpServerStatus[]> {
    const { servers } = await harnessRuntimes.call<McpStatusResult>(
      "mcp.reconnect",
      serverId ? { serverId } : {},
    );
    return servers;
  },

  async resources(serverId?: string): Promise<McpResourceInfo[]> {
    const { resources } = await harnessRuntimes.call<McpResourcesResult>(
      "mcp.resources",
      serverId ? { serverId } : {},
    );
    return resources;
  },

  readResource(serverId: string, uri: string): Promise<McpReadResourceResult> {
    return harnessRuntimes.call<McpReadResourceResult>("mcp.readResource", { serverId, uri });
  },

  async prompts(serverId?: string): Promise<McpPromptInfo[]> {
    const { prompts } = await harnessRuntimes.call<McpPromptsResult>(
      "mcp.prompts",
      serverId ? { serverId } : {},
    );
    return prompts;
  },

  getPrompt(serverId: string, name: string, args: Record<string, string> = {}): Promise<McpGetPromptResult> {
    return harnessRuntimes.call<McpGetPromptResult>("mcp.getPrompt", {
      serverId,
      name,
      arguments: args,
    });
  },
};
