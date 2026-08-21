import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { usePiStore } from "./store";
import type { AssistantMessage, UiMessage } from "./types";
import "./styles.css";

const fixture = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("fixture") : null;

if (fixture === "thread" || fixture === "performance") {
  const cwd = "D:\\02_Lab\\Projects\\PIDesktop";
  const performanceFixture = fixture === "performance";
  const performanceMessages: UiMessage[] = Array.from({ length: 1_000 }, (_, index) => ({
    id: `performance-${index}`,
    role: index % 3 === 0 ? "user" : "assistant",
    content: `Message ${index}\n\nLong history entry for layout and markdown rendering.\n\n\`\`\`ts\nconst value = ${index};\n\`\`\``,
    timestamp: Date.now() - (1_000 - index) * 1_000,
  }));
  usePiStore.setState({
    runtimeId: performanceFixture ? "fixture-runtime" : null,
    connection: "running",
    cwd,
    sessionFile: "fixture-session.jsonl",
    sessionId: "fixture-session",
    sessionName: "修复 Pi Desktop 界面与启动性能",
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
    messages: performanceFixture ? performanceMessages : [
      {
        id: "fixture-user",
        role: "user",
        content: "对齐 Codex 的右上角控制、环境信息浮卡，并处理启动卡顿和反复弹窗。",
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
          "const streaming = { thinking: true, text: true };",
          "```",
        ].join("\n"),
        thinking: "先检查消息容器的字号和行高，再分别校准 Markdown、思考过程与代码块，避免不同内容层级互相抢视觉焦点。",
        durationMs: 13_000,
        timestamp: Date.now() - 15_000,
      },
    ],
    sessions: [{
      file: "fixture-session.jsonl",
      sessionId: "fixture-session",
      cwd,
      name: "修复 Pi Desktop 界面与启动性能",
      firstMessage: "对齐 Codex 的右上角控制",
      messageCount: performanceFixture ? performanceMessages.length : 3,
      updatedAt: Date.now(),
    }],
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
    resolveMessageForkPoint: async (messageId) => ({ entryId: `fixture-entry-${messageId}`, text: "" }),
    editAndResend: async (entryId, text) => {
      console.info(`[performance-fixture] edited resend ${entryId}: ${text}`);
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

  if (performanceFixture) {
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
    <App />
  </React.StrictMode>,
);
