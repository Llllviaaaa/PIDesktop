import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppErrorBoundary } from "../src/components/AppErrorBoundary";
import {
  CrashLogLimiter,
  extractErrorDetails,
  installGlobalErrorHandlers,
  isIgnorableBrowserError,
  reportFrontendError,
} from "../src/lib/crashLogger";
import { HarnessRuntimes } from "../src/lib/harnessRuntime";
import {
  countActiveStreamingTasks,
  hasActiveStreamingTasks,
  requestAppQuit,
} from "../src/lib/quitGuard";

describe("Streaming quit protection (防误退保护)", () => {
  it("counts active streaming and compacting tasks across foreground, background snapshots, and adapter runtimes", () => {
    assert.equal(
      countActiveStreamingTasks(
        {
          runtimeId: null,
          isStreaming: false,
          isCompacting: false,
          runtimes: {},
        },
        0,
      ),
      0,
    );

    // Deduplicates when foreground runtimeId is also present in runtimes map
    assert.equal(
      countActiveStreamingTasks(
        {
          runtimeId: "harness:1",
          isStreaming: true,
          isCompacting: false,
          runtimes: {
            "harness:1": { isStreaming: true, isCompacting: false },
            "harness:2": { isStreaming: false, isCompacting: true },
            "harness:3": { isStreaming: false, isCompacting: false },
          },
        },
        ["harness:1"],
      ),
      2,
    );

    // Unions main session compaction with an isolated SideChat stream
    assert.equal(
      countActiveStreamingTasks(
        {
          runtimeId: "harness:main",
          isStreaming: false,
          isCompacting: true,
          runtimes: {},
        },
        ["harness:side-1"],
      ),
      2,
    );

    // Falls back to live adapter streaming IDs when SideChat or background runtime is streaming
    assert.equal(
      hasActiveStreamingTasks(
        {
          runtimeId: "harness:1",
          isStreaming: false,
          isCompacting: false,
          runtimes: {},
        },
        ["harness:side-1"],
      ),
      true,
    );
  });

  it("notifies streaming subscribers for isolated SideChat streams and clears on Host failure or close", async () => {
    let notifyHandler: ((method: string, params: unknown) => void) | undefined;
    let closeHandler: (() => void) | undefined;
    let shouldFailHost = false;

    const runtimes = new HarnessRuntimes(async () => {
      if (shouldFailHost) {
        throw new Error("Harness Host keeps crashing and was stopped.");
      }
      return {
        host: {
          protocolVersion: "1",
          host: { version: "0.3.0-test" },
          capabilities: { methods: [] },
        },
        call: async <T,>(method: string): Promise<T> => {
          if (method === "session.fork") {
            return { session: { id: "side-session-1" } } as T;
          }
          if (method === "session.subscribe") {
            return { events: [], status: { running: false } } as T;
          }
          return {} as T;
        },
        onNotification: (fn) => {
          notifyHandler = fn;
          return () => {};
        },
        onClose: (fn) => {
          closeHandler = fn;
        },
        close: () => undefined,
      };
    }, [1]);

    const snapshots: Array<readonly string[]> = [];
    const unsub = runtimes.subscribeStreaming(() => {
      snapshots.push(runtimes.getStreamingRuntimeIdsSnapshot());
    });

    const { runtimeId } = await runtimes.start("D:/repo", "harness:parent-1", true);
    expect(runtimes.getStreamingRuntimeIdsSnapshot()).toEqual([]);

    // SideChat starts streaming -> subscriber notified immediately with stable snapshot
    notifyHandler?.("session/delta", {
      sessionId: "side-session-1",
      delta: { type: "agent-start" },
    });
    expect(runtimes.getStreamingRuntimeIdsSnapshot()).toEqual([runtimeId]);
    expect(snapshots).toEqual([[runtimeId]]);

    // Host crashes permanently ("failed") -> active streaming snapshot clears so quit is not stuck
    shouldFailHost = true;
    closeHandler?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(runtimes.getStreamingRuntimeIdsSnapshot()).toEqual([]);
    expect(snapshots.at(-1)).toEqual([]);

    unsub();
    runtimes.close();
  });

  it("quits immediately when idle and requires confirmation when streaming", async () => {
    const quitCalls: boolean[] = [];
    const prompts: string[] = [];

    // 1. Idle -> quits immediately without confirmation dialog
    const idleResult = await requestAppQuit({
      getActiveCount: () => 0,
      confirmFn: async (msg) => {
        prompts.push(msg);
        return true;
      },
      invokeQuit: async (confirmed) => {
        quitCalls.push(confirmed);
      },
    });
    expect(idleResult).toBe(true);
    expect(prompts).toEqual([]);
    expect(quitCalls).toEqual([true]);

    // 2. Streaming + user clicks "继续运行" (cancel) -> aborts quit
    quitCalls.length = 0;
    const cancelledResult = await requestAppQuit({
      getActiveCount: () => 2,
      confirmFn: async (msg) => {
        prompts.push(msg);
        return false;
      },
      invokeQuit: async (confirmed) => {
        quitCalls.push(confirmed);
      },
    });
    expect(cancelledResult).toBe(false);
    expect(prompts[0]).toContain("2 个会话正在流式运行中");
    expect(quitCalls).toEqual([]);

    // 3. Streaming + user clicks "仍要退出" (confirm) -> proceeds with confirmed=true
    const confirmedResult = await requestAppQuit({
      getActiveCount: () => 1,
      confirmFn: async () => true,
      invokeQuit: async (confirmed) => {
        quitCalls.push(confirmed);
      },
    });
    expect(confirmedResult).toBe(true);
    expect(quitCalls).toEqual([true]);
  });
});

