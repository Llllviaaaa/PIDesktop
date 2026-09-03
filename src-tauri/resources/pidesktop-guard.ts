import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyDesktopToolDefaults,
  agentModeSystemInstructions,
  evaluateToolPermission,
  normalizeAgentMode,
  normalizePermissionMode,
  permissionForAgentMode,
  rulesFromEnv,
  type AgentMode,
  type PermissionMode,
} from "./pidesktop-rules.ts";
import {
  createWorkspaceCheckpoint,
  diffWorkspaceCheckpoint,
  isWorkspaceCheckpoint,
  PIDESKTOP_CHECKPOINT_TYPE,
  restoreWorkspaceCheckpoint,
  type WorkspaceCheckpoint,
} from "./pidesktop-checkpoints.ts";

export const PIDESKTOP_REWIND_COMMAND = "pidesktop-rewind";
export const PIDESKTOP_MODE_COMMAND = "pidesktop-mode";
export const PIDESKTOP_PERMISSION_COMMAND = "pidesktop-permission";
export const PIDESKTOP_RICH_CONTENT_INSTRUCTIONS = `PIDesktop can render one optional structured visual in a completed assistant reply. Use it only when metrics, comparisons, steps, progress, grouped status, or curated links are materially easier to scan than ordinary prose. Otherwise use normal Markdown. Emit at most one fenced block with the exact language pidesktop-rich and valid JSON in this schema:
{"version":1,"title"?:string,"summary"?:string,"blocks":[...]}
Allowed blocks are:
- {"type":"metrics","title"?:string,"items":[{"label":string,"value":string,"detail"?:string,"tone"?:Tone}]}
- {"type":"callout","title"?:string,"body":string,"tone"?:Tone}
- {"type":"steps","title"?:string,"items":[{"title":string,"description"?:string,"status"?:"done"|"active"|"pending"}]}
- {"type":"comparison","title"?:string,"columns":[string,...],"rows":[[string,...],...]}
- {"type":"progress","title"?:string,"items":[{"label":string,"value":number,"detail"?:string,"tone"?:Tone}]}, where value is 0..100
- {"type":"bars","title"?:string,"items":[{"label":string,"value":number,"max":number,"unit"?:string,"tone"?:Tone}]}, where 0 <= value <= max
- {"type":"links","title"?:string,"items":[{"label":string,"url":string,"description"?:string}]}, with absolute http/https URLs only
Limits: 1..12 blocks, 1..12 items in each grouped block, 60 items total, and comparison tables with 2..8 columns and at most 30 rows. Keep titles within 80 characters and descriptions or body text within 1000 characters.
Tone is "neutral"|"info"|"success"|"warning"|"danger". Do not add unknown fields, HTML, SVG, scripts, styles, class names, images, local paths, actions, forms, or nested components. Keep prose outside the fence for context and accessibility.`;

interface SessionEntryLike {
  type?: string;
  customType?: string;
  details?: unknown;
}

function checkpointForEntry(sessionManager: {
  getChildren?: (entryId: string) => SessionEntryLike[];
}, entryId: string): WorkspaceCheckpoint | null {
  const checkpointEntry = sessionManager.getChildren?.(entryId)
    .find((entry) => entry.type === "custom_message" && entry.customType === PIDESKTOP_CHECKPOINT_TYPE);
  return isWorkspaceCheckpoint(checkpointEntry?.details) ? checkpointEntry.details : null;
}

