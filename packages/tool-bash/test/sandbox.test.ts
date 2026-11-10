import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSandboxedEnv,
  findShell,
  generateDevContainerConfig,
  generateWindowsSandboxConfig,
  inspectSandboxedCommand,
  runCommand,
} from "../src/index.ts";

describe("lightweight sandbox helpers", () => {
  it("scrubs secret environment variables and redirects temp directories into workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "pid-sandbox-test-"));
    try {
      const env = buildSandboxedEnv(
        {
          PATH: process.env.PATH ?? "",
          OPENAI_API_KEY: "sk-secret",
          GITHUB_TOKEN: "ghp_secret",
          CUSTOM_DB_PASSWORD: "hunter2",
          AWS_SECRET_ACCESS_KEY: "aws-secret",
          NODE_ENV: "test",
        },
        dir,
      );
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.CUSTOM_DB_PASSWORD).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.NODE_ENV).toBe("test");
      expect(env.QIANJI_SANDBOX).toBe("1");
      expect(env.TMP).toBe(join(dir, ".qianji", "sandbox-tmp"));
      expect(env.TEMP).toBe(join(dir, ".qianji", "sandbox-tmp"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks system-tampering commands while allowing normal developer commands", () => {
    expect(inspectSandboxedCommand("npm test && git status")).toBeUndefined();
    expect(inspectSandboxedCommand("reg add HKCU\\Software\\Test /v Foo /d Bar")).toMatch(/Registry/);
    expect(inspectSandboxedCommand("schtasks /create /tn Backdoor /tr cmd.exe /sc once /st 00:00")).toMatch(
      /Scheduled Task/,
    );
    expect(inspectSandboxedCommand("echo pwn > C:\\Windows\\System32\\drivers\\etc\\hosts")).toMatch(
      /Windows system directory/,
    );
    expect(inspectSandboxedCommand("powershell -c \"Start-Process cmd -Verb RunAs\"")).toMatch(/UAC elevation/);
  });

  it("runs sandboxed commands without leaking scrubbed secrets", async () => {
    const shell = findShell();
    if (shell === undefined) return;
    const dir = mkdtempSync(join(tmpdir(), "pid-sandbox-exec-"));
    try {
      const result = await runCommand(
        shell,
        "printf '%s|%s' \"${OPENAI_API_KEY:-missing}\" \"${QIANJI_SANDBOX:-0}\"",
        dir,
        10_000,
        new AbortController().signal,
        {
          sandbox: true,
          env: {
            ...process.env,
            OPENAI_API_KEY: "placeholder-should-not-leak",
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("missing|1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates valid Windows Sandbox (.wsb) and Dev Container configs", () => {
    const wsb = generateWindowsSandboxConfig("D:\\repo\\A&B");
    expect(wsb).toContain("<Configuration>");
    expect(wsb).toContain("A&amp;B");
    expect(wsb).toContain("<ProtectedClient>Enable</ProtectedClient>");

    const devcontainer = JSON.parse(generateDevContainerConfig("D:\\repo\\my-app")) as {
      name: string;
      image: string;
    };
    expect(devcontainer.name).toBe("Qianji (my-app)");
    expect(devcontainer.image).toContain("devcontainers/base");
  });
});
