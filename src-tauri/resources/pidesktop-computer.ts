import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { normalizePermissionMode, shouldConfirmInteractiveAction } from "./pidesktop-rules.ts";

type AtomicComputerAction =
  | "focus_window"
  | "move"
  | "click"
  | "double_click"
  | "drag"
  | "scroll"
  | "type"
  | "key"
  | "keypress"
  | "invoke"
  | "set_value"
  | "toggle"
  | "select"
  | "focus_element"
  | "scroll_element"
  | "wait";

type ComputerAction =
  | "screenshot"
  | "observe"
  | "list_windows"
  | "batch"
  | AtomicComputerAction;

interface BatchAction {
  action: AtomicComputerAction;
  x?: number;
  y?: number;
  endX?: number;
  endY?: number;
  deltaX?: number;
  deltaY?: number;
  durationMs?: number;
  button?: "left" | "right" | "middle";
  count?: number;
  text?: string;
  key?: string;
  windowTitle?: string;
  ref?: string;
  coordinateSpace?: "image" | "screen";
}

interface ScreenshotResult {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  left: number;
  top: number;
  imageWidth: number;
  imageHeight: number;
  scaleX: number;
  scaleY: number;
  captureBackend: string;
  frameId: string;
  captureFallback?: string;
}

interface ElementInfo {
  ref: string;
  role: string;
  name: string;
  value?: string;
  bounds: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  focused: boolean;
  focusable: boolean;
  patterns: string[];
}

interface ObservationResult {
  elements: ElementInfo[];
  windowTitle: string;
  windowHandle: string;
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

let lastCapture: ScreenshotResult | undefined;

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
  lastCapture = await runHelper<ScreenshotResult>({ action: "screenshot", windowTitle }, signal);
  return lastCapture;
}

async function listWindows(signal?: AbortSignal): Promise<WindowInfo[]> {
  return (await runHelper<WindowsResult>({ action: "list_windows" }, signal)).windows;
}

async function observeElements(signal?: AbortSignal, windowTitle?: string, maxElements = 200): Promise<ObservationResult> {
  return runHelper<ObservationResult>({ action: "observe", windowTitle, maxElements }, signal);
}

function elementMap(elements: ElementInfo[]): string {
  if (!elements.length) return "UI Automation：当前窗口没有暴露可操作元素；请改用截图坐标。";
  const rows = elements.slice(0, 100).map((element) => {
    const name = (element.name || element.value || "未命名").replace(/\s+/g, " ").slice(0, 160);
    const patterns = element.patterns.length ? ` actions=${element.patterns.join(",")}` : "";
    const focus = element.focused ? " focused" : "";
    const disabled = element.enabled ? "" : " disabled";
    return `${element.ref} ${element.role} “${name}” bounds=(${element.bounds.x},${element.bounds.y},${element.bounds.width},${element.bounds.height})${patterns}${focus}${disabled}`;
  });
  if (elements.length > rows.length) rows.push(`…另有 ${elements.length - rows.length} 个元素未展开，可提高 maxElements 后重新 observe。`);
  return `UI Automation 元素（优先使用 ref 动作）：\n${rows.join("\n")}`;
}

function screenshotContent(capture: ScreenshotResult, label: string, observation?: ObservationResult) {
  const mapping = capture.imageWidth === capture.width && capture.imageHeight === capture.height
    ? "截图坐标与屏幕坐标一致"
    : `截图：${capture.imageWidth}×${capture.imageHeight}；截图坐标映射到屏幕时 x×${capture.scaleX.toFixed(4)}、y×${capture.scaleY.toFixed(4)}`;
  const text = [
    label,
    `捕获区域：${capture.width}×${capture.height}，原点 (${capture.left}, ${capture.top})；${mapping}`,
    `捕获后端：${capture.captureBackend}；帧 ${capture.frameId}`,
    capture.captureFallback ? `捕获回退：${capture.captureFallback}` : "",
    observation ? `目标窗口：${observation.windowTitle || "未命名"} (${observation.windowHandle})` : "",
    observation ? elementMap(observation.elements) : "",
  ].filter(Boolean).join("\n");
  return [
    { type: "text" as const, text },
    { type: "image" as const, data: capture.data, mimeType: capture.mimeType },
  ];
}

