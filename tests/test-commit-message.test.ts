// Drafting a commit message (src/lib/gitClient.ts): Rust describes the
// changes and the Harness Host writes the message with `llm.complete` (P6a).
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "PROMPT") }));

const { invoke } = await import("@tauri-apps/api/core");
const { cleanCommitMessage, gitClient } = await import("../src/lib/gitClient");
const { harnessRuntimes } = await import("../src/lib/harnessRuntime");

describe("commit messages", () => {
  it("strip the fences and quotes models add anyway", () => {
    expect(cleanCommitMessage("```\nfeat: x\n\nbody\n```\n")).toBe("feat: x\n\nbody");
    expect(cleanCommitMessage("\"fix: y\"")).toBe("fix: y");
    expect(cleanCommitMessage("say \"hi\"")).toBe("say \"hi\"");
  });

  it("are written by the Host from the prompt Rust builds", async () => {
    const complete = vi.spyOn(harnessRuntimes, "call").mockResolvedValue({ text: "```\nfeat: draft\n```", model: { provider: "p", model: "m" } });
    expect(await gitClient.generateCommitMessage("C:/w", { paths: ["a.ts"], provider: "p", model: "m" })).toBe("feat: draft");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("git_commit_message_prompt", { cwd: "C:/w", paths: ["a.ts"] });
    expect(complete).toHaveBeenCalledWith("llm.complete", { prompt: "PROMPT", provider: "p", model: "m" });

    complete.mockResolvedValueOnce({ text: "  ", model: { provider: "p", model: "m" } });
    await expect(gitClient.generateCommitMessage("C:/w")).rejects.toThrow("空的提交说明");
    expect(complete).toHaveBeenLastCalledWith("llm.complete", { prompt: "PROMPT" });
  });
});
