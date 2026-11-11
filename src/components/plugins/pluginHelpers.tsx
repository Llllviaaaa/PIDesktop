import type { McpServerStatus, PluginInfo } from "@qianji/protocol";
import {
  Blocks,
  BookMarked,
  Boxes,
  CalendarClock,
  ChartPie,
  Cpu,
  GitFork,
  Globe,
  ListChecks,
  Monitor,
  Package,
  RotateCcw,
  Shield,
  Sparkles,
  Terminal,
} from "lucide-react";
import { sameLocalPath } from "../../lib/pathIdentity";
import type { AppSettings, DesktopHookConfig } from "../../types";

export type PluginFilter = "all" | "builtin" | "user" | "workspace" | "skills";
export type Notice = { kind: "success" | "error"; text: string } | null;
export type OpChipTone = "neutral" | "accent" | "green" | "warn";

export interface OpChip {
  key: string;
  label: string;
  tone?: OpChipTone;
}

export interface McpPresetTemplate {
  id: string;
  name: string;
  badge: string;
  command: string;
  buildArgs: (cwd: string) => string[];
  trustedReadOnly?: boolean;
}

export const PILL_SPRING = { type: "spring" as const, stiffness: 520, damping: 38, mass: 0.7 };

export const CORE_EXTENSION_ORDER: readonly string[] = [
  "intelligent-ui",
  "mcp",
  "browser",
  "computer",
  "subagents",
  "plan",
  "memory",
  "schedule",
  "hooks",
  "sandbox",
];

export const CORE_EXTENSION_SET = new Set<string>(CORE_EXTENSION_ORDER);

export const MCP_PRESET_TEMPLATES: readonly McpPresetTemplate[] = [
  {
    id: "filesystem",
    name: "Filesystem 本地文件",
    badge: "+ 本地文件",
    command: "npx",
    buildArgs: (cwd) => ["-y", "@modelcontextprotocol/server-filesystem", cwd.trim() || "."],
  },
  {
    id: "playwright",
    name: "Playwright 浏览器",
    badge: "+ Playwright",
    command: "npx",
    buildArgs: () => ["-y", "@playwright/mcp@latest"],
  },
  {
    id: "memory-graph",
    name: "Memory 知识图谱",
    badge: "+ 知识图谱",
    command: "npx",
    buildArgs: () => ["-y", "@modelcontextprotocol/server-memory"],
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    badge: "+ 分步推理",
    command: "npx",
    buildArgs: () => ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    trustedReadOnly: true,
  },
  {
    id: "github",
    name: "GitHub 仓库协作",
    badge: "+ GitHub",
    command: "npx",
    buildArgs: () => ["-y", "@modelcontextprotocol/server-github"],
  },
];

export const HOOK_EVENT_LABELS: ReadonlyArray<{ id: DesktopHookConfig["event"]; label: string }> = [
  { id: "session_start", label: "会话启动 (session_start)" },
  { id: "before_agent_start", label: "推理开始前 (before_agent_start)" },
  { id: "tool_call", label: "工具调用前 (tool_call)" },
  { id: "tool_result", label: "工具返回后 (tool_result)" },
  { id: "agent_end", label: "单轮结束 (agent_end)" },
  { id: "agent_settled", label: "任务完成 (agent_settled)" },
];

export const PLUGIN_TO_APP_SETTING: Partial<Record<string, keyof AppSettings>> = {
  "intelligent-ui": "intelligentUiEnabled",
  plan: "planTrackingEnabled",
  mcp: "mcpEnabled",
  subagents: "subagentsEnabled",
  browser: "browserEnabled",
  computer: "computerEnabled",
  sandbox: "sandboxEnabled",
  memory: "memoryEnabled",
  hooks: "hooksEnabled",
};

export function cleanDisplayName(plugin: PluginInfo): string {
  const escapedId = plugin.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = plugin.name.replace(new RegExp(`\\s*[\\(（]${escapedId}[\\)）]\\s*$`, "i"), "").trim();
  return stripped || plugin.name;
}

