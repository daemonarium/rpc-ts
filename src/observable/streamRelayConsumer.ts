/**
 * Port of cpp-rpc/src/observable/stream_relay_consumer.hpp.
 *
 * Relays one Observable consumer onto a MessageChannel as stream_* messages.
 * onChange: tryQueue stream_item; on failure one pending ObservablePromise.
 * Control signals never overtake a blocked item. onReset drops the blocked
 * item and resolves its promise.
 */

import type { MessageChannel } from '../MessageChannel.js'
import { ObservablePromise, type Change, type Consumer } from './types.js'
import { toStreamId, type StreamItem } from './streamProtocol.js'

enum Control {
  None = 0,
  Done = 1,
  Reset = 2,
  Error = 3,
}

export class StreamRelayConsumer implements Consumer {
  private readonly channel: MessageChannel
  private readonly streamId_: bigint
  private readonly since_: bigint
  private blockedItem: StreamItem | null = null
  private blockedPromise: ObservablePromise | null = null
  private pendingControl = Control.None
  private pendingError = ''

  constructor(channel: MessageChannel, streamId: bigint | number, since: bigint | number) {
    this.channel = channel
    this.streamId_ = toStreamId(streamId)
    this.since_ = typeof since === 'bigint' ? since : BigInt(since)
  }

  streamId(): bigint {
    return this.streamId_
  }

  sinceTimestamp(): bigint {
    return this.since_
  }

  onChange(ch: Change): ObservablePromise {
    if (this.pendingControl === Control.Reset) {
      if (!this.flushControl()) {
        return this.blockItem(this.toItem(ch))
      }
    }
    const item = this.toItem(ch)
    if (this.channel.tryQueueMessage('stream_item', item)) {
      return ObservablePromise.resolved()
    }
    return this.blockItem(item)
  }

  onReady(): void {
    if (this.blockedItem) {
      this.pendingControl = Control.Done
      return
    }
    this.queueControl(Control.Done)
  }

  onReset(): void {
    if (this.blockedItem) {
      this.blockedItem = null
      this.resolveBlocked()
    }
    this.queueControl(Control.Reset)
  }

  onError(ex: unknown): void {
    this.pendingError = exceptionMessage(ex)
    if (this.blockedItem) {
      this.pendingControl = Control.Error
      return
    }
    this.queueControl(Control.Error)
  }

  onClosed(): void {
    this.pendingError = 'closed'
    if (this.blockedItem) {
      this.pendingControl = Control.Error
      return
    }
    this.queueControl(Control.Error)
  }

  onWritable(): void {
    if (this.pendingControl === Control.Reset) {
      if (!this.flushControl()) return
    }
    if (this.blockedItem) {
      if (!this.channel.tryQueueMessage('stream_item', this.blockedItem)) {
        return
      }
      this.blockedItem = null
      this.resolveBlocked()
      if (this.blockedItem) return
    }
    this.flushControl()
  }

  private toItem(ch: Change): StreamItem {
    return {
      stream_id: this.streamId_,
      key: ch.key,
      value: ch.value,
      timestamp: ch.ts,
    }
  }

  private blockItem(item: StreamItem): ObservablePromise {
    this.blockedItem = item
    this.blockedPromise = new ObservablePromise()
    return this.blockedPromise
  }

  private resolveBlocked(): void {
    const p = this.blockedPromise
    this.blockedPromise = null
    if (p) p.resolve()
  }

  private queueControl(c: Control): void {
    this.pendingControl = c
    this.flushControl()
  }

  private flushControl(): boolean {
    if (this.pendingControl === Control.None) return true
    let ok = false
    if (this.pendingControl === Control.Done) {
      ok = this.channel.tryQueueMessage('stream_done', { stream_id: this.streamId_ })
    } else if (this.pendingControl === Control.Reset) {
      ok = this.channel.tryQueueMessage('stream_reset', { stream_id: this.streamId_ })
    } else if (this.pendingControl === Control.Error) {
      ok = this.channel.tryQueueMessage('stream_error', {
        stream_id: this.streamId_,
        message: this.pendingError,
      })
    }
    if (ok) {
      this.pendingControl = Control.None
      this.pendingError = ''
    }
    return ok
  }
}

function exceptionMessage(ex: unknown): string {
  if (!ex) return 'error'
  if (ex instanceof Error) return ex.message
  if (typeof ex === 'string') return ex
  const obj = ex as { what?: unknown, message?: unknown }
  if (typeof obj.what === 'string') return obj.what
  if (typeof obj.message === 'string') return obj.message
  return 'error'
}
