/**
 * Microkernel orchestration primitives on top of `@deepseek-ai/cordis`:
 * 1. Dependency metadata extraction (`inject` & `provide`) and deterministic topological sort;
 * 2. True Cordis fiber readiness detection (`active` vs `pending` when `inject` services are missing);
 * 3. Isolated child context scopes for active workspace plugins (`.pid/plugins`).
 */
import type { Context, Fiber } from "@deepseek-ai/cordis";

/** Cordis `FiberState` numeric constants (`@deepseek-ai/cordis` enum values). */
export const CordisFiberState = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const;

export interface PluginDependencyMeta {
  inject: string[];
  provides: string[];
}

export interface PluginGraphNode {
  id: string;
  inject?: readonly string[];
  provides?: readonly string[];
}

export interface TopologicalSortResult<T extends PluginGraphNode> {
  ordered: T[];
  cycles: string[][];
}

export interface FiberReadinessReport {
  status: "active" | "pending" | "errored" | "disposed";
  missingInject: string[];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringList(raw: unknown): string[] {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed === "" ? [] : [trimmed];
  }
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item === "string" && item.trim() !== "") {
        out.push(item.trim());
      }
    }
    return out;
  }
  return [];
}

/** Extract required `inject` service names from a Cordis `inject` declaration. */
export function parseInjectDeclaration(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    return normalizeStringList(raw);
  }
  if (isObjectRecord(raw)) {
    const keys = Object.keys(raw);
    if (
      keys.length > 0
      && keys.every((key) => key === "required" || key === "optional")
      && (Array.isArray(raw.required) || Array.isArray(raw.optional))
    ) {
      return normalizeStringList(raw.required);
    }
    return keys.filter((key) => key.trim() !== "");
  }
  return [];
}

/** Extract `inject` and `provide` service declarations from a Cordis plugin value or module. */
export function extractPluginDependencyMeta(
  plugin: unknown,
  explicit?: { inject?: readonly string[]; provides?: readonly string[] },
): PluginDependencyMeta {
  const injectSet = new Set<string>(explicit?.inject ?? []);
  const provideSet = new Set<string>(explicit?.provides ?? []);

  const inspectTarget = (target: unknown): void => {
    if (target === null || target === undefined) return;
    if (typeof target !== "object" && typeof target !== "function") return;
    const record = target as Record<string, unknown>;
    for (const dep of parseInjectDeclaration(record.inject)) {
      injectSet.add(dep);
    }
    for (const svc of normalizeStringList(record.provide)) {
      provideSet.add(svc);
    }
    for (const svc of normalizeStringList(record.provides)) {
      provideSet.add(svc);
    }
  };

  inspectTarget(plugin);
  if (isObjectRecord(plugin) && "default" in plugin) {
    inspectTarget(plugin.default);
  }

  return {
    inject: [...injectSet],
    provides: [...provideSet],
  };
}

/**
 * Deterministic topological sort (Kahn's algorithm preserving input declaration order
 * as tie-breaker). Providers come before consumers; cycles are reported and broken
 * gracefully in original declaration order without dropping any node.
 */
export function topologicalSortPlugins<T extends PluginGraphNode>(nodes: readonly T[]): TopologicalSortResult<T> {
  const count = nodes.length;
  if (count <= 1) {
    return { ordered: [...nodes], cycles: [] };
  }

  const providersByService = new Map<string, number[]>();
  for (let i = 0; i < count; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    for (const svc of node.provides ?? []) {
      const list = providersByService.get(svc) ?? [];
      if (!list.includes(i)) list.push(i);
      providersByService.set(svc, list);
    }
  }

  const dependents = Array.from({ length: count }, () => new Set<number>());
  const inDegree = new Array<number>(count).fill(0);

  for (let consumerIdx = 0; consumerIdx < count; consumerIdx += 1) {
    const consumer = nodes[consumerIdx];
    if (consumer === undefined) continue;
    for (const requiredService of consumer.inject ?? []) {
      const providerIndices = providersByService.get(requiredService);
      if (providerIndices === undefined) continue;
      for (const providerIdx of providerIndices) {
        if (providerIdx === consumerIdx) continue;
        const set = dependents[providerIdx];
        if (set !== undefined && !set.has(consumerIdx)) {
          set.add(consumerIdx);
          inDegree[consumerIdx] = (inDegree[consumerIdx] ?? 0) + 1;
        }
      }
    }
  }

  const placed = new Array<boolean>(count).fill(false);
  const ordered: T[] = [];
  const cycles: string[][] = [];

  while (ordered.length < count) {
    let nextIdx = -1;
    for (let i = 0; i < count; i += 1) {
      if (!placed[i] && (inDegree[i] ?? 0) === 0) {
        nextIdx = i;
        break;
      }
    }

    if (nextIdx === -1) {
      // Cycle detected among remaining unplaced nodes: record cycle participants and break at earliest index.
      const cycleMembers: string[] = [];
      for (let i = 0; i < count; i += 1) {
        if (!placed[i]) {
          const item = nodes[i];
          if (item !== undefined) cycleMembers.push(item.id);
          if (nextIdx === -1) nextIdx = i;
        }
      }
      if (cycleMembers.length > 0) {
        cycles.push(cycleMembers);
      }
    }

    if (nextIdx === -1) break;
    placed[nextIdx] = true;
    const chosen = nodes[nextIdx];
    if (chosen !== undefined) {
      ordered.push(chosen);
    }
    const outgoing = dependents[nextIdx];
    if (outgoing !== undefined) {
      for (const depIdx of outgoing) {
        if (!placed[depIdx]) {
          inDegree[depIdx] = Math.max(0, (inDegree[depIdx] ?? 0) - 1);
        }
      }
    }
  }

  return { ordered, cycles };
}

