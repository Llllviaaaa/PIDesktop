/**
 * Reading errors that come back from Tauri commands.
 *
 * Commands return `AppError` (see src-tauri/src/error.rs), which serialises to
 * `{ kind, message }`. `invoke` rejects with that object as-is, so `String(error)`
 * renders it as "[object Object]". Every command error should be read through
 * `describeError`.
 *
 * Commands that have not been migrated yet still reject with a bare string, and
 * anything can throw a DOMException or a TypeError, so all four shapes are
 * handled here rather than at each call site.
 */

/** Kinds src-tauri/src/error.rs can produce. */
export type AppErrorKind =
  | "io"
  | "notFound"
  | "invalidInput"
  | "locked"
  | "git"
  | "network"
  | "process"
  | "cancelled"
  | "other";

const KINDS: readonly string[] = [
  "io",
  "notFound",
  "invalidInput",
  "locked",
  "git",
  "network",
  "process",
  "cancelled",
  "other",
];

interface SerializedAppError {
  kind: AppErrorKind;
  message: string;
}

function asAppError(error: unknown): SerializedAppError | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Partial<SerializedAppError>;
  if (typeof candidate.message !== "string") return null;
  if (typeof candidate.kind !== "string" || !KINDS.includes(candidate.kind)) return null;
  return { kind: candidate.kind, message: candidate.message };
}

/** The message to show a user, whatever the thrown value was. */
export function describeError(error: unknown): string {
  const appError = asAppError(error);
  if (appError) return appError.message;
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The error's kind, or null when it did not come from a migrated command.
 * Null means "unknown", never "fine" — do not treat it as a success path.
 */
export function errorKind(error: unknown): AppErrorKind | null {
  return asAppError(error)?.kind ?? null;
}

/** Transient failures worth offering a retry for. */
export function isRetryable(error: unknown): boolean {
  const kind = errorKind(error);
  return kind === "network" || kind === "process";
}
