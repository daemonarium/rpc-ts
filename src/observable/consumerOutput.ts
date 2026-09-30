/**
 * Port of cpp-rpc/src/observable/consumer_output.hpp.
 */

import { RingBuffer } from './ringBuffer.js'
import {
  ObservablePromise,
  isPendingPromise,
  whenResolved,
  type Change,
  type ChangePromise,
  type Consumer,
  type DispatchCallbacks,
  toTs,
} from './types.js'

export abstract class ObservableBase {
  abstract removeOutput(out: ConsumerOutput): void
  abstract onConsumerPaused(out: ConsumerOutput): void
  abstract onConsumerResumed(out: ConsumerOutput): void

  protected onStart(): void {}
  protected onStop(): void {}
  protected onPause(): void {}
  protected onResume(): void {}
}

export interface ConsumerFinalizer {
  register(target: object, held: ConsumerOutput, unregisterToken: object): void
  unregister(unregisterToken: object): void
}

function defaultConsumerFinalizer(): ConsumerFinalizer | null {
  if (typeof FinalizationRegistry === 'undefined') return null
  return new FinalizationRegistry<ConsumerOutput>((out) => {
    if (!out.detached()) out.unsubscribe()
  })
}

let consumerFinalizer: ConsumerFinalizer | null = defaultConsumerFinalizer()

/** Test hook: inject a fake registry, or restore the real one with null. */
export function setConsumerFinalizerForTest(reg: ConsumerFinalizer | null | undefined): void {
  consumerFinalizer = reg === undefined ? defaultConsumerFinalizer() : reg
}

export class ConsumerOutput {
  private owner: ObservableBase | null
  private readonly consumerRef: WeakRef<object> | null
  private readonly consumerAlive: () => boolean
  private readonly dispatch: DispatchCallbacks
  private readonly buffer: RingBuffer<Change>
  private replayWatermark_ = 0n
  private inFlight: ChangePromise | null = null
  private paused_ = false
  private detached_ = false

  constructor(
    owner: ObservableBase,
    consumerRef: object | null,
    dispatch: DispatchCallbacks,
    replayWatermark: bigint | number,
    bufferLimit: number
  ) {
    this.owner = owner
    this.consumerRef = consumerRef ? new WeakRef(consumerRef) : null
    this.consumerAlive = () => {
      if (!this.consumerRef) return true
      const c = this.consumerRef.deref()
      if (!c) return false
      const alive = (c as Consumer).isAlive
      if (typeof alive === 'function') return alive.call(c)
      return true
    }
    this.dispatch = dispatch
    this.buffer = new RingBuffer<Change>(bufferLimit)
    this.replayWatermark_ = toTs(replayWatermark)
    if (consumerRef && consumerFinalizer) {
      consumerFinalizer.register(consumerRef, this, this)
    }
  }

  replayWatermark(): bigint {
    return this.replayWatermark_
  }

  isPaused(): boolean {
    return this.paused_
  }

  isConsumerDead(): boolean {
    return !this.consumerAlive()
  }

  detached(): boolean {
    return this.detached_
  }

  emit(c: Change): void {
    if (this.detached_) return
    if (this.isConsumerDead()) {
      this.detach()
      return
    }
    if (this.inFlight) {
      if (!this.buffer.push(c)) {
        this.setPaused(true)
        return
      }
      if (this.buffer.full()) this.setPaused(true)
      return
    }
    this.deliver(c)
  }

  replayDirect(c: Change): void {
    if (this.detached_ || this.isConsumerDead()) return
    if (c.ts > this.replayWatermark_) this.replayWatermark_ = c.ts
    if (!this.dispatch.onChange) return
    const p = this.dispatch.onChange(c)
    if (isPendingPromise(p)) {
      this.inFlight = p
      whenResolved(p, () => this.drain())
    }
  }

  dispatchReset(): void {
    this.buffer.clear()
    this.replayWatermark_ = 0n
    this.setPaused(false)
    if (this.dispatch.onReset) this.dispatch.onReset()
  }

  dispatchReady(): void {
    if (this.dispatch.onReady) this.dispatch.onReady()
  }

  dispatchError(ex: unknown): void {
    if (this.dispatch.onError) this.dispatch.onError(ex)
  }

  dispatchClosed(): void {
    if (this.dispatch.onClosed) this.dispatch.onClosed()
  }

  unsubscribe(): void {
    this.detach()
  }

  private deliver(c: Change): void {
    if (c.ts > this.replayWatermark_) this.replayWatermark_ = c.ts
    if (!this.dispatch.onChange) return
    const p = this.dispatch.onChange(c)
    if (isPendingPromise(p)) {
      this.inFlight = p
      whenResolved(p, () => this.drain())
    }
  }

  private drain(): void {
    this.inFlight = null
    while (!this.buffer.empty()) {
      const next = this.buffer.pop()
      if (!next) break
      if (!this.dispatch.onChange) continue
      if (next.ts > this.replayWatermark_) this.replayWatermark_ = next.ts
      const p = this.dispatch.onChange(next)
      if (isPendingPromise(p)) {
        this.inFlight = p
        whenResolved(p, () => this.drain())
        if (this.buffer.full()) this.setPaused(true)
        else this.setPaused(false)
        return
      }
    }
    this.setPaused(false)
  }

  private setPaused(p: boolean): void {
    if (this.paused_ === p) return
    this.paused_ = p
    if (!this.owner || this.detached_) return
    if (p) this.owner.onConsumerPaused(this)
    else this.owner.onConsumerResumed(this)
  }

  private detach(): void {
    if (this.detached_) return
    this.detached_ = true
    consumerFinalizer?.unregister(this)
    if (this.paused_) {
      this.paused_ = false
      if (this.owner) this.owner.onConsumerResumed(this)
    }
    const owner = this.owner
    this.owner = null
    if (owner) owner.removeOutput(this)
  }
}

export function wrapConsumerCallbacks(consumer: Consumer): DispatchCallbacks {
  const weak = new WeakRef(consumer)
  const lock = (): Consumer | undefined => {
    const c = weak.deref()
    if (!c) return undefined
    if (typeof c.isAlive === 'function' && !c.isAlive()) return undefined
    return c
  }
  return {
    onChange: (ch) => {
      const c = lock()
      if (!c) return ObservablePromise.resolved()
      return c.onChange(ch)
    },
    onReady: () => {
      lock()?.onReady()
    },
    onReset: () => {
      lock()?.onReset()
    },
    onError: (ex) => {
      lock()?.onError(ex)
    },
    onClosed: () => {
      lock()?.onClosed()
    },
  }
}
