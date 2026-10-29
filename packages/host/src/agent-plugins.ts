/**
 * The plugins that make up the agent, shared by the RPC host and headless
 * runs: models, sessions on disk, tools, the system prompt, the loop, and the
 * feature plugins configured by `<dataDir>/harness.json`.
 */
import { join } from "node:path";
import { AgentLoop } from "@pid/agent-loop";
import * as checkpoints from "@pid/checkpoints";
import * as computer from "@pid/computer";
import * as hooks from "@pid/hooks";
import { Credentials, LlmService } from "@pid/llm";
import { Mcp } from "@pid/mcp";
import * as memory from "@pid/memory";
import { Permissions, type PermissionMode } from "@pid/permissions";
import * as plan from "@pid/plan";
import * as promptContext from "@pid/prompt-context";
import { Schedule } from "@pid/schedule";
import { Sessions } from "@pid/session";
import * as subagents from "@pid/subagents";
import * as sessionJsonl from "@pid/session-jsonl";
import { SystemPrompt } from "@pid/system-prompt";
import * as toolBash from "@pid/tool-bash";
import * as toolFs from "@pid/tool-fs";
import { Tools } from "@pid/tools";
import { Ui } from "@pid/ui";
import type { HarnessConfig } from "./harness-config.ts";
import type { PluginEntry } from "./host.ts";
import * as providers from "./providers.ts";

export interface AgentPluginOptions {
  config: HarnessConfig;
  /** Overrides the configured default permission mode (headless `--permission`). */
  permission?: PermissionMode;
  /** Run scheduled tasks: only the long-running host does, never a headless run. */
  scheduler?: { defaultModel?: { provider: string; model: string } };
  /** Where the computer helper is when harness.json does not say (`PID_COMPUTER_HELPER`). */
  computerHelper?: string;
}

export function agentPlugins(dataDir: string, options: AgentPluginOptions): PluginEntry[] {
  const { config } = options;
  const permissions = options.permission === undefined ? config.permissions : { ...config.permissions, defaultPermission: options.permission };
  return [
    [Credentials],
    [LlmService],
    [providers, { file: join(dataDir, "providers.json") }],
    [Sessions],
    [sessionJsonl, { dir: join(dataDir, "sessions") }],
    [Ui],
    [Tools],
    [SystemPrompt],
    [Permissions, permissions],
    [toolFs],
    [toolBash],
    [promptContext, { dataDir }],
    ...(config.plan.enabled ? [[plan] as PluginEntry] : []),
    ...(config.memory.enabled ? [[memory, { file: join(dataDir, "memory.md") }] as PluginEntry] : []),
    [AgentLoop],
    ...(config.subagents.enabled ? [[subagents, config.subagents] as PluginEntry] : []),
    [Mcp, config.mcp],
    ...(config.computer.enabled
      ? [[computer, { ...config.computer, helper: config.computer.helper ?? options.computerHelper }] as PluginEntry]
      : []),
    [checkpoints],
    [hooks, config.hooks],
    ...(options.scheduler !== undefined && config.schedule.enabled
      ? [[Schedule, {
        tasksFile: join(dataDir, "schedules.json"),
        runsFile: join(dataDir, "schedule-runs.jsonl"),
        ...(options.scheduler.defaultModel === undefined ? {} : { defaultModel: options.scheduler.defaultModel }),
      }] as PluginEntry]
      : []),
  ];
}
