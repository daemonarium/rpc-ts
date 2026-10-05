/**
 * Wire types for the observation stream protocol
 * (cpp-rpc/src/examples/structures/stream_protocol.hpp).
 */

export interface StreamHandle {
  pid: bigint | number
  socket: number
  stream_id: bigint | number
  since_timestamp: bigint | number
  flags: number
}

/** Lifecycle bits on StreamHandle.flags. Orthogonal to since_timestamp. */
export const stream_flags = {
  none: 0,
  observe: 1,
} as const

export interface StreamOpened {
  stream_id: bigint | number
}

export interface StreamItem {
  stream_id: bigint | number
  key: Uint8Array
  value: Uint8Array
  timestamp: bigint | number
}

export interface StreamKey {
  stream_id: bigint | number
  key: Uint8Array
  timestamp: bigint | number
}

export interface StreamDone {
  stream_id: bigint | number
}

export interface StreamReset {
  stream_id: bigint | number
}

export interface StreamError {
  stream_id: bigint | number
  message: string
}

export interface StreamCancel {
  stream_id: bigint | number
}

export const STREAM_MESSAGE_TYPES = [
  'socket_opened',
  'stream_item',
  'stream_key',
  'stream_done',
  'stream_error',
  'stream_reset',
  'stream_cancel',
  'stream_opened',
] as const

export function toStreamId(value: bigint | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
}
