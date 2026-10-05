/**
 * Port of cpp-rpc/src/observable/stream_receiver.hpp.
 */

import type {
  StreamDone,
  StreamError,
  StreamItem,
  StreamKey,
  StreamOpened,
  StreamReset,
} from './streamProtocol.js'

export interface StreamReceiver {
  onStreamOpened?(m: StreamOpened): void
  onStreamItem(m: StreamItem): void
  onStreamKey?(m: StreamKey): void
  onStreamDone(m: StreamDone): void
  onStreamReset(m: StreamReset): void
  onStreamError(m: StreamError): void
}
