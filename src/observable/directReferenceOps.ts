import type { MessageChannel } from '../MessageChannel.js'
import type { StreamMultiplexer, StreamStarter } from './streamMultiplexer.js'
import type { StreamReceiver } from './streamReceiver.js'
import { stream_flags } from './streamProtocol.js'
import type { ReferenceOps } from './referenceOps.js'

/**
 * Direct (non-gateway) ops. observe/fetch start a mux stream; setReference
 * and dispose are no-ops because RemoteRegistry owns the handle across idle.
 */
export class DirectReferenceOps<
  Starter extends StreamStarter = StreamStarter,
  Channel extends MessageChannel = MessageChannel
> implements ReferenceOps {
  readonly persistent = true
  private readonly mux: StreamMultiplexer<Starter, Channel>
  private readonly functionId: bigint
  private readonly args: unknown[]
  private streamId = 0n

  constructor(
    mux: StreamMultiplexer<Starter, Channel>,
    functionId: bigint | number,
    args: unknown[]
  ) {
    this.mux = mux
    this.functionId = typeof functionId === 'bigint' ? functionId : BigInt(functionId)
    this.args = args
  }

  setReference(): void {}

  observe(receiver: StreamReceiver, since: bigint | number = 0n): void {
    this.streamId = this.mux.createStream(
      this.functionId, since, receiver, stream_flags.observe, ...this.args
    )
  }

  fetch(
    receiver: StreamReceiver,
    flags: number = stream_flags.none,
    since: bigint | number = 0n
  ): void {
    this.streamId = this.mux.createStream(
      this.functionId, since, receiver, flags, ...this.args
    )
  }

  unobserve(): void {
    if (this.streamId === 0n) return
    this.mux.cancelStream(this.streamId)
    this.streamId = 0n
  }

  dispose(): void {}
}
