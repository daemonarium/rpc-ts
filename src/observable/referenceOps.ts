import type { StreamReceiver } from './streamReceiver.js'

export interface Disposable {
  dispose(): void
}

export interface ReferenceOps {
  setReference(): void | Promise<void>
  observe(receiver: StreamReceiver, since?: bigint | number): void | Promise<void>
  fetch(
    receiver: StreamReceiver,
    flags?: number,
    since?: bigint | number
  ): void | Promise<void>
  unobserve(): void | Promise<void>
  dispose(): void | Promise<void>
  /** Direct/registry handles stay alive across idle. Gateway drops. */
  readonly persistent?: boolean
}
