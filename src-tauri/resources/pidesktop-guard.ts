import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PermissionMode = "read-only" | "ask" | "workspace-write" | "full-access";

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function insideWorkspace(path: string, workspace: string): boolean {
  const candidate = normalize(path);
  const root = normalize(workspace);
  return candidate === root || candidate.startsWith(`${root}/`);
}

function pathFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file", "filePath", "target"]) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  const mode = (process.env.PIDESKTOP_PERMISSION_MODE || "ask") as PermissionMode;
  const workspace = process.env.PIDESKTOP_WORKSPACE_ROOT || process.cwd();
  const quickChat = process.env.PIDESKTOP_QUICK_CHAT === "1";

  pi.on("project_trust", async (event, ctx) => {
    if (!ctx.hasUI) return { trusted: "undecided" as const };
    const trusted = await ctx.ui.confirm(
      "Trust this workspace?",
      `${event.cwd}\n\nTrusting enables project-local Pi settings, extensions and skills.`,
    );
    return { trusted: trusted ? "yes" as const : "no" as const, remember: true };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (mode === "full-access") return;

    const tool = event.toolName.toLowerCase();
    const input = event.input as Record<string, unknown>;
    const isWrite = tool === "write" || tool === "edit" || tool === "apply_patch";
    const isShell = tool === "bash" || tool === "shell" || tool === "exec";
    const target = pathFromInput(input);

    if (quickChat && ["read", "write", "edit", "apply_patch", "grep", "find", "bash", "shell", "exec"].includes(tool)) {
      return { block: true, reason: "Quick chat does not use local project files or shell commands" };
    }

    if (mode === "read-only" && (isWrite || isShell)) {
      return { block: true, reason: "Pi Desktop is in read-only mode" };
    }

    if (isWrite && target && !insideWorkspace(target, workspace)) {
      const allowed = await ctx.ui.confirm(
        "Write outside workspace?",
        `${tool}: ${target}\n\nWorkspace: ${workspace}`,
      );
      if (!allowed) return { block: true, reason: "Write outside workspace denied by user" };
      return;
    }

    if (mode === "ask" && isWrite) {
      const allowed = await ctx.ui.confirm(
        "Allow file change?",
        `${tool}: ${target || JSON.stringify(input)}`,
      );
      if (!allowed) return { block: true, reason: "File change denied by user" };
      return;
    }

    if (isShell) {
      const command = typeof input.command === "string" ? input.command : JSON.stringify(input);
      const allowed = await ctx.ui.confirm("Allow command?", command);
      if (!allowed) return { block: true, reason: "Command denied by user" };
    }
  });
}