function actionSummary(action: ComputerAction, params: Record<string, unknown>): string {
  if (action === "move") return `将指针移动到 (${params.x}, ${params.y})`;
  if (action === "click" || action === "double_click") return `在 (${params.x}, ${params.y}) ${params.button || "left"} ${action === "double_click" ? "双击" : "单击"}`;
  if (action === "drag") return `从 (${params.x}, ${params.y}) 拖动到 (${params.endX}, ${params.endY})`;
  if (action === "scroll") return `滚动 (${params.deltaX || 0}, ${params.deltaY || 0})`;
  if (action === "type") return `向当前窗口输入 ${String(params.text || "").length} 个字符`;
  if (action === "set_value") return `设置 UI 元素 ${params.ref} 的值（${String(params.text || "").length} 个字符）`;
  if (["invoke", "toggle", "select", "focus_element", "scroll_element"].includes(action)) return `${action} UI 元素 ${params.ref}`;
  if (action === "key" || action === "keypress") return `按下 ${params.key}`;
  if (action === "focus_window") return `切换到标题包含“${params.windowTitle}”的窗口`;
  if (action === "batch") return `连续执行 ${Array.isArray(params.actions) ? params.actions.length : 0} 个桌面动作`;
  return action;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInteractiveAction(action: ComputerAction): boolean {
  return !["screenshot", "observe", "list_windows", "wait"].includes(action);
}

function requiresConfirmation(action: ComputerAction): boolean {
  return ["click", "double_click", "drag", "type", "key", "keypress", "invoke", "set_value", "toggle", "select"].includes(action);
}

function imagePoint(x: unknown, y: unknown, coordinateSpace: unknown): { x: number; y: number } {
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error("坐标必须是整数");
  if (coordinateSpace === "screen") return { x: x as number, y: y as number };
  if (!lastCapture) throw new Error("使用截图坐标前需要先 screenshot 或 observe");
  if ((x as number) < 0 || (y as number) < 0 || (x as number) >= lastCapture.imageWidth || (y as number) >= lastCapture.imageHeight) {
    throw new Error(`截图坐标超出 ${lastCapture.imageWidth}×${lastCapture.imageHeight} 范围`);
  }
  return {
    x: lastCapture.left + Math.round((x as number) * lastCapture.scaleX),
    y: lastCapture.top + Math.round((y as number) * lastCapture.scaleY),
  };
}

function atomicPayload(action: BatchAction, defaultCoordinateSpace: "image" | "screen" = "image"): Record<string, unknown> {
  const coordinateSpace = action.coordinateSpace || defaultCoordinateSpace;
  if (action.action === "wait") {
    return { action: action.action, durationMs: Math.min(30_000, Math.max(0, action.durationMs ?? 1_000)) };
  }
  if (action.action === "focus_window") {
    if (!action.windowTitle) throw new Error("focus_window 需要 windowTitle");
    return { action: action.action, windowTitle: action.windowTitle };
  }
  if (action.action === "move" || action.action === "click" || action.action === "double_click") {
    const point = imagePoint(action.x, action.y, coordinateSpace);
    return { action: action.action, ...point, button: action.button || "left", count: action.count || 1 };
  }
  if (action.action === "drag") {
    const start = imagePoint(action.x, action.y, coordinateSpace);
    const end = imagePoint(action.endX, action.endY, coordinateSpace);
    return { action: action.action, x: start.x, y: start.y, endX: end.x, endY: end.y, durationMs: action.durationMs ?? 500 };
  }
  if (action.action === "scroll") {
    if ((action.x === undefined) !== (action.y === undefined)) throw new Error("scroll 定位时需要同时提供 x 和 y");
    const point = action.x === undefined ? {} : imagePoint(action.x, action.y, coordinateSpace);
    if (!action.deltaX && !action.deltaY) throw new Error("scroll 需要非零 deltaX 或 deltaY");
    return { action: action.action, ...point, deltaX: action.deltaX || 0, deltaY: action.deltaY || 0 };
  }
  if (action.action === "type") {
    if (typeof action.text !== "string") throw new Error("type 需要 text");
    return { action: action.action, text: action.text };
  }
  if (action.action === "key" || action.action === "keypress") {
    if (!action.key) throw new Error("key 需要按键或组合键");
    return { action: action.action, key: action.key };
  }
  if (!action.ref) throw new Error(`${action.action} 需要 UI Automation ref`);
  return { action: action.action, ref: action.ref, text: action.text };
}

async function executeAtomic(action: BatchAction, signal?: AbortSignal, defaultCoordinateSpace: "image" | "screen" = "image"): Promise<void> {
  if (action.action === "wait") {
    await delay(Math.min(30_000, Math.max(0, action.durationMs ?? 1_000)));
    return;
  }
  await runHelper(atomicPayload(action, defaultCoordinateSpace), signal);
}

async function captureStable(signal: AbortSignal | undefined, windowTitle: string | undefined, timeoutMs: number): Promise<{ capture: ScreenshotResult; stable: boolean }> {
  let capture = await captureScreen(signal, windowTitle);
  if (timeoutMs <= 0) return { capture, stable: true };
  const deadline = Date.now() + Math.min(5_000, timeoutMs);
  while (Date.now() < deadline) {
    await delay(120);
    const next = await captureScreen(signal, windowTitle);
    if (next.frameId === capture.frameId) return { capture: next, stable: true };
    capture = next;
  }
  return { capture, stable: false };
}

const atomicActionSchema = Type.Object({
  action: StringEnum(["focus_window", "move", "click", "double_click", "drag", "scroll", "type", "key", "keypress", "invoke", "set_value", "toggle", "select", "focus_element", "scroll_element", "wait"] as const),
  x: Type.Optional(Type.Integer()),
  y: Type.Optional(Type.Integer()),
  endX: Type.Optional(Type.Integer()),
  endY: Type.Optional(Type.Integer()),
  deltaX: Type.Optional(Type.Integer({ minimum: -12000, maximum: 12000 })),
  deltaY: Type.Optional(Type.Integer({ minimum: -12000, maximum: 12000 })),
  durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000 })),
  button: Type.Optional(StringEnum(["left", "right", "middle"] as const)),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })),
  text: Type.Optional(Type.String()),
  key: Type.Optional(Type.String()),
  windowTitle: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()),
  coordinateSpace: Type.Optional(StringEnum(["image", "screen"] as const)),
});

