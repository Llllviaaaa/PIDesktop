import type { RpcResponse } from "../types";

interface PendingRequest {
  command: string;
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function requestKey(runtimeId: string, requestId: string): string {
  return `${runtimeId}\u0000${requestId}`;
}

export class PiRpcResponseRouter {
  private readonly pending = new Map<string, PendingRequest>();

  register(runtimeId: string, requestId: string, command: string, timeoutMs: number): Promise<RpcResponse> {
    const key = requestKey(runtimeId, requestId);
    return new Promise<RpcResponse>((resolve, reject) => {
      const duplicate = this.pending.get(key);
      if (duplicate) {
        clearTimeout(duplicate.timeout);
        duplicate.reject(new Error(`Pi request '${requestId}' was replaced before it completed`));
      }
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Pi command '${command}' timed out`));
      }, timeoutMs);
      this.pending.set(key, { command, resolve, reject, timeout });
    });
  }

  handle(runtimeId: string, response: RpcResponse): boolean {
    if (!response.id) return false;
    const key = requestKey(runtimeId, response.id);
    const request = this.pending.get(key);
    if (!request) return false;
    this.pending.delete(key);
    clearTimeout(request.timeout);
    if (response.success) {
      request.resolve(response);
    } else {
      request.reject(new Error(response.error || `Pi command '${request.command}' failed`));
    }
    return true;
  }

  reject(runtimeId: string, requestId: string, error: unknown): void {
    const key = requestKey(runtimeId, requestId);
    const request = this.pending.get(key);
    if (!request) return;
    this.pending.delete(key);
    clearTimeout(request.timeout);
    request.reject(error instanceof Error ? error : new Error(String(error)));
  }

  rejectRuntime(runtimeId: string, reason: string): void {
    const prefix = `${runtimeId}\u0000`;
    for (const [key, request] of this.pending) {
      if (!key.startsWith(prefix)) continue;
      this.pending.delete(key);
      clearTimeout(request.timeout);
      request.reject(new Error(reason));
    }
  }

  get size(): number {
    return this.pending.size;
  }
}
