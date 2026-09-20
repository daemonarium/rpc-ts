/**
 * Port of cpp-rpc/src/observable/stream_publisher.hpp.
 *
 * One Channel / socket. Attaches Observable<BinaryEntry> instances as
 * per-stream relays.
 */

import type { MessageChannel } from '../MessageChannel.js'
import type { Observable } from './observable.js'
import type { ConsumerOutput } from './consumerOutput.js'
import { StreamRelayConsumer } from './streamRelayConsumer.js'
import { toStreamId, type StreamCancel } from './streamProtocol.js'
import type { BinaryEntry } from './types.js'

interface Entry {
  consumer: StreamRelayConsumer
  subscription: ConsumerOutput | null
  obs: Observable<BinaryEntry>
  since: bigint
  bufferLimit: number
  opened: boolean
}

export class StreamPublisher {
  private readonly channel: MessageChannel
  private readonly streams = new Map<bigint, Entry>()
  private readonly pendingCancels = new Set<bigint>()

  constructor(channel: MessageChannel) {
    this.channel = channel
    this.channel.onMessage('stream_cancel', (msg: StreamCancel) => {
      this.onCancel(msg)
    })
  }

  attach(
    streamId: bigint | number,
    obs: Observable<BinaryEntry>,
    since: bigint | number = 0n,
    bufferLimit = 1024
  ): void {
    const id = toStreamId(streamId)
    if (this.pendingCancels.delete(id)) return
    this.detach(id)
    const entry: Entry = {
      consumer: new StreamRelayConsumer(this.channel, id, since),
      subscription: null,
      obs,
      since: typeof since === 'bigint' ? since : BigInt(since),
      bufferLimit,
      opened: false,
    }
    this.streams.set(id, entry)
    if (this.channel.tryQueueMessage('stream_opened', { stream_id: id })) {
      this.completeOpen(id)
    }
  }

  detach(streamId: bigint | number): void {
    const id = toStreamId(streamId)
    const entry = this.streams.get(id)
    if (!entry) return
    if (entry.subscription) {
      entry.subscription.unsubscribe()
      entry.subscription = null
    }
    this.streams.delete(id)
  }

  onCancel(m: StreamCancel): void {
    const id = toStreamId(m.stream_id)
    if (this.streams.has(id)) {
      this.detach(id)
    } else {
      this.pendingCancels.add(id)
    }
  }

  onWritable(): void {
    const ids = [...this.streams.keys()]
    for (const id of ids) {
      const entry = this.streams.get(id)
      if (!entry) continue
      if (!entry.opened) {
        if (!this.channel.tryQueueMessage('stream_opened', { stream_id: id })) {
          continue
        }
        this.completeOpen(id)
        if (!this.streams.has(id)) continue
      }
      this.streams.get(id)?.consumer.onWritable()
    }
  }

  size(): number {
    return this.streams.size
  }

  isAttached(streamId: bigint | number): boolean {
    return this.streams.has(toStreamId(streamId))
  }

  private completeOpen(streamId: bigint): void {
    const entry = this.streams.get(streamId)
    if (!entry || entry.opened) return
    entry.opened = true
    entry.subscription = entry.obs.subscribe(entry.consumer, entry.bufferLimit)
  }
}
