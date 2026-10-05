/**
 * Port of cpp-rpc/src/observable/remote_observable.hpp.
 *
 * Wire → Observable bridge. "Remote" = across a MessageChannel
 * (LocalSocket, WebSocket, SockJS, mock). On first subscribe sends start
 * via the muxer (function_id + args, since = maxTs). On last unsubscribe
 * sends stream_cancel.
 */

import type { MessageChannel } from '../MessageChannel.js'
import { Observable } from './observable.js'
import type { StreamMultiplexer, StreamStarter } from './streamMultiplexer.js'
import type { StreamReceiver } from './streamReceiver.js'
import { stream_flags } from './streamProtocol.js'
import { DbIoError, toTs, type BinaryEntry } from './types.js'
import type { StreamDone, StreamError, StreamItem, StreamKey, StreamOpened, StreamReset } from './streamProtocol.js'

export class RemoteObservable<
  Starter extends StreamStarter = StreamStarter,
  Channel extends MessageChannel = MessageChannel
> extends Observable<BinaryEntry> implements StreamReceiver {
  private readonly mux: StreamMultiplexer<Starter, Channel>
  private readonly functionId_: bigint
  private readonly flags_: number
  private readonly args_: unknown[]
  private streamId_ = 0n

  constructor(
    mux: StreamMultiplexer<Starter, Channel>,
    functionId: bigint | number,
    flags: number = stream_flags.none,
    ...args: unknown[]
  ) {
    super()
    this.mux = mux
    this.functionId_ = typeof functionId === 'bigint' ? functionId : BigInt(functionId)
    this.flags_ = flags
    this.args_ = args
  }

  streamId(): bigint {
    return this.streamId_
  }

  functionId(): bigint {
    return this.functionId_
  }

  onStreamOpened(_m: StreamOpened): void {}

  onStreamItem(m: StreamItem): void {
    this.onItem({
      key: m.key,
      value: m.value,
      ts: toTs(m.timestamp),
    })
  }

  onStreamKey(m: StreamKey): void {
    this.onItem({
      key: m.key,
      value: new Uint8Array([0]),
      ts: toTs(m.timestamp),
    })
  }

  onStreamDone(_m: StreamDone): void {
    this.onDone()
  }

  onStreamReset(_m: StreamReset): void {
    this.onReset()
  }

  onStreamError(m: StreamError): void {
    this.onError(new DbIoError(m.message))
  }

  protected override onStart(): void {
    this.streamId_ = this.mux.createStream(this.functionId_, this.maxTs(), this, this.flags_, ...this.args_)
  }

  protected override onStop(): void {
    this.stopStream()
  }

  protected override onPause(): void {}
  protected override onResume(): void {}

  private stopStream(): void {
    if (this.streamId_ === 0n) return
    this.mux.cancelStream(this.streamId_)
    this.streamId_ = 0n
  }
}
