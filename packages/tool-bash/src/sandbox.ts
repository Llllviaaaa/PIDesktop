/**
 * Lightweight Windows / cross-platform sandbox helpers for `@qianji/tool-bash` (M4.3):
 * 1. Environment credential scrubbing + workspace-local temp directory redirection
 * 2. Command-line escape / system-tampering guard (active outside `full-access`)
 * 3. Windows Job Object containment via `bun:ffi` (`KILL_ON_JOB_CLOSE` + `ACTIVE_PROCESS` cap)
 * 4. Configuration generators for Windows Sandbox (`.wsb`) and Dev Containers
 */
import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const SENSITIVE_EXACT_NAMES = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "NPM_TOKEN",
  "PYPI_API_TOKEN",
  "CARGO_REGISTRY_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "KUBECONFIG",
]);

const SENSITIVE_PREFIXES = [
  "AWS_",
  "AZURE_",
  "ANTHROPIC_",
  "OPENAI_",
  "GEMINI_",
  "GOOGLE_API_",
  "DEEPSEEK_",
  "OPENROUTER_",
  "COOKIE",
  "AUTHORIZATION",
  "QIANJI_SECRET_",
  "PID_SECRET_",
];

const SENSITIVE_SUFFIXES = [
  "_API_KEY",
  "_SECRET",
  "_SECRET_KEY",
  "_ACCESS_KEY",
  "_TOKEN",
  "_PASSWORD",
  "_PASSWD",
  "_PRIVATE_KEY",
  "_CREDENTIAL",
  "_CREDENTIALS",
];

export function isSensitiveEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SENSITIVE_EXACT_NAMES.has(upper)) return true;
  if (SENSITIVE_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  if (SENSITIVE_SUFFIXES.some((suffix) => upper.endsWith(suffix))) return true;
  if (upper.includes("SECRET_KEY") || upper.includes("ACCESS_KEY") || upper.includes("API_TOKEN")) return true;
  return false;
}

/**
 * Scrubs secret-bearing environment variables and redirects `TMP`/`TEMP`/`TMPDIR`
 * into `<cwd>/.qianji/sandbox-tmp` so temporary artifacts stay inside the workspace.
 */
export function buildSandboxedEnv(baseEnv: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (isSensitiveEnvName(key)) continue;
    scrubbed[key] = value;
  }
  const scratchTmp = join(resolve(cwd), ".qianji", "sandbox-tmp");
  try {
    mkdirSync(scratchTmp, { recursive: true });
  } catch {
    // Read-only directory or virtual path in tests; keep going with the path set.
  }
  scrubbed.TMP = scratchTmp;
  scrubbed.TEMP = scratchTmp;
  scrubbed.TMPDIR = scratchTmp;
  scrubbed.GIT_TERMINAL_PROMPT = "0";
  scrubbed.QIANJI_SANDBOX = "1";
  return scrubbed;
}

const BLOCKED_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\breg(?:\.exe)?\s+(?:add|delete|import|restore|save)\b/i,
    reason: "Lightweight sandbox blocked Windows Registry modification (`reg add/delete/import`).",
  },
  {
    pattern: /\bschtasks(?:\.exe)?\s+\/(?:create|change|delete|run)\b/i,
    reason: "Lightweight sandbox blocked Windows Scheduled Task modification (`schtasks`).",
  },
  {
    pattern: /\bsc(?:\.exe)?\s+(?:create|config|stop|delete|failure)\b/i,
    reason: "Lightweight sandbox blocked Windows Service modification (`sc`).",
  },
  {
    pattern: /\b(?:bcdedit|diskpart|vssadmin)(?:\.exe)?\b/i,
    reason: "Lightweight sandbox blocked privileged Windows system utility.",
  },
  {
    pattern: /\bStart-Process\b[^\r\n]*-Verb\s+RunAs\b/i,
    reason: "Lightweight sandbox blocked UAC elevation (`Start-Process -Verb RunAs`).",
  },
  {
    pattern: /(?:>|>>|\btee\b)[^\r\n|;&]*(?:[a-z]:[\\/]+windows[\\/]|\/[a-z]\/windows\/)/i,
    reason: "Lightweight sandbox blocked direct redirection into the Windows system directory.",
  },
  {
    pattern: /\brm\s+-[^\r\n]*r[^\r\n]*f[^\r\n]*\s+\/(?:\*|\s|$)/i,
    reason: "Lightweight sandbox blocked destructive root removal (`rm -rf /`).",
  },
  {
    pattern: /\bFormat-Volume\b/i,
    reason: "Lightweight sandbox blocked volume formatting (`Format-Volume`).",
  },
];

/**
 * Inspects a shell command before execution when lightweight sandboxing is active
 * (unless the session is explicitly in `full-access` mode).
 */
export function inspectSandboxedCommand(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed === "") return undefined;
  for (const rule of BLOCKED_COMMAND_PATTERNS) {
    if (rule.pattern.test(trimmed)) return rule.reason;
  }
  return undefined;
}

interface BunFfi {
  dlopen<Names extends string>(
    library: string,
    symbols: Record<Names, { args: number[]; returns: number }>,
  ): {
    symbols: Record<Names, (...args: Array<number | null>) => number>;
  };
  FFIType: { ptr: number; u32: number; i32: number };
  ptr(view: ArrayBufferView): number;
}

interface Kernel32JobApi {
  CreateJobObjectW: (securityAttributes: number | null, name: number | null) => number;
  SetInformationJobObject: (job: number, infoClass: number, infoPtr: number, infoLen: number) => number;
  OpenProcess: (desiredAccess: number, inheritHandle: number, processId: number) => number;
  AssignProcessToJobObject: (job: number, process: number) => number;
  CloseHandle: (handle: number) => number;
  ptr: (view: ArrayBufferView) => number;
}

