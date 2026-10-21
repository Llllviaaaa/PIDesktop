/**
 * Stand-in for `@deepseek-ai/dsh-api-gateway/client`: the Client remote face
 * and its reconnecting stream. `RemoteStream` is upstream's (remote-stream.ts
 * beside this file, copied unchanged); it runs over PIDesktop's always-on
 * connection (../connection.ts).
 */
export { RemoteStream, type RemoteStreamItem, type RemoteStreamOptions } from './remote-stream.ts'
export { RemoteStreamCarrierError } from './stream-client.ts'
export type { ClientRemote } from '../remotes.ts'
