/**
 * Port of cpp-rpc/src/observable/ring_buffer.hpp.
 * Bounded FIFO. push returns false when full (no overwrite, no drop).
 */

export class RingBuffer<T> {
  private readonly storage: Array<T | undefined>
  private readonly cap: number
  private head = 0
  private tail = 0
  private count = 0

  constructor(capacity: number) {
    this.cap = capacity
    this.storage = new Array(capacity)
  }

  push(v: T): boolean {
    if (this.cap === 0 || this.count === this.cap) return false
    this.storage[this.tail] = v
    this.tail = (this.tail + 1) % this.cap
    this.count++
    return true
  }

  pop(): T | undefined {
    if (this.count === 0) return undefined
    const v = this.storage[this.head]
    this.storage[this.head] = undefined
    this.head = (this.head + 1) % this.cap
    this.count--
    return v
  }

  size(): number {
    return this.count
  }

  capacity(): number {
    return this.cap
  }

  full(): boolean {
    return this.cap !== 0 && this.count === this.cap
  }

  empty(): boolean {
    return this.count === 0
  }

  clear(): void {
    while (this.count > 0) this.pop()
    this.head = 0
    this.tail = 0
  }
}