describe("Frontend crash logger & AppErrorBoundary", () => {
  it("redacts secrets, ignores benign ResizeObserver warnings, deduplicates, and rate-limits log floods", async () => {
    expect(
      isIgnorableBrowserError("ResizeObserver loop completed with undelivered notifications."),
    ).toBe(true);
    expect(isIgnorableBrowserError("TypeError: Cannot read properties of undefined")).toBe(false);

    const secret = ["sk", "proj", "0123456789abcdefghij"].join("-");
    const extracted = extractErrorDetails(
      new Error(`Auth header Bearer ${secret} failed`),
      `at sendPrompt (token=${secret})`,
    );
    expect(extracted.message).toContain("[REDACTED]");
    expect(extracted.message).not.toContain(secret);
    expect(extracted.stack).toContain("[REDACTED]");
    expect(extracted.stack).not.toContain(secret);

    const limiter = new CrashLogLimiter(5_000, 60_000, 3);
    const persisted: Array<{ source: string; message: string; stack?: string }> = [];
    const sink = async (payload: { source: string; message: string; stack?: string }) => {
      persisted.push(payload);
    };

    // Ignored error does not persist
    expect(
      await reportFrontendError(
        "window.onerror",
        "ResizeObserver loop limit exceeded",
        { limiter, sink, now: 1_000 },
      ),
    ).toBe(false);

    // First real error persists
    expect(
      await reportFrontendError("window.onerror", new Error("boom 1"), {
        limiter,
        sink,
        now: 1_000,
      }),
    ).toBe(true);

    // Duplicate within 5s is suppressed
    expect(
      await reportFrontendError("window.onerror", new Error("boom 1"), {
        limiter,
        sink,
        now: 2_000,
      }),
    ).toBe(false);

    // Two more distinct errors fill the 3-per-60s budget
    expect(
      await reportFrontendError("window.unhandledrejection", new Error("boom 2"), {
        limiter,
        sink,
        now: 2_100,
      }),
    ).toBe(true);
    expect(
      await reportFrontendError("react.error_boundary", new Error("boom 3"), {
        limiter,
        sink,
        now: 2_200,
      }),
    ).toBe(true);

    // 4th distinct error within 60s is rate-limited
    expect(
      await reportFrontendError("window.onerror", new Error("boom 4"), {
        limiter,
        sink,
        now: 2_300,
      }),
    ).toBe(false);
    expect(persisted).toHaveLength(3);
  });

  it("registers window error listener in capture phase to log <script>/<link> failures while ignoring broken <img> elements", async () => {
    const registrations: Array<{ type: string; listener: EventListener; capture: boolean }> = [];
    const fakeWindow = {
      addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
        const fn = typeof listener === "function" ? listener : (e: Event) => listener.handleEvent(e);
        const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
        registrations.push({ type, listener: fn, capture });
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const idx = registrations.findIndex((r) => r.type === type && r.listener === listener);
        if (idx >= 0) registrations.splice(idx, 1);
      },
    };

    const persisted: Array<{ source: string; message: string; stack?: string }> = [];
    const dispose = installGlobalErrorHandlers({
      targetWindow: fakeWindow,
      limiter: new CrashLogLimiter(5_000, 60_000, 10),
      sink: async (payload) => {
        persisted.push(payload);
      },
    });

    const errorReg = registrations.find((r) => r.type === "error");
    expect(errorReg?.capture).toBe(true);

    // 1. Non-bubbling <script> chunk load error -> captured and logged as window.resource_error
    errorReg?.listener({
      target: { tagName: "SCRIPT", src: "http://localhost:1420/assets/chunk-abc.js" },
    } as unknown as Event);

    // 2. Broken markdown <img> error -> ignored (must NOT fall through to window.onerror)
    errorReg?.listener({
      target: { tagName: "IMG", src: "https://example.com/missing.png" },
    } as unknown as Event);

    // 3. Top-level runtime error -> logged as window.onerror
    errorReg?.listener({
      target: fakeWindow,
      error: new Error("Top-level boom"),
      filename: "App.tsx",
      lineno: 42,
      colno: 7,
    } as unknown as Event);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({
      source: "window.resource_error",
      message: "Error: Failed to load script: http://localhost:1420/assets/chunk-abc.js",
    });
    expect(persisted[1]).toMatchObject({
      source: "window.onerror",
      message: "Error: Top-level boom",
    });

    dispose();
    expect(registrations).toHaveLength(0);
  });

  it("renders normal children when healthy and renders draggable/closable redacted fallback UI on crash", () => {
    const healthyHtml = renderToStaticMarkup(
      createElement(AppErrorBoundary, null, createElement("div", null, "Qianji Healthy Stage")),
    );
    expect(healthyHtml).toBe("<div>Qianji Healthy Stage</div>");

    const reported: Array<{ message: string; stack?: string }> = [];
    const secret = ["ghp", "abcdefghijklmnopqrstuvwxyz012345"].join("_");
    const crashError = new Error(`Render crashed with token=${secret}`);

    const boundary = new AppErrorBoundary({
      children: createElement("div", null, "Never shown"),
      onReportError: (err, componentStack) => {
        reported.push({ message: err.message, ...(componentStack ? { stack: componentStack } : {}) });
      },
    });
    const derived = AppErrorBoundary.getDerivedStateFromError(crashError);
    boundary.state = {
      error: derived.error ?? crashError,
      componentStack: "\n    at ConversationMessages\n    at App",
    };

    const fallbackNode = boundary.render();
    const fallbackHtml = renderToStaticMarkup(createElement("div", null, fallbackNode));

    expect(fallbackHtml).toContain("data-tauri-drag-region");
    expect(fallbackHtml).toContain("最小化窗口");
    expect(fallbackHtml).toContain("关闭窗口");
    expect(fallbackHtml).toContain("界面渲染遇到未预期错误");
    expect(fallbackHtml).toContain("尝试恢复界面");
    expect(fallbackHtml).toContain("重新加载窗口");
    expect(fallbackHtml).toContain("token=[REDACTED]");
    expect(fallbackHtml).not.toContain(secret);
    expect(reported).toEqual([]);

    // Verify componentDidCatch forwards error + componentStack to reporter
    boundary.setState = (() => undefined) as typeof boundary.setState;
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      boundary.componentDidCatch(crashError, { componentStack: "\n    at App" });
    } finally {
      console.error = originalConsoleError;
    }
    expect(reported).toHaveLength(1);
    expect(reported[0]?.stack).toContain("at App");
  });
});
