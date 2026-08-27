import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { normalizePermissionMode, shouldConfirmInteractiveAction } from "./pidesktop-rules.ts";

type ComputerAction =
  | "screenshot"
  | "list_windows"
  | "focus_window"
  | "move"
  | "click"
  | "double_click"
  | "drag"
  | "scroll"
  | "type"
  | "key"
  | "keypress"
  | "wait";

interface ScreenshotResult {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  left: number;
  top: number;
}

interface WindowInfo {
  title: string;
  handle: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowsResult {
  windows: WindowInfo[];
}

interface HelperError {
  ok: false;
  error: string;
}

async function runHelper<T>(payload: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
  if (process.platform !== "win32") throw new Error("Computer Use currently supports Windows only");
  const helper = process.env.PIDESKTOP_COMPUTER_HELPER;
  if (!helper) throw new Error("Pi Desktop did not provide its computer helper path");

  return new Promise<T>((resolve, reject) => {
    const child = spawn(helper, ["--computer-helper"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value as T);
    };
    const abort = () => {
      child.kill();
      finish(new Error("Computer action cancelled"));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Computer action timed out"));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 32 * 1024 * 1024) abort();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!line) return finish(new Error(stderr.trim() || `Computer helper exited with code ${code}`));
      try {
        const result = JSON.parse(line) as T | HelperError;
        if (typeof result === "object" && result && "ok" in result && result.ok === false) {
          return finish(new Error(result.error));
        }
        if (code !== 0) return finish(new Error(stderr.trim() || `Computer helper exited with code ${code}`));
        finish(undefined, result as T);
      } catch {
        finish(new Error(`Could not parse computer helper result: ${line.slice(0, 500)}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function captureScreen(signal?: AbortSignal, windowTitle?: string): Promise<ScreenshotResult> {
  return runHelper<ScreenshotResult>({ action: "screenshot", windowTitle }, signal);
}

async function listWindows(signal?: AbortSignal): Promise<WindowInfo[]> {
  return (await runHelper<WindowsResult>({ action: "list_windows" }, signal)).windows;
}

function screenshotContent(capture: ScreenshotResult, label: string) {
  return [
    { type: "text" as const, text: `${label}\n虚拟桌面：${capture.width}×${capture.height}\n原点：(${capture.left}, ${capture.top})` },
    { type: "image" as const, data: capture.data, mimeType: capture.mimeType },
  ];
}

function actionSummary(action: ComputerAction, params: Record<string, unknown>): string {
  if (action === "move") return `将指针移动到 (${params.x}, ${params.y})`;
  if (action === "click" || action === "double_click") return `在 (${params.x}, ${params.y}) ${params.button || "left"} ${action === "double_click" ? "双击" : "单击"}`;
  if (action === "drag") return `从 (${params.x}, ${params.y}) 拖动到 (${params.endX}, ${params.endY})`;
  if (action === "scroll") return `滚动 (${params.deltaX || 0}, ${params.deltaY || 0})`;
  if (action === "type") return `向当前窗口输入 ${String(params.text || "").length} 个字符`;
  if (action === "key" || action === "keypress") return `按下 ${params.key}`;
  if (action === "focus_window") return `切换到标题包含“${params.windowTitle}”的窗口`;
  return action;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
  const confirmActions = process.env.PIDESKTOP_COMPUTER_CONFIRM !== "0";

  pi.registerTool({
    name: "computer",
    label: "Computer",
    description: "Inspect and control the Windows desktop with screenshots, window discovery, pointer movement, clicks, drag, scroll, typing, keypresses, and waits. Every action returns an updated screenshot.",
    promptSnippet: "Inspect and, with approval, control Windows applications using screenshot-feedback actions",
    promptGuidelines: [
      "Use computer screenshot before coordinate-based actions and use the returned virtual-screen origin and dimensions when choosing coordinates.",
      "Use computer list_windows before focus_window when the target window title is uncertain.",
      "Never type passwords, API keys, payment data, or other secrets with computer unless the user explicitly provides and authorizes that exact input.",
    ],
    parameters: Type.Object({
      action: StringEnum(["screenshot", "list_windows", "focus_window", "move", "click", "double_click", "drag", "scroll", "type", "key", "keypress", "wait"] as const),
      x: Type.Optional(Type.Integer({ description: "Virtual-screen X coordinate for click" })),
      y: Type.Optional(Type.Integer({ description: "Virtual-screen Y coordinate for click" })),
      endX: Type.Optional(Type.Integer({ description: "Virtual-screen destination X coordinate for drag" })),
      endY: Type.Optional(Type.Integer({ description: "Virtual-screen destination Y coordinate for drag" })),
      deltaX: Type.Optional(Type.Integer({ minimum: -12000, maximum: 12000, description: "Horizontal scroll amount; positive scrolls right" })),
      deltaY: Type.Optional(Type.Integer({ minimum: -12000, maximum: 12000, description: "Vertical scroll amount; positive scrolls down" })),
      durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000, description: "Duration for drag or wait" })),
      button: Type.Optional(StringEnum(["left", "right", "middle"] as const)),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })),
      text: Type.Optional(Type.String({ description: "Text to enter into the focused control" })),
      key: Type.Optional(Type.String({ description: "Key or combination such as ENTER, CTRL+L, or ALT+F4" })),
      windowTitle: Type.Optional(Type.String({ description: "Case-insensitive title fragment for focus_window or a window-scoped screenshot" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action as ComputerAction;
      const interactive = ["focus_window", "move", "click", "double_click", "drag", "scroll", "type", "key", "keypress"].includes(action);
      const permissionMode = normalizePermissionMode(process.env.PIDESKTOP_PERMISSION_MODE);
      signal?.throwIfAborted();
      if (interactive && permissionMode === "read-only") {
        throw new Error("只读模式下已禁用交互式计算机操作");
      }
      if (interactive && shouldConfirmInteractiveAction(permissionMode, confirmActions)) {
        const allowed = await ctx.ui.confirm("允许计算机操作？", actionSummary(action, params));
        if (!allowed) throw new Error("用户拒绝了计算机操作");
      }
      onUpdate?.({ content: [{ type: "text", text: `计算机：${action}…` }], details: { action } });

      if (action === "list_windows") {
        const windows = await listWindows(signal);
        const text = windows.length
          ? windows.slice(0, 80).map((window, index) => `[${index + 1}] ${window.title} — (${window.x}, ${window.y}) ${window.width}×${window.height}`).join("\n")
          : "没有找到可见的顶层窗口。";
        return { content: [{ type: "text", text }], details: { action, windows } };
      }

      if (action === "wait") {
        await delay(Math.min(30_000, Math.max(0, params.durationMs ?? 1_000)));
      } else if (action === "focus_window") {
        if (!params.windowTitle) throw new Error("focus_window 需要 windowTitle");
        await runHelper({ action, windowTitle: params.windowTitle }, signal);
      } else if (action === "move") {
        if (!Number.isInteger(params.x) || !Number.isInteger(params.y)) throw new Error("move 需要整数 x 和 y 坐标");
        await runHelper({ action, x: params.x, y: params.y }, signal);
      } else if (action === "click" || action === "double_click") {
        if (!Number.isInteger(params.x) || !Number.isInteger(params.y)) throw new Error("click 需要整数 x 和 y 坐标");
        await runHelper({ action, x: params.x, y: params.y, button: params.button || "left", count: params.count || 1 }, signal);
      } else if (action === "drag") {
        if (![params.x, params.y, params.endX, params.endY].every(Number.isInteger)) throw new Error("drag 需要整数 x、y、endX 和 endY 坐标");
        await runHelper({ action, x: params.x, y: params.y, endX: params.endX, endY: params.endY, durationMs: params.durationMs ?? 500 }, signal);
      } else if (action === "scroll") {
        if ((params.x === undefined) !== (params.y === undefined)) throw new Error("scroll 定位时需要同时提供 x 和 y");
        if (params.x !== undefined && (!Number.isInteger(params.x) || !Number.isInteger(params.y))) throw new Error("scroll 的 x 和 y 必须是整数");
        if (!params.deltaX && !params.deltaY) throw new Error("scroll 需要非零 deltaX 或 deltaY");
        await runHelper({ action, x: params.x, y: params.y, deltaX: params.deltaX || 0, deltaY: params.deltaY || 0 }, signal);
      } else if (action === "type") {
        if (typeof params.text !== "string") throw new Error("type 需要 text");
        await runHelper({ action, text: params.text }, signal);
      } else if (action === "key" || action === "keypress") {
        if (!params.key) throw new Error("key 需要按键或组合键");
        await runHelper({ action, key: params.key }, signal);
      }

      if (action !== "screenshot" && action !== "wait") await delay(250);
      const capture = await captureScreen(signal, action === "screenshot" ? params.windowTitle : undefined);
      ctx.ui.setStatus("pidesktop-computer", `桌面 ${capture.width}×${capture.height}`);
      return {
        content: screenshotContent(capture, action === "screenshot" ? "Windows 桌面截图" : `计算机操作已完成：${action}`),
        details: { action, width: capture.width, height: capture.height, left: capture.left, top: capture.top },
      };
    },
  });

  pi.registerCommand("computer-diagnose", {
    description: "验证 Windows 截图和窗口读取能力（不会点击或输入）",
    handler: async (_args, ctx) => {
      try {
        const [capture, windows] = await Promise.all([captureScreen(), listWindows()]);
        ctx.ui.notify(
          `计算机检查通过：${capture.width}×${capture.height}，PNG ${Math.round(capture.data.length * 0.75 / 1024)} KB，可见窗口 ${windows.length} 个`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`计算机检查失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
