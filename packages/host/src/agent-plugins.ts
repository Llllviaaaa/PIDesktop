/**
 * The plugins that make up the agent, shared by the RPC host and headless
 * runs: models, sessions on disk, tools, the system prompt and the loop.
 */
import { join } from "node:path";
import { AgentLoop } from "@pid/agent-loop";
import { Credentials, LlmService } from "@pid/llm";
import * as promptContext from "@pid/prompt-context";
import { Sessions } from "@pid/session";
import * as sessionJsonl from "@pid/session-jsonl";
import { SystemPrompt } from "@pid/system-prompt";
import * as toolBash from "@pid/tool-bash";
import * as toolFs from "@pid/tool-fs";
import { Tools } from "@pid/tools";
import type { PluginEntry } from "./host.ts";
import * as providers from "./providers.ts";

export function agentPlugins(dataDir: string): PluginEntry[] {
  return [
    [Credentials],
    [LlmService],
    [providers, { file: join(dataDir, "providers.json") }],
    [Sessions],
    [sessionJsonl, { dir: join(dataDir, "sessions") }],
    [Tools],
    [toolFs],
    [toolBash],
    [SystemPrompt],
    [promptContext, { dataDir }],
    [AgentLoop],
  ];
}
