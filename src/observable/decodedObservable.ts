/**
 * Typed lens over Observable<BinaryEntry>.
 *
 * Decodes key/value at the boundary and keeps its own LWW map that PRESERVES
 * tombstones as `value: null` (parallel to a future C++ decoded_observable<K, V>
 * using std::optional<V>). The source Observable drops tombstones internally;
 * this layer keeps them so consumers can distinguish "deleted" from "never seen".
 *
 * Lazy like Observable: the source is subscribed only while this object has at
 * least one own consumer. The last unsubscribe cancels the source subscription
 * (which, for RemoteObservable, sends stream_cancel). The decoded map survives
 * idle so a resubscribe replays it.
 */

import { ConsumerOutput } from './consumerOutput.js'
import { Observable } from './observable.js'
import {
  ObservablePromise,
  compareBytes,
  keyId,
  type BinaryEntry,
  type Change,
  type ChangePromise,
  type ObservableState,
} from './types.js'

export interface DecodedEntry<K, V> {
  key: K
  value: V | null  // null = tombstone
  ts: bigint
}

export interface DecodedConsumer<K, V> {
  onChange(e: DecodedEntry<K, V>): ChangePromise
  onReady?(): void
  onReset?(): void
  onError?(err: unknown): void
  onClosed?(): void
  isAlive?(): boolean
}

interface Stored<K, V> {
  rawKey: Uint8Array
  entry: DecodedEntry<K, V>
}

export class DecodedOutput<K, V> {
  constructor(readonly consumer: DecodedConsumer<K, V>) {}
  alive = true
}

export class DecodedObservable<K, V> {
  private readonly source: Observable<BinaryEntry>
  private readonly decodeKey: (k: Uint8Array) => K
  private readonly decodeValue: (v: Uint8Array) => V
  private readonly entries = new Map<string, Stored<K, V>>()  // keyed by keyId(rawKey)
  private readonly keyToRawId = new Map<K, string>()
  private readonly outputs: DecodedOutput<K, V>[] = []
  private maxTs_ = 0n
  private sourceOutput: ConsumerOutput | null = null

  constructor(
    source: Observable<BinaryEntry>,
    decodeKey: (k: Uint8Array) => K,
    decodeValue: (v: Uint8Array) => V,
  ) {
    this.source = source
    this.decodeKey = decodeKey
    this.decodeValue = decodeValue
  }

  subscribe(consumer: DecodedConsumer<K, V>): DecodedOutput<K, V> {
    const out = new DecodedOutput(consumer)
    this.outputs.push(out)
    // Replay the retained decoded map before subscribing the source. The source
    // replays its own view on subscribe, and handleChange drops those duplicates
    // (equal ts), so replaying first avoids delivering the same entry twice.
    for (const e of this.getEntries()) {
      consumer.onChange(e)
    }
    if (this.sourceOutput === null) {
      // First own consumer: subscribe the source (triggers its onStart).
      this.sourceOutput = this.source.subscribe({}, {
        onChange: (c) => this.handleChange(c),
        onReady: () => this.dispatchReady(),
        onReset: () => this.handleReset(),
        onError: (e) => this.dispatchError(e),
        onClosed: () => this.dispatchClosed(),
      })
    }
    return out
  }

  unsubscribe(out: DecodedOutput<K, V>): void {
    const idx = this.outputs.indexOf(out)
    if (idx < 0) return
    out.alive = false
    this.outputs.splice(idx, 1)
    if (this.outputs.length === 0 && this.sourceOutput !== null) {
      // Last own consumer left: drop the source subscription (triggers its onStop).
      this.sourceOutput.unsubscribe()
      this.sourceOutput = null
    }
  }

  /** Unsubscribe every own consumer (used by Vue on unmount). */
  dispose(): void {
    while (this.outputs.length > 0) {
      this.unsubscribe(this.outputs[0])
    }
  }

  getEntries(): DecodedEntry<K, V>[] {
    const out = [...this.entries.values()]
    out.sort((a, b) => compareBytes(a.rawKey, b.rawKey))
    return out.map((s) => s.entry)
  }

  get(key: K): DecodedEntry<K, V> | undefined {
    const id = this.keyToRawId.get(key)
    if (id === undefined) return undefined
    return this.entries.get(id)?.entry
  }

  state(): ObservableState { return this.source.state() }
  maxTs(): bigint { return this.maxTs_ }
  lastError(): unknown { return this.source.lastError() }
  readyPromise(): ObservablePromise { return this.source.readyPromise() }

  private handleChange(c: Change): ObservablePromise {
    const id = keyId(c.key)
    const existing = this.entries.get(id)
    // LWW: older drops, equal ts is a duplicate (source replays its retained
    // view on resubscribe) and must not be re-dispatched.
    if (existing && c.ts <= existing.entry.ts) {
      return ObservablePromise.resolved()
    }
    const entry: DecodedEntry<K, V> = {
      key: this.decodeKey(c.key),
      value: c.value.length === 0 ? null : this.decodeValue(c.value),
      ts: c.ts,
    }
    this.entries.set(id, { rawKey: c.key, entry })
    this.keyToRawId.set(entry.key, id)
    if (c.ts > this.maxTs_) this.maxTs_ = c.ts
    this.dispatchChange(entry)
    return ObservablePromise.resolved()
  }

  private handleReset(): void {
    this.entries.clear()
    this.keyToRawId.clear()
    this.maxTs_ = 0n
    this.dispatchReset()
  }

  private dispatchChange(e: DecodedEntry<K, V>): void {
    for (const out of this.outputs.slice()) {
      if (out.alive) out.consumer.onChange(e)
    }
  }

  private dispatchReady(): void {
    for (const out of this.outputs) if (out.alive) out.consumer.onReady?.()
  }

  private dispatchReset(): void {
    for (const out of this.outputs) if (out.alive) out.consumer.onReset?.()
  }

  private dispatchError(e: unknown): void {
    for (const out of this.outputs) if (out.alive) out.consumer.onError?.(e)
  }

  private dispatchClosed(): void {
    for (const out of this.outputs) if (out.alive) out.consumer.onClosed?.()
  }
}

export function decodeObservable<K, V>(
  source: Observable<BinaryEntry>,
  decodeKey: (k: Uint8Array) => K,
  decodeValue: (v: Uint8Array) => V,
): DecodedObservable<K, V> {
  return new DecodedObservable(source, decodeKey, decodeValue)
}
