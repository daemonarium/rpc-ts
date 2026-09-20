/**
 * Port of cpp-rpc/src/observable/observable.hpp.
 */

import { ConsumerOutput, ObservableBase, wrapConsumerCallbacks } from './consumerOutput.js'
import {
  ObservablePromise,
  ObservableState,
  compareBytes,
  copyBytes,
  keyId,
  toTs,
  type BinaryEntry,
  type Change,
  type Consumer,
  type DispatchCallbacks,
} from './types.js'

export class Observable<EntryT extends BinaryEntry = BinaryEntry> extends ObservableBase {
  private data = new Map<string, EntryT>()
  private oldData = new Map<string, EntryT>()
  private maxTs_ = 0n
  private outputs: ConsumerOutput[] = []
  private activeCount_ = 0
  private pausedCount_ = 0
  private state_: ObservableState = ObservableState.idle
  private readyPromise_: ObservablePromise = new ObservablePromise()
  private lastError_: unknown = null

  onItem(e: EntryT): void {
    if (this.state_ === ObservableState.closed) return
    this.sweepDeadOutputs()
    if (this.state_ === ObservableState.error) {
      this.state_ = ObservableState.loading
    }
    const ts = toTs(e.ts)
    if (ts > this.maxTs_) this.maxTs_ = ts

    const id = keyId(e.key)
    const existing = this.data.get(id)
    if (existing && existing.ts >= ts) {
      return
    }

    const ch: Change = {
      key: copyBytes(e.key),
      value: copyBytes(e.value),
      ts,
    }
    if (e.value.length === 0) {
      if (existing) this.data.delete(id)
    } else {
      this.data.set(id, { ...e, key: copyBytes(e.key), value: copyBytes(e.value), ts } as EntryT)
    }
    this.fanOut(ch)
  }

  onDone(): void {
    if (this.state_ === ObservableState.closed) return
    this.sweepDeadOutputs()
    if (this.state_ !== ObservableState.loading && this.state_ !== ObservableState.reloading) {
      return
    }
    this.oldData.clear()
    this.state_ = ObservableState.ready
    this.readyPromise_.resolve()
    const snapshot = this.outputs.slice()
    for (const out of snapshot) {
      if (out && !out.detached()) out.dispatchReady()
    }
  }

  onReset(): void {
    if (this.state_ === ObservableState.closed) return
    this.sweepDeadOutputs()
    if (
      this.state_ !== ObservableState.ready
      && this.state_ !== ObservableState.error
      && this.state_ !== ObservableState.loading
    ) {
      return
    }
    this.oldData = this.data
    this.data = new Map()
    this.state_ = ObservableState.reloading
    this.readyPromise_ = new ObservablePromise()
    const snapshot = this.outputs.slice()
    for (const out of snapshot) {
      if (out && !out.detached()) out.dispatchReset()
    }
  }

  onError(ex: unknown): void {
    if (this.state_ === ObservableState.closed) return
    this.sweepDeadOutputs()
    this.state_ = ObservableState.error
    this.lastError_ = ex
    const snapshot = this.outputs.slice()
    for (const out of snapshot) {
      if (out && !out.detached()) out.dispatchError(ex)
    }
  }

  subscribe(consumer: Consumer, bufferLimit?: number): ConsumerOutput | null
  subscribe(
    consumerRef: object,
    callbacks: DispatchCallbacks,
    sinceTimestamp?: bigint | number,
    bufferLimit?: number
  ): ConsumerOutput | null
  subscribe(
    consumerOrRef: Consumer | object,
    bufferLimitOrCallbacks: number | DispatchCallbacks = 1024,
    sinceTimestamp: bigint | number = 0,
    bufferLimit = 1024
  ): ConsumerOutput | null {
    if (this.state_ === ObservableState.closed) return null
    this.sweepDeadOutputs()

    let consumerRef: object
    let callbacks: DispatchCallbacks
    let since: bigint | number
    let limit: number

    if (typeof bufferLimitOrCallbacks === 'object') {
      consumerRef = consumerOrRef
      callbacks = bufferLimitOrCallbacks
      since = sinceTimestamp
      limit = bufferLimit
    } else {
      const consumer = consumerOrRef as Consumer
      consumerRef = consumer
      callbacks = wrapConsumerCallbacks(consumer)
      since = consumer.sinceTimestamp()
      limit = bufferLimitOrCallbacks
    }

    const out = new ConsumerOutput(this, consumerRef, callbacks, since, limit)
    this.outputs.push(out)
    this.activeCount_++
    if (this.state_ === ObservableState.idle) {
      this.state_ = ObservableState.loading
      this.onStart()
    }
    this.replayTo(out)
    if (this.state_ === ObservableState.ready) out.dispatchReady()
    else if (this.state_ === ObservableState.error) out.dispatchError(this.lastError_)
    return out
  }

