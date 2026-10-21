/**
 * The carrier failure class of DSH's Gateway stream client (api/gateway
 * src/client/stream-client.ts at deepseek-harness 5719020, MIT), which the
 * copied remote-stream.ts beside it imports. PIDesktop's streams are in-page,
 * with no socket to lose, so nothing here ever throws it; the rest of the
 * upstream module (the multiplexed WebSocket) has no counterpart.
 */

/** Physical Remote stream socket failure that may be retried by a domain transport. */
export class RemoteStreamCarrierError extends Error {
  /**
   * @param message - physical carrier failure description.
   * @param options - optional causal error.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteStreamCarrierError'
  }
}
