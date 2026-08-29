import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DesktopPetWindow } from "./components/DesktopPetWindow";
import { moveManagedQueueItem, removeManagedQueueItem } from "./lib/managedQueue";
import { usePiStore } from "./store";
import type { AssistantMessage, UiMessage } from "./types";
import "./styles.css";

const fixture = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("fixture") : null;
const desktopPetWindow = new URLSearchParams(window.location.search).get("desktop-pet") === "1";

if (fixture === "thread" || fixture === "performance" || fixture === "stream" || fixture === "queue" || fixture === "title" || fixture === "diagrams" || fixture === "goal") {
  const cwd = "D:\\Projects\\PIDesktop";
  const performanceFixture = fixture === "performance";
  const streamFixture = fixture === "stream";
  const queueFixture = fixture === "queue";
  const titleFixture = fixture === "title";
  const diagramFixture = fixture === "diagrams";
  const goalFixture = fixture === "goal";
  const performanceMessages: UiMessage[] = Array.from({ length: 1_000 }, (_, index) => ({
    id: `performance-${index}`,
    role: index % 3 === 0 ? "user" : "assistant",
    content: `Message ${index}\n\nLong history entry for layout and markdown rendering.\n\n\`\`\`ts\nconst value = ${index};\n\`\`\``,
    timestamp: Date.now() - (1_000 - index) * 1_000,
  }));
  usePiStore.setState({
    runtimeId: performanceFixture || streamFixture || queueFixture || titleFixture || diagramFixture || goalFixture ? "fixture-runtime" : null,
    connection: "running",
    cwd,
    sessionFile: "fixture-session.jsonl",
    sessionId: "fixture-session",
    sessionName: titleFixture ? null : "修复 Pi Desktop 界面与启动性能",
    stats: {
      sessionFile: "fixture-session.jsonl",
      sessionId: "fixture-session",
      userMessages: 1,
      assistantMessages: 2,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 3,
      tokens: { input: 2_000, output: 500, cacheRead: 0, cacheWrite: 0, total: 2_500 },
      cost: 0,
      contextUsage: { tokens: 2_000, contextWindow: 100_000, percent: 2 },
    },
    isStreaming: streamFixture || queueFixture,
    messages: performanceFixture ? performanceMessages : goalFixture ? [
      {
        id: "fixture-goal-user",
        role: "user",
        content: "修复目标完成后仍留在聊天中的问题。",
        timestamp: Date.now() - 125_000,
      },
      {
        id: "fixture-goal-assistant",
        role: "assistant",
        content: "我会把目标状态与普通消息分开显示。",
        timestamp: Date.now() - 120_000,
        toolCalls: [{
          id: "fixture-create-goal",
          name: "create_goal",
          args: { objective: "目标完成后自动从工作区状态条移除", token_budget: 24_000 },
          running: false,
          startedAt: Date.now() - 120_000,
          finishedAt: Date.now() - 119_000,
        }],
      },
    ] : diagramFixture ? [
      {
        id: "fixture-diagram-user",
        entryId: "fixture-diagram-entry",
        role: "user",
        content: "请用 Mermaid 和 PlantUML 展示消息渲染流程。",
        timestamp: Date.now() - 10_000,
      },
      {
        id: "fixture-diagram-assistant",
        role: "assistant",
        content: [
          "## Mermaid",
          "",
          "```mermaid",
          "flowchart LR",
          "  A[Agent 输出] --> B[Markdown 识别]",
          "  B --> C[本地 SVG 渲染]",
          "```",
          "",
          "## PlantUML",
          "",
          "```plantuml",
          "@startuml",
          "actor Agent",
          "participant PIDesktop",
          "Agent -> PIDesktop: PlantUML 源码",
          "PIDesktop --> Agent: 本地渲染 SVG",
          "@enduml",
          "```",
        ].join("\n"),
        timestamp: Date.now() - 5_000,
      },
    ] : (streamFixture || queueFixture) ? [
      {
        id: "fixture-stream-user",
        role: "user",
        content: "按照paseo",
        timestamp: Date.now() - 1_000,
      },
      {
        id: "fixture-stream-assistant",
        role: "assistant",
        content: "",
        isStreaming: true,
        timestamp: Date.now(),
        toolCalls: [{
          id: "fixture-ctx-execute",
          name: "ctx_execute",
          args: { code: "console.log('fixture')" },
          running: true,
          startedAt: Date.now() - 300,
        }],
      },
    ] : [
      {
        id: "fixture-user",
        role: "user",
        content: titleFixture ? "按照paseo" : "对齐 Codex 的右上角控制、环境信息浮卡，并处理启动卡顿和反复弹窗。",
        timestamp: Date.now() - 70_000,
      },
      {
        id: "fixture-assistant-short",
        role: "assistant",
        content: "先检查当前模型配置。",
        thinking: "读取模型配置并核对可用 provider。",
        durationMs: 5_000,
        timestamp: Date.now() - 45_000,
      },
      {
        id: "fixture-assistant",
        role: "assistant",
        content: [
          "已经完成消息区域的整理，主要包括：",
          "",
          "- **正文层级**：助手回复保持紧凑、易读，不再和用户气泡使用同一字号。",
          "- **流式反馈**：思考过程和最终回复都会持续更新。",
          "- **代码展示**：`src/components/Message.tsx` 等文件引用保持清晰。",
          "",
          "```ts",
          "const streaming = {",
          "  thinking: true,",
          "  text: true,",
          "};",
          "```",
          "",
          "::code-comment{title=\"[P1] 状态更新可能过期\" body=\"该变量在工作区切换后仍可能引用旧状态，请从当前 store 读取。\" file=\"src/App.tsx\" start=2 end=2 priority=1}",
        ].join("\n"),
        thinking: "先检查消息容器的字号和行高，再分别校准 Markdown、思考过程与代码块，避免不同内容层级互相抢视觉焦点。",
        durationMs: 13_000,
        timestamp: Date.now() - 15_000,
        toolCalls: [
          {
            id: "fixture-read",
            name: "read",
            args: { path: "src/components/Message.tsx" },
            running: false,
            startedAt: Date.now() - 25_000,
            finishedAt: Date.now() - 18_000,
          },
        ],
      },
    ],
    sessions: [{
      file: "fixture-session.jsonl",
      sessionId: "fixture-session",
      cwd,
      name: titleFixture ? undefined : "修复 Pi Desktop 界面与启动性能",
      firstMessage: titleFixture ? "按照paseo" : "对齐 Codex 的右上角控制",
      messageCount: performanceFixture ? performanceMessages.length : 3,
      updatedAt: Date.now(),
    }],
    managedFollowUpQueue: queueFixture ? [
      { id: "queue-a", text: "先补充队列顺序测试，并保留当前修改", attachments: [], createdAt: Date.now() },
      { id: "queue-b", text: "然后检查一个带有很长文本的待处理消息在窄屏上会不会挤压右侧操作按钮", attachments: [], createdAt: Date.now() + 1 },
      { id: "queue-c", text: "最后运行完整回归", attachments: [], createdAt: Date.now() + 2 },
    ] : [],
    moveManagedFollowUp: (id, direction) => {
      usePiStore.setState((state) => ({
        managedFollowUpQueue: moveManagedQueueItem(state.managedFollowUpQueue, id, direction),
      }));
    },
    removeManagedFollowUp: (id) => {
      usePiStore.setState((state) => ({
        managedFollowUpQueue: removeManagedQueueItem(state.managedFollowUpQueue, id).queue,
      }));
    },
    steerManagedFollowUp: async (id) => {
      usePiStore.getState().removeManagedFollowUp(id);
    },
    git: {
      isRepository: true,
      branch: "agent/codex-parity-client",
      files: [
        { status: "M", path: "src/App.tsx", indexStatus: "", worktreeStatus: "M", staged: false, unstaged: true, untracked: false },
        { status: "M", path: "src/styles.css", indexStatus: "M", worktreeStatus: "", staged: true, unstaged: false, untracked: false },
        { status: "MM", path: "src-tauri/src/lib.rs", indexStatus: "M", worktreeStatus: "M", staged: true, unstaged: true, untracked: false },
      ],
      diff: [
        "diff --git a/src/App.tsx b/src/App.tsx",
        "--- a/src/App.tsx",
        "+++ b/src/App.tsx",
        "@@ -1,2 +1,3 @@",
        " import React from 'react';",
        "+const environmentFlyout = true;",
        "-const toolRail = true;",
        "+const toolMenu = true;",
      ].join("\n"),
    },
    resolveMessageForkPoint: async (messageId) => ({
      entryId: `fixture-entry-${messageId}`,
      text: messageId === "fixture-stream-user" ? "按照paseo" : "",
    }),
    editAndResend: async (entryId, text) => {
      console.info(`[performance-fixture] edited resend ${entryId}: ${text}`);
      return true;
    },
    rewindMessage: async (entryId) => {
      console.info(`[performance-fixture] rewound ${entryId}`);
      return true;
    },
    sendMessage: async (text, attachments = []) => {
      if (!performanceFixture) return true;
      const nonce = Date.now();
      const assistantId = `fixture-pending-assistant-${nonce}`;
      usePiStore.setState((state) => ({
        messages: [
          ...state.messages,
          {
            id: `fixture-pending-user-${nonce}`,
            role: "user",
            content: text,
            images: attachments.length
              ? attachments.map(({ data, mimeType }) => ({ type: "image", data: data || "", mimeType }))
              : undefined,
            timestamp: nonce,
          },
          {
            id: assistantId,
            role: "assistant",
            content: "",
            timestamp: nonce,
            streaming: true,
          },
        ],
        isStreaming: true,
      }));
      window.setTimeout(() => {
        usePiStore.setState((state) => ({
          messages: state.messages.map((message) => message.id === assistantId
            ? { ...message, content: "Fixture response started.", streaming: false }
            : message),
          isStreaming: false,
        }));
      }, 700);
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      return true;
    },
  });

  if (performanceFixture || streamFixture) {
    window.setTimeout(() => {
      let updateCount = 0;
      let messageCommits = 0;
      let previousMessages = usePiStore.getState().messages;
      const unsubscribe = usePiStore.subscribe((state) => {
        if (state.messages !== previousMessages) {
          messageCommits += 1;
          previousMessages = state.messages;
        }
      });
      const makeMessage = (
        content: string,
        stopReason: AssistantMessage["stopReason"],
        thinking = "",
      ): AssistantMessage => ({
        role: "assistant",
        provider: "fixture",
        model: "fixture-model",
        stopReason,
        timestamp: Date.now(),
        content: [
          ...(thinking ? [{ type: "thinking" as const, thinking }] : []),
          { type: "text", text: content },
        ],
      });
      usePiStore.getState().handleEvent("fixture-runtime", {
        type: "message_start",
        message: makeMessage("", "pending"),
      });
      let thinkingCount = 0;
      let thinkingText = "";
      const thinkingTimer = window.setInterval(() => {
        thinkingCount += 1;
        const delta = `Thinking update ${thinkingCount} `;
        thinkingText += delta;
        usePiStore.getState().handleEvent("fixture-runtime", {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta },
        });
        if (thinkingCount < 30) return;
        window.clearInterval(thinkingTimer);
        const timer = window.setInterval(() => {
          updateCount += 1;
          const content = `Streaming update ${updateCount} `;
          usePiStore.getState().handleEvent("fixture-runtime", {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: content },
          });
          if (updateCount < 300) return;
          window.clearInterval(timer);
          usePiStore.getState().handleEvent("fixture-runtime", {
            type: "message_end",
            message: makeMessage("Streaming fixture complete.", "stop", thinkingText),
          });
          usePiStore.getState().handleEvent("fixture-runtime", { type: "agent_end", messages: [] });
          unsubscribe();
          console.info(`[performance-fixture] ${updateCount} updates -> ${messageCommits} message commits`);
        }, 2);
      }, 40);
    }, 800);
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {desktopPetWindow ? <DesktopPetWindow /> : <App />}
  </React.StrictMode>,
);
