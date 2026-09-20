/**
 * Port of cpp-rpc/src/observable/types.hpp.
 *
 * onChange returns ObservablePromise: resolved = sync path, pending = backpressure.
 * Native Promise is treated as pending (microtask). Recording consumers return
 * ObservablePromise.resolved() so they stay synchronous like C++.
 */

export type PromiseState = 'pending' | 'resolved' | 'rejected'

export class ObservablePromise {
  state: PromiseState = 'pending'
  private resolvedHandlers: Array<() => void> = []

  static resolved(): ObservablePromise {
    const p = new ObservablePromise()
    p.resolve()
    return p
  }

  resolve(): void {
    if (this.state !== 'pending') return
    this.state = 'resolved'
    const handlers = this.resolvedHandlers
    this.resolvedHandlers = []
    for (const handler of handlers) handler()
  }

  onResolved(handler: () => void): void {
    if (this.state === 'resolved') {
      handler()
      return
    }
    this.resolvedHandlers.push(handler)
  }
}

export type ChangePromise = ObservablePromise | Promise<void>

export function isPendingPromise(p: ChangePromise | null | undefined): boolean {
  if (!p) return false
  if (p instanceof ObservablePromise) return p.state === 'pending'
  return true
}

export function whenResolved(p: ChangePromise, fn: () => void): void {
  if (p instanceof ObservablePromise) {
    p.onResolved(fn)
    return
  }
  void p.then(fn)
}

export interface BinaryEntry {
  key: Uint8Array
  value: Uint8Array
  ts: bigint
}

export interface Change {
  key: Uint8Array
  value: Uint8Array
  ts: bigint
}

export enum ObservableState {
  idle = 'idle',
  loading = 'loading',
  ready = 'ready',
  reloading = 'reloading',
  error = 'error',
  closed = 'closed',
}

export class DbIoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'db_io_error'
  }
}

export interface Consumer {
  onChange(ch: Change): ChangePromise
  onReady(): void
  onReset(): void
  onError(err: unknown): void
  onClosed(): void
  sinceTimestamp(): bigint | number
  /** Optional: deterministic death without relying on GC (C++ weak_ptr expiry). */
  isAlive?(): boolean
}

export interface DispatchCallbacks {
  onChange?: (ch: Change) => ChangePromise
  onReady?: () => void
  onReset?: () => void
  onError?: (err: unknown) => void
  onClosed?: () => void
}

export function toTs(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
}

export function copyBytes(src: Uint8Array): Uint8Array {
  return new Uint8Array(src)
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

export function keyId(key: Uint8Array): string {
  let s = ''
  for (let i = 0; i < key.length; i++) {
    s += key[i].toString(16).padStart(2, '0')
  }
  return s
}