export default function (pi: ExtensionAPI) {
  let mode: PermissionMode = normalizePermissionMode(process.env.PIDESKTOP_PERMISSION_MODE);
  let agentMode: AgentMode = normalizeAgentMode(process.env.PIDESKTOP_AGENT_MODE);
  const workspace = process.env.PIDESKTOP_WORKSPACE_ROOT || process.cwd();
  const quickChat = process.env.PIDESKTOP_QUICK_CHAT === "1";
  const rules = rulesFromEnv({
    alwaysConfirmShell: process.env.PIDESKTOP_RULE_ALWAYS_CONFIRM_SHELL,
    blockWriteOutsideWorkspace: process.env.PIDESKTOP_RULE_BLOCK_OUTSIDE_WRITE,
    shellAllowPrefixes: process.env.PIDESKTOP_RULE_SHELL_ALLOWLIST,
    toolRulesEncoded: process.env.PIDESKTOP_TOOL_RULES_B64,
  });

  pi.registerCommand(PIDESKTOP_REWIND_COMMAND, {
    description: "PIDesktop internal message rewind",
    handler: async (args, ctx) => {
      const entryId = args.trim();
      if (!/^[A-Za-z0-9_-]+$/.test(entryId)) throw new Error("Invalid PIDesktop rewind entry ID");
      const entry = ctx.sessionManager.getEntry(entryId);
      if (entry?.type !== "message" || entry.message.role !== "user") {
        throw new Error("PIDesktop can only rewind to a user message");
      }
      const isActive = ctx.sessionManager.getBranch().some((item) => item.id === entryId);
      if (!isActive) throw new Error("PIDesktop can only rewind messages on the active branch");
      const checkpoint = checkpointForEntry(ctx.sessionManager, entryId);
      let rollback: WorkspaceCheckpoint | null = null;
      if (checkpoint) {
        const diff = await diffWorkspaceCheckpoint(checkpoint);
        if (diff.changed) {
          const fileSummary = diff.files.length > 0
            ? `${diff.files.length} 个文件将恢复到此消息发送前的状态。`
            : "Git 暂存区将恢复到此消息发送前的状态。";
          const confirmed = await ctx.ui.confirm(
            "回退消息和工作区？",
            `${fileSummary}\n\n此操作不会删除已有对话分支，你之后仍可从会话树切回。`,
          );
          if (!confirmed) throw new Error("PIDesktop message rewind was cancelled");
          rollback = await createWorkspaceCheckpoint(checkpoint.root);
          await restoreWorkspaceCheckpoint(checkpoint);
        }
      }
      const result = await ctx.navigateTree(entryId, { summarize: false });
      if (result.cancelled) {
        if (rollback) await restoreWorkspaceCheckpoint(rollback);
        throw new Error("PIDesktop message rewind was cancelled");
      }
    },
  });

  pi.registerCommand(PIDESKTOP_MODE_COMMAND, {
    description: "PIDesktop internal agent mode",
    handler: async (args) => {
      const requested = args.trim();
      if (!['agent', 'plan', 'ask'].includes(requested)) throw new Error("Invalid PIDesktop agent mode");
      agentMode = normalizeAgentMode(requested);
    },
  });

  pi.registerCommand(PIDESKTOP_PERMISSION_COMMAND, {
    description: "PIDesktop internal permission mode",
    handler: async (args) => {
      const requested = args.trim();
      if (!['read-only', 'ask', 'workspace-write', 'full-access'].includes(requested)) {
        throw new Error("Invalid PIDesktop permission mode");
      }
      mode = normalizePermissionMode(requested);
      process.env.PIDESKTOP_PERMISSION_MODE = mode;
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const instructions = [
      agentModeSystemInstructions(agentMode),
      ctx.hasUI ? PIDESKTOP_RICH_CONTENT_INSTRUCTIONS : "",
    ].filter(Boolean).join("\n\n");
    const checkpoint = permissionForAgentMode(agentMode, mode) === "read-only"
      ? null
      : await createWorkspaceCheckpoint(workspace);
    return {
      ...(checkpoint ? { message: {
        customType: PIDESKTOP_CHECKPOINT_TYPE,
        content: "",
        display: false,
        details: checkpoint,
      } } : {}),
      ...(instructions ? { systemPrompt: `${event.systemPrompt}\n\n${instructions}` } : {}),
    };
  });

  pi.on("model_select", async (event) => {
    if (event.source !== "set") return;
    const identity = {
      provider: event.model.provider,
      id: event.model.id,
      name: event.model.name || event.model.id,
    };
    pi.sendMessage({
      customType: "pidesktop-model-selection",
      content: `PIDesktop runtime metadata: the active model is now ${JSON.stringify(identity)}. This runtime metadata supersedes model-identity claims from earlier conversation turns. If asked which model is active, answer from this metadata.`,
      display: false,
      details: identity,
    });
  });

  pi.on("project_trust", async (event, ctx) => {
    if (!ctx.hasUI) return { trusted: "undecided" as const };
    const trusted = await ctx.ui.confirm(
      "Trust this workspace?",
      `${event.cwd}\n\nTrusting enables project-local Pi settings, extensions and skills.`,
    );
    return { trusted: trusted ? "yes" as const : "no" as const, remember: true };
  });

  pi.on("tool_call", async (event, ctx) => {
    applyDesktopToolDefaults(event.toolName, event.input as Record<string, unknown>);
    const decision = evaluateToolPermission({
      mode: permissionForAgentMode(agentMode, mode),
      rules,
      workspace,
      toolName: event.toolName,
      input: (event.input ?? {}) as Record<string, unknown>,
      quickChat,
    });

    if (decision.action === "allow") return;
    if (decision.action === "block") {
      return { block: true, reason: decision.reason };
    }

    if (!ctx.hasUI) {
      return { block: true, reason: "Confirmation required but no UI is available" };
    }

    const allowed = await ctx.ui.confirm(decision.title, decision.message);
    if (!allowed) {
      return { block: true, reason: `${decision.title} denied by user` };
    }
  });
}