export function shouldShowVersion(version: string, tier: PluginInfo["tier"]): boolean {
  if (tier === "builtin") return false;
  if (!version) return false;
  if (version.startsWith("0.0.0")) return false;
  return true;
}

export function iconAccentTone(id: string): string {
  if (id === "smart-rewind") return "violet";
  if (id === "session-usage") return "sky";
  if (id === "intelligent-ui") return "indigo";
  if (id === "mcp") return "blue";
  if (id === "browser") return "sky";
  if (id === "computer") return "slate";
  if (id === "subagents") return "violet";
  if (id === "plan") return "emerald";
  if (id === "memory") return "amber";
  if (id === "schedule") return "teal";
  if (id === "hooks") return "neutral";
  if (id === "sandbox") return "rose";
  return "neutral";
}

export function PluginCategoryIcon({ id, tier }: { id: string; tier: PluginInfo["tier"] }) {
  if (id === "smart-rewind") return <RotateCcw size={18} strokeWidth={1.8} />;
  if (id === "session-usage") return <ChartPie size={18} strokeWidth={1.8} />;
  if (id === "intelligent-ui") return <Sparkles size={18} strokeWidth={1.8} />;
  if (id === "mcp") return <Blocks size={18} strokeWidth={1.8} />;
  if (id === "browser") return <Globe size={18} strokeWidth={1.8} />;
  if (id === "computer") return <Monitor size={18} strokeWidth={1.8} />;
  if (id === "subagents") return <GitFork size={18} strokeWidth={1.8} />;
  if (id === "plan") return <ListChecks size={18} strokeWidth={1.8} />;
  if (id === "memory") return <BookMarked size={18} strokeWidth={1.8} />;
  if (id === "schedule") return <CalendarClock size={18} strokeWidth={1.8} />;
  if (id === "hooks") return <Terminal size={18} strokeWidth={1.8} />;
  if (id === "sandbox") return <Shield size={18} strokeWidth={1.8} />;
  if (id.startsWith("llm-") || id.includes("provider") || id === "pricing") return <Cpu size={17} strokeWidth={1.8} />;
  if (tier === "user" || tier === "workspace") return <Package size={18} strokeWidth={1.8} />;
  return <Boxes size={17} strokeWidth={1.8} />;
}

export function isLinkedLocalPlugin(plugin: PluginInfo): boolean {
  if (plugin.origin?.channel !== "local" || plugin.dir === undefined) return false;
  return sameLocalPath(plugin.dir, plugin.origin.spec);
}

export function originLabel(plugin: PluginInfo): string | null {
  const origin = plugin.origin;
  if (origin === undefined) return null;
  if (origin.channel === "local") return isLinkedLocalPlugin(plugin) ? "本地链接" : "本地目录";
  if (origin.channel === "archive") return "离线包";
  if (origin.channel === "git") return "Git 仓库";
  if (origin.channel === "npm") return "npm 包";
  return null;
}

export function canCheckUpdate(plugin: PluginInfo): boolean {
  if (plugin.tier !== "user" || plugin.origin === undefined) return false;
  if (plugin.origin.channel === "git" || plugin.origin.channel === "npm") return true;
  if (plugin.origin.channel === "local" && !isLinkedLocalPlugin(plugin)) return true;
  return false;
}

export function statusState(
  plugin: PluginInfo,
  clientError: string | undefined,
): { label: string; tone: "is-active" | "is-off" | "is-errored" | "is-pending" } {
  if (plugin.status === "errored" || clientError !== undefined) {
    return { label: "运行异常", tone: "is-errored" };
  }
  if (plugin.status === "untrusted") return { label: "待信任", tone: "is-pending" };
  if (plugin.status === "pending") return { label: "待就绪", tone: "is-pending" };
  if (plugin.status === "active") return { label: "运行中", tone: "is-active" };
  return { label: "已停用", tone: "is-off" };
}