  unsubscribe(out: ConsumerOutput): void {
    this.removeOutput(out)
  }

  readyPromise(): ObservablePromise {
    return this.readyPromise_
  }

  getEntries(): EntryT[] {
    const src = this.view()
    const out = [...src.values()]
    out.sort((a, b) => compareBytes(a.key, b.key))
    return out
  }

  get(key: Uint8Array): EntryT | undefined {
    const src = this.view()
    return src.get(keyId(key))
  }

  maxTs(): bigint {
    return this.maxTs_
  }

  state(): ObservableState {
    return this.state_
  }

  lastError(): unknown {
    return this.lastError_
  }

  activeCount(): number {
    return this.activeCount_
  }

  pausedCount(): number {
    return this.pausedCount_
  }

  kill(): void {
    if (this.state_ === ObservableState.closed) return
    const snapshot = this.outputs.slice()
    for (const out of snapshot) {
      if (out && !out.detached()) out.dispatchClosed()
    }
    this.outputs = []
    this.pausedCount_ = 0
    if (this.activeCount_ > 0) {
      this.activeCount_ = 0
      this.onStop()
    }
    this.state_ = ObservableState.closed
  }

  override removeOutput(out: ConsumerOutput): void {
    if (!out) return
    const idx = this.outputs.indexOf(out)
    if (idx < 0) return
    const wasPaused = this.outputs[idx].isPaused()
    this.outputs.splice(idx, 1)
    if (this.activeCount_ > 0) this.activeCount_--
    if (wasPaused && this.pausedCount_ > 0) this.pausedCount_--
    if (this.activeCount_ === 0 && this.state_ !== ObservableState.closed) {
      this.pausedCount_ = 0
      this.state_ = ObservableState.idle
      this.onStop()
    }
  }

  override onConsumerPaused(_out: ConsumerOutput): void {
    const before = this.pausedCount_
    this.pausedCount_++
    if (this.activeCount_ > 0 && before < this.activeCount_ && this.pausedCount_ >= this.activeCount_) {
      this.onPause()
    }
  }

  override onConsumerResumed(_out: ConsumerOutput): void {
    const wasAll = this.activeCount_ > 0 && this.pausedCount_ >= this.activeCount_
    if (this.pausedCount_ > 0) this.pausedCount_--
    if (wasAll && this.pausedCount_ < this.activeCount_) {
      this.onResume()
    }
  }

  protected override onStart(): void {}
  protected override onStop(): void {}
  protected override onPause(): void {}
  protected override onResume(): void {}

  private view(): Map<string, EntryT> {
    if (this.state_ === ObservableState.reloading) return this.oldData
    return this.data
  }

  private fanOut(c: Change): void {
    const snapshot = this.outputs.slice()
    for (const out of snapshot) {
      if (out && !out.detached()) out.emit(c)
    }
  }

  private replayTo(out: ConsumerOutput): void {
    const entries = [...this.data.values()].sort((a, b) => compareBytes(a.key, b.key))
    for (const e of entries) {
      if (e.ts > out.replayWatermark()) {
        out.replayDirect({ key: copyBytes(e.key), value: copyBytes(e.value), ts: e.ts })
      }
    }
  }

  private sweepDeadOutputs(): void {
    const snapshot = this.outputs.slice()
    for (const out of snapshot) {
      if (out && !out.detached() && out.isConsumerDead()) {
        out.unsubscribe()
      }
    }
  }
}