export default function (pi: ExtensionAPI) {
  const confirmActions = process.env.PIDESKTOP_COMPUTER_CONFIRM !== "0";

  pi.registerTool({
    name: "computer",
    label: "Computer",
    description: "Inspect and control Windows with screenshots plus UI Automation element refs. Prefer semantic ref actions, use coordinates as a fallback, and batch stable multi-step sequences. Actions return a refreshed screenshot and optional element map.",
    promptSnippet: "Inspect and control Windows with UI Automation refs first and screenshot coordinates as fallback",
    promptGuidelines: [
      "Start with computer observe or screenshot. Prefer invoke, set_value, toggle, select, focus_element, and scroll_element with returned UI Automation refs.",
      "For coordinate fallback, use coordinates from the returned image and leave coordinateSpace=image. The tool maps them to physical virtual-screen coordinates.",
      "Use batch only for short sequences whose targets and layout will stay stable; take a fresh observation after navigation, dialogs, or layout changes.",
      "Use computer list_windows before focus_window when the target window title is uncertain.",
      "Never type passwords, API keys, payment data, or other secrets with computer unless the user explicitly provides and authorizes that exact input.",
    ],
    parameters: Type.Object({
      action: StringEnum(["screenshot", "observe", "list_windows", "focus_window", "move", "click", "double_click", "drag", "scroll", "type", "key", "keypress", "invoke", "set_value", "toggle", "select", "focus_element", "scroll_element", "wait", "batch"] as const),
      x: Type.Optional(Type.Integer({ description: "Image X coordinate by default, or virtual-screen X when coordinateSpace=screen" })),
      y: Type.Optional(Type.Integer({ description: "Image Y coordinate by default, or virtual-screen Y when coordinateSpace=screen" })),
      endX: Type.Optional(Type.Integer({ description: "Image destination X for drag" })),
      endY: Type.Optional(Type.Integer({ description: "Image destination Y for drag" })),
      deltaX: Type.Optional(Type.Integer({ minimum: -12000, maximum: 12000, description: "Horizontal scroll amount; positive scrolls right" })),
      deltaY: Type.Optional(Type.Integer({ minimum: -12000, maximum: 12000, description: "Vertical scroll amount; positive scrolls down" })),
      durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000, description: "Duration for drag or wait" })),
      button: Type.Optional(StringEnum(["left", "right", "middle"] as const)),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })),
      text: Type.Optional(Type.String({ description: "Text to enter into the focused control" })),
      key: Type.Optional(Type.String({ description: "Key or combination such as ENTER, CTRL+L, or ALT+F4" })),
      windowTitle: Type.Optional(Type.String({ description: "Case-insensitive title fragment for focus_window or a window-scoped screenshot" })),
      ref: Type.Optional(Type.String({ description: "Stable UI Automation element ref returned by observe" })),
      coordinateSpace: Type.Optional(StringEnum(["image", "screen"] as const, { description: "Coordinate space; defaults to image" })),
      actions: Type.Optional(Type.Array(atomicActionSchema, { minItems: 1, maxItems: 20, description: "Atomic actions executed in order with one approval and one final observation" })),
      includeElements: Type.Optional(Type.Boolean({ description: "Include the foreground window UI Automation map; defaults to true" })),
      maxElements: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum UI Automation elements in the result" })),
      waitForStableMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 5000, description: "Wait until two consecutive frame fingerprints match" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action as ComputerAction;
      const actions = action === "batch"
        ? (params.actions as BatchAction[] | undefined) ?? []
        : isInteractiveAction(action) || action === "wait"
          ? [{ ...(params as BatchAction), action: action as AtomicComputerAction }]
          : [];
      if (action === "batch" && actions.length === 0) throw new Error("batch 需要至少一个 action");
      const interactive = actions.some((item) => isInteractiveAction(item.action));
      const confirm = actions.some((item) => requiresConfirmation(item.action));
      const permissionMode = normalizePermissionMode(process.env.PIDESKTOP_PERMISSION_MODE);
      signal?.throwIfAborted();
      if (interactive && permissionMode === "read-only") {
        throw new Error("只读模式下已禁用交互式计算机操作");
      }
      if (confirm && shouldConfirmInteractiveAction(permissionMode, confirmActions)) {
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

      const coordinateSpace = params.coordinateSpace === "screen" ? "screen" : "image";
      if (action === "batch") {
        const scheduledDuration = actions
          .filter((item) => item.action === "wait" || item.action === "drag")
          .reduce((total, item) => total + (item.durationMs ?? (item.action === "wait" ? 1_000 : 500)), 0);
        if (scheduledDuration > 30_000) throw new Error("batch 的等待和拖动总时长不能超过 30000ms");
        const helperActions = actions.map((item) => atomicPayload(item, coordinateSpace));
        signal?.throwIfAborted();
        await runHelper(
          { action: "batch", actions: helperActions },
          signal,
          Math.max(30_000, scheduledDuration + 15_000),
        );
      } else {
        for (const item of actions) {
          signal?.throwIfAborted();
          await executeAtomic(item, signal, coordinateSpace);
        }
      }

      const captureWindow = action === "screenshot" || action === "observe" ? params.windowTitle : undefined;
      const stabilityTimeout = params.waitForStableMs ?? (interactive ? 900 : 0);
      const { capture, stable } = await captureStable(signal, captureWindow, stabilityTimeout);
      let observation: ObservationResult | undefined;
      let observationError: string | undefined;
      if (params.includeElements !== false) {
        try {
          observation = await observeElements(signal, captureWindow, params.maxElements ?? 200);
        } catch (error) {
          observationError = error instanceof Error ? error.message : String(error);
        }
      }
      ctx.ui.setStatus("pidesktop-computer", `桌面 ${capture.width}×${capture.height}`);
      const label = action === "screenshot" ? "Windows 桌面截图" : action === "observe" ? "Windows 桌面观察" : `计算机操作已完成：${action}`;
      const content = screenshotContent(capture, label, observation);
      if (observationError) content.splice(1, 0, { type: "text", text: `UI Automation 不可用，已保留视觉回退：${observationError}` });
      return {
        content,
        details: {
          action,
          width: capture.width,
          height: capture.height,
          left: capture.left,
          top: capture.top,
          imageWidth: capture.imageWidth,
          imageHeight: capture.imageHeight,
          scaleX: capture.scaleX,
          scaleY: capture.scaleY,
          captureBackend: capture.captureBackend,
          captureFallback: capture.captureFallback,
          frameId: capture.frameId,
          stable,
          windowTitle: observation?.windowTitle,
          windowHandle: observation?.windowHandle,
          elements: observation?.elements,
          observationError,
          batchSize: action === "batch" ? actions.length : undefined,
        },
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
