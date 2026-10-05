/**
 * Port of cpp-rpc/src/observable/stream_multiplexer.hpp.
 *
 * Demuxes stream_* messages by stream_id on a MessageChannel.
 * Start RPCs go through a Starter (any type with call(functionId, args...)).
 * Cancel is a stream_cancel message on the Channel.
 */

import type { MessageChannel } from '../MessageChannel.js'
import type { StreamReceiver } from './streamReceiver.js'
import {
  toStreamId,
  type StreamCancel,
  type StreamDone,
  type StreamError,
  type StreamHandle,
  type StreamItem,
  type StreamKey,
  type StreamOpened,
  type StreamReset,
} from './streamProtocol.js'

export interface StreamStarter {
  call(functionId: number, ...args: unknown[]): unknown
}

export class StreamMultiplexer<
  Starter extends StreamStarter = StreamStarter,
  Channel extends MessageChannel = MessageChannel
> {
  private readonly starter: Starter
  private readonly channel: Channel
  private readonly returnPid_: bigint
  private readonly returnSocket_: number
  private readonly receivers = new Map<bigint, StreamReceiver>()
  private readonly opened = new Set<bigint>()
  private readonly cancelBeforeOpen = new Set<bigint>()
  private nextId = 1n

  constructor(
    starter: Starter,
    channel: Channel,
    returnPid: bigint | number,
    returnSocket: number
  )
  constructor(
    client: Starter & Channel,
    returnPid: bigint | number,
    returnSocket: number
  )
  constructor(
    starter: Starter,
    channelOrPid: Channel | bigint | number,
    returnPidOrSocket?: bigint | number,
    returnSocket?: number
  ) {
    this.starter = starter
    if (typeof channelOrPid === 'object') {
      this.channel = channelOrPid
      this.returnPid_ = typeof returnPidOrSocket === 'bigint'
        ? returnPidOrSocket
        : BigInt(returnPidOrSocket ?? 0)
      this.returnSocket_ = returnSocket ?? 0
    } else {
      this.channel = starter as unknown as Channel
      this.returnPid_ = typeof channelOrPid === 'bigint' ? channelOrPid : BigInt(channelOrPid)
      this.returnSocket_ = typeof returnPidOrSocket === 'number' ? returnPidOrSocket : Number(returnPidOrSocket ?? 0)
    }
    this.install()
  }

  createStream(
    functionId: bigint | number,
    sinceTs: bigint | number,
    receiver: StreamReceiver | null,
    flags: number = 0,
    ...args: unknown[]
  ): bigint {
    const id = this.nextId
    this.nextId += 1n
    const handle: StreamHandle = {
      pid: this.returnPid_,
      socket: this.returnSocket_,
      stream_id: id,
      since_timestamp: sinceTs,
      flags,
    }
    if (receiver) this.receivers.set(id, receiver)
    try {
      const started = this.starter.call(Number(functionId), handle, ...args)
      void Promise.resolve(started).catch((err: unknown) => {
        const r = this.receivers.get(id)
        if (!r) return
        const message = err instanceof Error ? err.message : String(err)
        r.onStreamError({ stream_id: id, message })
      })
    } catch (err: unknown) {
      const r = this.receivers.get(id)
      if (r) {
        const message = err instanceof Error ? err.message : String(err)
        r.onStreamError({ stream_id: id, message })
      }
    }
    return id
  }

  cancelStream(id: bigint | number): void {
    const sid = toStreamId(id)
    this.receivers.delete(sid)
    this.channel.sendMessage('stream_cancel', { stream_id: sid } satisfies StreamCancel)
    if (!this.opened.delete(sid)) {
      this.cancelBeforeOpen.add(sid)
    }
  }

  /** Attach a receiver for an id allocated outside createStream (gateway ref_id). */
  attachReceiver(streamId: bigint | number, receiver: StreamReceiver | null): void {
    const id = toStreamId(streamId)
    if (receiver) this.receivers.set(id, receiver)
    else this.receivers.delete(id)
  }

  size(): number {
    return this.receivers.size
  }

  returnPid(): bigint {
    return this.returnPid_
  }

  returnSocket(): number {
    return this.returnSocket_
  }

  private install(): void {
    this.channel.onMessage('stream_opened', (msg: StreamOpened) => {
      this.onOpened(msg)
    })
    this.channel.onMessage('stream_item', (msg: StreamItem) => {
      this.dispatch(toStreamId(msg.stream_id), (r) => r.onStreamItem(msg))
    })
    this.channel.onMessage('stream_key', (msg: StreamKey) => {
      this.dispatch(toStreamId(msg.stream_id), (r) => {
        if (r.onStreamKey) {
          r.onStreamKey(msg)
          return
        }
        r.onStreamItem({
          stream_id: msg.stream_id,
          key: msg.key,
          value: new Uint8Array([0]),
          timestamp: msg.timestamp,
        })
      })
    })
    this.channel.onMessage('stream_done', (msg: StreamDone) => {
      this.dispatch(toStreamId(msg.stream_id), (r) => r.onStreamDone(msg))
    })
    this.channel.onMessage('stream_reset', (msg: StreamReset) => {
      this.dispatch(toStreamId(msg.stream_id), (r) => r.onStreamReset(msg))
    })
    this.channel.onMessage('stream_error', (msg: StreamError) => {
      this.dispatch(toStreamId(msg.stream_id), (r) => r.onStreamError(msg))
    })
  }

  private onOpened(m: StreamOpened): void {
    const id = toStreamId(m.stream_id)
    if (this.cancelBeforeOpen.delete(id)) {
      this.channel.sendMessage('stream_cancel', { stream_id: id } satisfies StreamCancel)
      return
    }
    this.opened.add(id)
    this.dispatch(id, (r) => r.onStreamOpened?.(m))
  }

  private dispatch(id: bigint, f: (r: StreamReceiver) => void): void {
    const r = this.receivers.get(id)
    if (!r) return
    f(r)
  }
}
