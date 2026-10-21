/**
 * Stand-in for `@deepseek-ai/dsh-typert-protocol`: the result envelope and
 * stream shapes of a remote call. PIDesktop's remote calls are Tauri commands
 * and in-page services; their failures arrive in the same shape.
 *
 * `RemoteError` and `remoteErrorOf` are upstream's (typert/protocol
 * src/remote-error.ts at deepseek-harness 5719020, MIT); the types restate
 * src/types.ts for the members the copied packages use.
 */

/**
 * Failure codes and their details; packages merge their own codes in
 * (`declare module '@deepseek-ai/dsh-typert-protocol'`).
 */
export interface RemoteErrorDetailsMap {
  /** Owner-side business validation refused the request. */
  'gateway/bad-request': { readonly issues?: readonly object[] }
  /** The call was cancelled. */
  'gateway/cancelled': Record<string, never>
  /** Dispatch or unclassified Host failure. */
  'gateway/internal': Record<string, never>
}

export type RemoteErrorCode = keyof RemoteErrorDetailsMap

/**
 * One Remote call failure: a real Error carrying its stable code and typed
 * details. Discrimination is always by `code`, never by instanceof.
 */
export class RemoteError<Code extends RemoteErrorCode = RemoteErrorCode> extends Error {
  /** Structural marker: cross-realm/bundle identification never uses instanceof. */
  readonly isDSHRemoteError = true as const

  constructor(
    readonly code: Code,
    message: string,
    readonly details: RemoteErrorDetailsMap[Code],
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RemoteError'
  }
}

/** The code-discriminated union of failures, so a `code` branch narrows `details`. */
export type RemoteFailure = {
  [Code in RemoteErrorCode]: RemoteError<Code>
}[RemoteErrorCode]

export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailure }

/**
 * Structurally identify a RemoteError thrown across module or realm copies of this class.
 * @param value - a caught value.
 * @returns the failure when the marker matches, otherwise undefined.
 */
export function remoteErrorOf(value: unknown): RemoteFailure | undefined {
  if (typeof value === 'object' && value !== null
    && (value as { isDSHRemoteError?: unknown }).isDSHRemoteError === true
    && typeof (value as { code?: unknown }).code === 'string') {
    return value as RemoteFailure
  }
  return undefined
}

/** Run a call and fold its outcome into a result. */
export async function remoteResult<T>(run: () => T | Promise<T>): Promise<RemoteResult<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return {
      ok: false,
      error: remoteErrorOf(error) ?? new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}),
    }
  }
}

/** Uplink flow-control window a stream's opener publishes. */
export interface RemoteUplinkWindow {
  /** Bytes of uplink frames the Host buffers before refusing more. */
  readonly maxBytes: number
  /** Per-frame bytes the carrier adds to each uplink item. */
  readonly frameOverheadBytes: number
}

/**
 * One open Remote stream as the Client holds it: the downlink items as an
 * `AsyncIterable`, plus the uplink of the same logical stream.
 */
export interface RemoteStreamHandle<Out, In> extends AsyncIterable<Out> {
  /** Send one uplink item. */
  send(item: In): void
  /** Half-close the uplink. */
  end(): void
}
