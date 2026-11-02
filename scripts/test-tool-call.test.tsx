import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { shellOutputText, ToolCall } from "../src/components/ToolCall";
import { presentToolCall } from "../src/lib/toolPresentation";
import { test } from "vitest";

/** The row's visible words, tags removed, so assertions read the way the row does. */
function words(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("tool call", async () => {
  const read = renderToStaticMarkup(createElement(ToolCall, {
    call: {
      id: "read-1",
      name: "read",
      args: { path: "README.md", offset: 1 },
      result: "# Pi Desktop",
      running: false,
      startedAt: 1,
      finishedAt: 1100,
    },
  }));
  // A DSH ToolRow: title, a 2px dot, then the summary, all in one 24px disclosure row.
  assert.match(read, /class="dshc-tool"/);
  assert.match(read, /data-disclosure-row=""/);
  assert.match(words(read), /读取 README\.md/);
  assert.match(read, /class="dshc-sep"/);
  assert.match(read, /aria-expanded="false"/);
  assert.doesNotMatch(read, /# Pi Desktop/);
  assert.doesNotMatch(read, /"offset"/);
  // The host's rows carry no per-call duration.
  assert.doesNotMatch(read, /1\.1s/);

  const listed = renderToStaticMarkup(createElement(ToolCall, {
    call: {
      id: "read-list",
      name: "read",
      args: { path: "SKILL.md", limit: 80 },
      result: "- **File mutations**: `mkdir`\n- **Git writes**: `git add`\n---\nname: context-mode",
      running: false,
    },
  }));
  assert.match(words(listed), /读取 SKILL\.md/);
  assert.doesNotMatch(listed, /tool-diff/);
  assert.doesNotMatch(listed, /tool-stat-del/);
  assert.doesNotMatch(listed, /File mutations/);

  const edit = renderToStaticMarkup(createElement(ToolCall, {
    call: {
      id: "edit-1",
      name: "edit",
      args: { path: "src/App.tsx", old_string: "alpha", new_string: "beta" },
      running: false,
    },
  }));
  assert.match(words(edit), /编辑 src\/App\.tsx \+1 -1/);
  assert.match(edit, /class="dshc-diff-added tool-stat-add"/);
  // The diff stays folded until the row is opened, as the host's FileMutationRow does.
  assert.doesNotMatch(edit, /tool-diff/);
  assert.doesNotMatch(edit, /"old_string"/);

  const shell = renderToStaticMarkup(createElement(ToolCall, {
    call: {
      id: "shell-1",
      name: "bash",
      args: { command: "npm test" },
      result: "ok\n",
      running: false,
    },
  }));
  assert.match(words(shell), /运行命令 npm test/);
  assert.doesNotMatch(shell, /dshc-terminal/);
  assert.doesNotMatch(shell, /"command"/);

  const search = renderToStaticMarkup(createElement(ToolCall, {
    call: {
      id: "grep-1",
      name: "grep",
      args: { pattern: "work-log", path: "src" },
      result: "src/components/Message.tsx:12:work-log fold",
      running: false,
    },
  }));
  assert.match(words(search), /搜索文件内容 work-log · src 1 处/);
  assert.doesNotMatch(search, /tool-hits/);
  assert.doesNotMatch(search, /Message\.tsx:12/);
  assert.doesNotMatch(search, /"pattern"/);

  const liveShell = renderToStaticMarkup(createElement(ToolCall, {
    call: {
      id: "shell-live",
      name: "bash",
      args: { command: "npm test" },
      result: "",
      running: true,
    },
  }));
  // A running row turns its glyph into the spinner, says its verb in the progressive,
  // and still sweeps its words with the host's shimmer.
  assert.match(liveShell, /data-state="running"/);
  assert.match(liveShell, /data-shimmer="true"/);
  assert.match(liveShell, /class="dshc-spinner"/);
  assert.match(liveShell, /运行中/);
  assert.match(words(liveShell), /正在运行 npm test/);
});

test("shell output follows the 对话中的命令输出 setting", () => {
  const output = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");
  const call = { id: "shell-long", name: "bash", args: { command: "seq 120" }, result: output, running: false };
  const presented = presentToolCall(call);
  // 摘要, and no setting at all, keep the clipped preview.
  for (const mode of ["summary", undefined] as const) {
    const shown = shellOutputText(presented, call, mode);
    assert.match(shown, /^line 80$/m);
    assert.doesNotMatch(shown, /^line 81$/m);
  }
  // 完整 shows every line the command printed.
  const full = shellOutputText(presented, call, "full");
  assert.equal(full.split("\n").length, 120);
  assert.match(full, /^line 120$/m);
});