export function coreOperationalChips(
  plugin: PluginInfo,
  form: AppSettings | undefined,
  mcpStatuses: readonly McpServerStatus[],
): OpChip[] {
  if (plugin.tier !== "builtin" || !CORE_EXTENSION_SET.has(plugin.id)) return [];

  switch (plugin.id) {
    case "intelligent-ui":
      return [
        { key: "tools", label: "render_ui · update_ui", tone: "accent" },
        { key: "sandbox", label: "沙箱化富交互视图" },
      ];
    case "mcp": {
      const configured = form?.mcpServers ?? [];
      const enabledServers = configured.filter((s) => s.enabled);
      const connectedCount = mcpStatuses.filter((s) => s.connected).length;
      const erroredCount = mcpStatuses.filter((s) => !s.connected && Boolean(s.error)).length;
      const totalTools = mcpStatuses.reduce((sum, s) => sum + (s.toolCount || 0), 0);
      if (configured.length === 0 && mcpStatuses.length === 0) {
        return [
          { key: "empty", label: "暂未挂载服务 · 点击「配置」接入" },
          ...(form?.mcpConfirmTools !== false ? [{ key: "confirm", label: "调用前确认" }] : []),
        ];
      }
      const chips: OpChip[] = [
        {
          key: "conn",
          label: `${connectedCount}/${Math.max(enabledServers.length, mcpStatuses.length)} 在线`,
          tone: erroredCount > 0 ? "warn" : connectedCount > 0 ? "green" : "neutral",
        },
      ];
      if (totalTools > 0) chips.push({ key: "tools", label: `${totalTools} 个工具`, tone: "accent" });
      if (erroredCount > 0) chips.push({ key: "err", label: `${erroredCount} 异常`, tone: "warn" });
      return chips;
    }
    case "browser":
      return [
        { key: "headless", label: form?.browserHeadless !== false ? "无头静默" : "可视窗口" },
        { key: "profile", label: form?.browserProfileMode === "persistent" ? "持久化登录态" : "临时隔离会话" },
      ];
    case "computer":
      return [{ key: "confirm", label: form?.computerConfirmActions !== false ? "点击键入需确认" : "免确认直控" }];
    case "subagents": {
      const cap = Math.min(4, Math.max(1, form?.subagentMaxConcurrency ?? 3));
      return [
        { key: "concurrency", label: `最大并发 ${cap}`, tone: "accent" },
        { key: "iso", label: "独立上下文并行" },
      ];
    }
    case "plan":
      return [{ key: "plan", label: "结构化步骤看板" }];
    case "memory":
      return [{
        key: "mem",
        label: `${form?.memoryEnabled !== false ? "全局记忆" : "全局已关"} · ${form?.projectMemoryEnabled !== false ? "项目记忆" : "项目已关"}`,
      }];
    case "schedule":
      return [{ key: "cron", label: "Cron 周期任务 · 延时唤醒" }];
    case "hooks": {
      const activeHooks = (form?.hooks ?? []).filter((h) => h.enabled).length;
      return [{
        key: "hooks",
        label: activeHooks > 0 ? `${activeHooks} 个生效钩子` : "支持生命周期脚本拦截",
        tone: activeHooks > 0 ? "accent" : "neutral",
      }];
    }
    case "sandbox":
      return [
        {
          key: "write",
          label: form?.blockWriteOutsideWorkspace !== false ? "工作区外写保护" : "允许跨目录写入",
          tone: form?.blockWriteOutsideWorkspace !== false ? "green" : "warn",
        },
        { key: "shell", label: form?.alwaysConfirmShell !== false ? "Shell 需确认" : "Shell 自动放行" },
      ];
    default:
      return [];
  }
}

export function parseShellArgLine(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

export function parseKeyValuePairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(/[\n,;]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}