/** Reverse topological order for safe plugin teardown (dependents dispose before providers). */
export function reverseTopologicalOrder<T extends PluginGraphNode>(nodes: readonly T[]): T[] {
  return [...topologicalSortPlugins(nodes).ordered].reverse();
}

/**
 * Inspect a Cordis `Fiber` to determine whether it is genuinely `ACTIVE` or waiting (`PENDING`)
 * on missing `inject` services. Prevents reporting a false "active" status when dependencies are unmet.
 */
export function inspectCordisFiber(
  ctx: Context,
  fiber: unknown,
  declaredInject: readonly string[] = [],
): FiberReadinessReport {
  if (!isObjectRecord(fiber)) {
    return { status: "disposed", missingInject: [...declaredInject] };
  }

  const uid = fiber.uid;
  const state = typeof fiber.state === "number" ? fiber.state : CordisFiberState.ACTIVE;
  const fiberInject = parseInjectDeclaration(fiber.inject);
  const allRequired = [...new Set([...fiberInject, ...declaredInject])];
  const store = isObjectRecord(fiber.store) ? fiber.store : undefined;

  const missingInject = allRequired.filter((serviceName) => {
    if (store !== undefined && serviceName in store && store[serviceName] !== undefined) {
      return false;
    }
    return ctx.get(serviceName as never) === undefined;
  });

  if (uid === null || state === CordisFiberState.DISPOSED) {
    return { status: "disposed", missingInject };
  }
  if (state === CordisFiberState.FAILED) {
    return { status: "errored", missingInject };
  }
  if (state === CordisFiberState.ACTIVE) {
    return { status: "active", missingInject: [] };
  }
  return { status: "pending", missingInject };
}

/** Subscribe to Cordis fiber lifecycle transitions (`internal/status`). */
export function onCordisFiberStatusChange(
  ctx: Context,
  listener: (fiber: Fiber, previousState: number) => void,
): () => void {
  const off = (ctx as unknown as {
    on(name: string, fn: (fiber: Fiber, oldState: number) => void): () => boolean;
  }).on("internal/status", listener);
  return () => {
    off();
  };
}

/**
 * Manages an isolated child Cordis container fiber for the single active trusted workspace.
 * Switching workspaces or revoking trust disposes the entire child fiber and every effect,
 * listener, tool, or sub-plugin mounted within it so project plugins never leak across workspaces.
 */
export class WorkspacePluginScope {
  private current?: {
    workspaceKey: string;
    workspacePath: string;
    fiber: Fiber;
    ctx: Context;
  };

  constructor(private readonly rootCtx: Context) {}

  get activeWorkspacePath(): string | undefined {
    return this.current?.workspacePath;
  }

  get activeContext(): Context | undefined {
    return this.current?.ctx;
  }

  /**
   * Ensure a clean child Cordis context exists for `(workspaceKey, workspacePath)`.
   * If another workspace scope is currently mounted, it is disposed first.
   */
  async ensure(workspaceKey: string, workspacePath: string): Promise<Context> {
    if (this.current !== undefined && this.current.workspaceKey === workspaceKey && this.current.fiber.uid !== null) {
      return this.current.ctx;
    }
    await this.dispose();

    let capturedCtx: Context | undefined;
    const scopePlugin = {
      name: `pid-workspace-scope:${workspaceKey}`,
      apply(innerCtx: Context) {
        capturedCtx = innerCtx;
      },
    };
    const fiber = this.rootCtx.plugin(scopePlugin);
    await fiber;
    const scopedCtx = capturedCtx ?? fiber.ctx;
    this.current = {
      workspaceKey,
      workspacePath,
      fiber,
      ctx: scopedCtx,
    };
    return scopedCtx;
  }

  /** Dispose the active workspace child fiber and all plugins mounted inside it. */
  async dispose(): Promise<void> {
    const active = this.current;
    this.current = undefined;
    if (active !== undefined) {
      await active.fiber.dispose();
    }
  }
}