let cachedJobApi: Promise<Kernel32JobApi | null> | undefined;

function loadKernel32JobApi(): Promise<Kernel32JobApi | null> {
  if (cachedJobApi !== undefined) return cachedJobApi;
  cachedJobApi = (async () => {
    if (
      process.platform !== "win32" ||
      typeof (process.versions as Record<string, string | undefined>).bun !== "string"
    ) {
      return null;
    }
    try {
      const specifier = "bun:ffi";
      const ffi = (await import(specifier)) as BunFfi;
      const { dlopen, FFIType, ptr } = ffi;
      const kernel32 = dlopen("kernel32.dll", {
        CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
        SetInformationJobObject: {
          args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
          returns: FFIType.i32,
        },
        OpenProcess: {
          args: [FFIType.u32, FFIType.i32, FFIType.u32],
          returns: FFIType.ptr,
        },
        AssignProcessToJobObject: {
          args: [FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
        CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
      });
      return {
        CreateJobObjectW: kernel32.symbols.CreateJobObjectW,
        SetInformationJobObject: kernel32.symbols.SetInformationJobObject,
        OpenProcess: kernel32.symbols.OpenProcess,
        AssignProcessToJobObject: kernel32.symbols.AssignProcessToJobObject,
        CloseHandle: kernel32.symbols.CloseHandle,
        ptr,
      };
    } catch {
      return null;
    }
  })();
  return cachedJobApi;
}

const JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS = 9;
const JOB_OBJECT_EXTENDED_LIMIT_SIZE_X64 = 144;
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x0000_0008;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const DEFAULT_MAX_ACTIVE_PROCESSES = 32;

/**
 * Attaches `pid` to a dedicated Windows Job Object configured with:
 * - `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (guaranteed orphan/tree cleanup)
 * - `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` = 32 (fork-bomb containment)
 *
 * Returns a disposer that closes the Job handle, or `undefined` when outside Bun on Windows.
 */
export async function attachWindowsJobObject(
  pid: number,
  maxActiveProcesses = DEFAULT_MAX_ACTIVE_PROCESSES,
): Promise<(() => void) | undefined> {
  if (process.arch !== "x64" && process.arch !== "arm64") return undefined;
  const api = await loadKernel32JobApi();
  if (api === null) return undefined;

  const jobHandle = api.CreateJobObjectW(null, null);
  if (!jobHandle) return undefined;

  // x64 / arm64 layout of JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes):
  //   offset 16: DWORD LimitFlags
  //   offset 40: DWORD ActiveProcessLimit
  const info = Buffer.alloc(JOB_OBJECT_EXTENDED_LIMIT_SIZE_X64);
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS, 16);
  info.writeUInt32LE(Math.max(2, maxActiveProcesses), 40);

  const configured = api.SetInformationJobObject(
    jobHandle,
    JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS,
    api.ptr(info),
    info.byteLength,
  );
  if (configured === 0) {
    api.CloseHandle(jobHandle);
    return undefined;
  }

  const procHandle = api.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
  if (!procHandle) {
    api.CloseHandle(jobHandle);
    return undefined;
  }

  const assigned = api.AssignProcessToJobObject(jobHandle, procHandle);
  api.CloseHandle(procHandle);
  if (assigned === 0) {
    api.CloseHandle(jobHandle);
    return undefined;
  }

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    api.CloseHandle(jobHandle);
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generates a Windows Sandbox (`.wsb`) configuration mapping `workspacePath`
 * into the isolated Hyper-V micro-VM desktop.
 */
export function generateWindowsSandboxConfig(workspacePath: string): string {
  const hostFolder = escapeXml(resolve(workspacePath));
  const sandboxFolder = "C:\\Users\\WDAGUtilityAccount\\Desktop\\workspace";
  return [
    "<Configuration>",
    "  <VGpu>Disable</VGpu>",
    "  <Networking>Default</Networking>",
    "  <AudioInput>Disable</AudioInput>",
    "  <VideoInput>Disable</VideoInput>",
    "  <ProtectedClient>Enable</ProtectedClient>",
    "  <PrinterRedirection>Disable</PrinterRedirection>",
    "  <ClipboardRedirection>Disable</ClipboardRedirection>",
    "  <MemoryInMB>4096</MemoryInMB>",
    "  <MappedFolders>",
    "    <MappedFolder>",
    `      <HostFolder>${hostFolder}</HostFolder>`,
    `      <SandboxFolder>${sandboxFolder}</SandboxFolder>`,
    "      <ReadOnly>false</ReadOnly>",
    "    </MappedFolder>",
    "  </MappedFolders>",
    "  <LogonCommand>",
    `    <Command>powershell.exe -NoExit -Command &quot;Set-Location '${sandboxFolder}'&quot;</Command>`,
    "  </LogonCommand>",
    "</Configuration>",
    "",
  ].join("\n");
}

/**
 * Generates a `.devcontainer/devcontainer.json` template for running coding sessions
 * inside an isolated OCI container.
 */
export function generateDevContainerConfig(workspacePath: string): string {
  const folderName = basename(resolve(workspacePath)) || "workspace";
  const payload = {
    name: `Qianji (${folderName})`,
    image: "mcr.microsoft.com/devcontainers/base:ubuntu",
    features: {
      "ghcr.io/devcontainers/features/node:1": { version: "22" },
      "ghcr.io/devcontainers/features/git:1": {},
    },
    remoteUser: "vscode",
    containerEnv: {
      GIT_TERMINAL_PROMPT: "0",
    },
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
