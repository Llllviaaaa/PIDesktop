import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  evaluateToolPermission,
  rulesFromEnv,
  type PermissionMode,
} from "./pidesktop-rules.ts";

export default function (pi: ExtensionAPI) {
  const mode = (process.env.PIDESKTOP_PERMISSION_MODE || "ask") as PermissionMode;
  const workspace = process.env.PIDESKTOP_WORKSPACE_ROOT || process.cwd();
  const quickChat = process.env.PIDESKTOP_QUICK_CHAT === "1";
  const rules = rulesFromEnv({
    alwaysConfirmShell: process.env.PIDESKTOP_RULE_ALWAYS_CONFIRM_SHELL,
    blockWriteOutsideWorkspace: process.env.PIDESKTOP_RULE_BLOCK_OUTSIDE_WRITE,
    shellAllowPrefixes: process.env.PIDESKTOP_RULE_SHELL_ALLOWLIST,
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
    const decision = evaluateToolPermission({
      mode,
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
