import type { StreamReceiver } from './streamReceiver.js'

export interface Disposable {
  dispose(): void
}

export interface ReferenceOps {
  setReference(): void | Promise<void>
  observe(receiver: StreamReceiver): void | Promise<void>
  fetch(receiver: StreamReceiver): void | Promise<void>
  unobserve(): void | Promise<void>
  dispose(): void | Promise<void>
  /** Direct/registry handles stay alive across idle. Gateway drops. */
  readonly persistent?: boolean
}
