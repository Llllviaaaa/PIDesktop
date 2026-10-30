/**
 * The agent browser and computer panels, read from what their tools return:
 * the latest screenshot, and the page or desktop details the tool reports.
 */
import type { AgentBrowserState, ComputerElementState, ComputerState, ImageContent, UiMessage } from "../types";

/** What a tool returned, as far as the panels care. */
export interface ToolOutput {
  images?: ImageContent[];
  details?: Record<string, unknown>;
}

export function isGrokBrowserTool(name: string): boolean {
  const tool = name.toLowerCase();
  return tool === "browser" || tool.startsWith("browser_");
}

export function isGrokComputerTool(name: string): boolean {
  const tool = name.toLowerCase();
  return tool === "computer" || tool.startsWith("computer_");
}

export function agentBrowserFromResult(result: ToolOutput, previous: AgentBrowserState | null): AgentBrowserState | null {
  const details = result.details;
  const url = typeof details?.url === "string" ? details.url : previous?.url;
  const title = typeof details?.title === "string" ? details.title : previous?.title;
  if (!url && !title && !result.images?.[0]) return previous;
  return {
    url: url || "about:blank",
    title: title || url || "Agent 浏览器",
    screenshot: result.images?.[0] ?? previous?.screenshot,
    updatedAt: Date.now(),
  };
}

export function agentBrowserFromMessages(messages: UiMessage[]): AgentBrowserState | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const calls = messages[messageIndex].toolCalls ?? [];
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = calls[callIndex];
      if (!isGrokBrowserTool(call.name)) continue;
      const url = typeof call.details?.url === "string" ? call.details.url : "about:blank";
      const title = typeof call.details?.title === "string" ? call.details.title : url;
      return { url, title, screenshot: call.images?.[0], updatedAt: call.finishedAt ?? Date.now() };
    }
  }
  return null;
}

export function computerFromResult(result: ToolOutput, previous: ComputerState | null): ComputerState | null {
  const details = result.details;
  const images = result.images;
  const hasDesktopFrame = Boolean(images?.[0])
    || typeof details?.width === "number"
    || typeof details?.height === "number";
  if (!hasDesktopFrame && !previous) return null;
  const elements = Array.isArray(details?.elements)
    ? details.elements.filter((element): element is ComputerElementState => Boolean(
      element
      && typeof element === "object"
      && typeof (element as ComputerElementState).ref === "string"
      && typeof (element as ComputerElementState).role === "string"
      && typeof (element as ComputerElementState).name === "string"
      && (element as ComputerElementState).bounds
      && Array.isArray((element as ComputerElementState).patterns),
    ))
    : previous?.elements;
  return {
    action: typeof details?.action === "string" ? details.action : previous?.action || "screenshot",
    width: typeof details?.width === "number" ? details.width : previous?.width || 0,
    height: typeof details?.height === "number" ? details.height : previous?.height || 0,
    left: typeof details?.left === "number" ? details.left : previous?.left || 0,
    top: typeof details?.top === "number" ? details.top : previous?.top || 0,
    imageWidth: typeof details?.imageWidth === "number" ? details.imageWidth : previous?.imageWidth,
    imageHeight: typeof details?.imageHeight === "number" ? details.imageHeight : previous?.imageHeight,
    scaleX: typeof details?.scaleX === "number" ? details.scaleX : previous?.scaleX,
    scaleY: typeof details?.scaleY === "number" ? details.scaleY : previous?.scaleY,
    captureBackend: typeof details?.captureBackend === "string" ? details.captureBackend : previous?.captureBackend,
    frameId: typeof details?.frameId === "string" ? details.frameId : previous?.frameId,
    stable: typeof details?.stable === "boolean" ? details.stable : previous?.stable,
    windowTitle: typeof details?.windowTitle === "string" ? details.windowTitle : previous?.windowTitle,
    windowHandle: typeof details?.windowHandle === "string" ? details.windowHandle : previous?.windowHandle,
    elements,
    observationError: typeof details?.observationError === "string" ? details.observationError : undefined,
    screenshot: images?.[0] ?? previous?.screenshot,
    updatedAt: Date.now(),
  };
}

export function computerFromMessages(messages: UiMessage[]): ComputerState | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const calls = messages[messageIndex].toolCalls ?? [];
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = calls[callIndex];
      if (!isGrokComputerTool(call.name)) continue;
      return computerFromResult({ images: call.images, details: call.details }, null);
    }
  }
  return null;
}
