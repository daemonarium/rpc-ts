/**
 * Port of cpp-rpc/src/observable/stream_receiver.hpp.
 */

import type {
  StreamDone,
  StreamError,
  StreamItem,
  StreamOpened,
  StreamReset,
} from './streamProtocol.js'

export interface StreamReceiver {
  onStreamOpened?(m: StreamOpened): void
  onStreamItem(m: StreamItem): void
  onStreamDone(m: StreamDone): void
  onStreamReset(m: StreamReset): void
  onStreamError(m: StreamError): void
}
