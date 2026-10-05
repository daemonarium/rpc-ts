/**
 * Virtual-socket multiplexer on a MessageChannel.
 *
 * mux_socket_data is credit-windowed per socket_id (bytes only). Control
 * frames (open/close/window) always go through. DRR + aging shares the
 * underlying channel across sockets so one stalled stream cannot HOL-block
 * the rest.
 *
 * socket_id is uint32 on the wire (uvarint32 in compressed). 0 is reserved.
 */

import type { MessageChannel } from '../MessageChannel.js'
import { TypeDescription, TypeKind, type TypeRegistry } from '../typeDescription.js'
import { ObservablePromise } from './types.js'

export const MUX_SOCKET_OPEN = 'mux_socket_open'
export const MUX_SOCKET_DATA = 'mux_socket_data'
export const MUX_SOCKET_CLOSE = 'mux_socket_close'
export const MUX_SOCKET_WINDOW = 'mux_socket_window'

export const MUX_SOCKET_MESSAGE_TYPES = [
  MUX_SOCKET_OPEN,
  MUX_SOCKET_DATA,
  MUX_SOCKET_CLOSE,
  MUX_SOCKET_WINDOW
] as const

/** socket_id 0 is reserved for session RPC / api_message. */
export const MUX_SOCKET_RPC_RESERVED = 0

export const MUX_KIND_OBSERVE = 0
export const MUX_KIND_FETCH = 1
export const MUX_KIND_PIPE = 2

export const DEFAULT_MUX_WINDOW = 16384
export const DEFAULT_MUX_QUANTUM = 4096

export interface MuxSocketOpen {
  socket_id: number
  kind: number
  ref_id: number
  cookie: number
}

export interface MuxSocketData {
  socket_id: number
  payload: Uint8Array
}

export interface MuxSocketClose {
  socket_id: number
}

export interface MuxSocketWindow {
  socket_id: number
  add_bytes: number
}

export interface SocketMuxOptions {
  quantum?: number
  defaultWindow?: number
  onData?: (socketId: number, payload: Uint8Array) => void
  onOpen?: (socketId: number, kind: number, refId: number, cookie: number) => void
  onClose?: (socketId: number) => void
}

interface Outbound {
  payload: Uint8Array
  promise: ObservablePromise
}

interface Slot {
  id: number
  remaining: number
  sent: number
  outbound: Outbound[]
  deficit: number
  starved: number
  openedLocal: boolean
  grantPaused: boolean
  unacked: number
}

function toU32(value: bigint | number | undefined): number {
  if (typeof value === 'bigint') return Number(value) >>> 0
  if (typeof value === 'number') return value >>> 0
  return 0
}

function satAddU32(a: number, b: number): number {
  const sum = a + b
  return sum > 0xffffffff ? 0xffffffff : sum
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array()
}

/** Add mux_socket_* message types to a type registry (session blob / codecs). */
export function addMuxSocketTypes(registry: TypeRegistry): void {
  const uint32 = registry.getTypeByName('uint32')
  const uint8 = registry.getTypeByName('uint8')
  const binary = registry.getTypeByName('binary')
  if (!uint32 || !uint8 || !binary) throw new Error('missing uint32, uint8 or binary')
  const message = (
    name: string,
    members: { name: string, type: typeof uint32 }[]
  ): void => {
    if (registry.getTypeByName(name)) return
    registry.registerType(TypeDescription.create({
      name,
      kind: TypeKind.Message,
      members: members.map((member) => ({ ...member, annotations: [] }))
    }))
  }
  message(MUX_SOCKET_OPEN, [
    { name: 'socket_id', type: uint32 },
    { name: 'kind', type: uint8 },
    { name: 'ref_id', type: uint32 },
    { name: 'cookie', type: uint32 }
  ])
  message(MUX_SOCKET_DATA, [
    { name: 'socket_id', type: uint32 },
    { name: 'payload', type: binary }
  ])
  message(MUX_SOCKET_CLOSE, [{ name: 'socket_id', type: uint32 }])
  message(MUX_SOCKET_WINDOW, [
    { name: 'socket_id', type: uint32 },
    { name: 'add_bytes', type: uint32 }
  ])
}

export function registerMuxSocketMessages(
  channel: { registerMessageType(typeName: string): void }
): void {
  for (const name of MUX_SOCKET_MESSAGE_TYPES) {
    channel.registerMessageType(name)
  }
}

export class SocketMux {
  private readonly channel: MessageChannel
  private readonly quantum: number
  private readonly defaultWindow: number
  private readonly onData?: SocketMuxOptions['onData']
  private readonly onOpen?: SocketMuxOptions['onOpen']
  private readonly onClose?: SocketMuxOptions['onClose']
  private readonly slots = new Map<number, Slot>()
  private pumping = false

  constructor(channel: MessageChannel, options: SocketMuxOptions = {}) {
    this.channel = channel
    this.quantum = options.quantum ?? DEFAULT_MUX_QUANTUM
    this.defaultWindow = options.defaultWindow ?? DEFAULT_MUX_WINDOW
    this.onData = options.onData
    this.onOpen = options.onOpen
    this.onClose = options.onClose
    channel.onMessage(MUX_SOCKET_OPEN, (msg: MuxSocketOpen) => {
      this.onPeerOpen(toU32(msg.socket_id), toU32(msg.kind), toU32(msg.ref_id), toU32(msg.cookie))
    })
    channel.onMessage(MUX_SOCKET_DATA, (msg: MuxSocketData) => {
      this.onPeerData(toU32(msg.socket_id), asBytes(msg.payload))
    })
    channel.onMessage(MUX_SOCKET_CLOSE, (msg: MuxSocketClose) => {
      this.onPeerClose(toU32(msg.socket_id))
    })
    channel.onMessage(MUX_SOCKET_WINDOW, (msg: MuxSocketWindow) => {
      this.onPeerWindow(toU32(msg.socket_id), toU32(msg.add_bytes))
    })
    channel.onWritable(() => this.pump())
  }

  defaultWindowBytes(): number {
    return this.defaultWindow
  }

  openSocket(
    socketId: bigint | number,
    kind = 0,
    refId: bigint | number = 0,
    cookie: bigint | number = 0
  ): void {
    const id = toU32(socketId)
    if (id === MUX_SOCKET_RPC_RESERVED) return
    const slot = this.ensure(id)
    if (slot.openedLocal) return
    slot.openedLocal = true
    this.channel.sendMessage(MUX_SOCKET_OPEN, {
      socket_id: id,
      kind: toU32(kind) & 0xff,
      ref_id: toU32(refId),
      cookie: toU32(cookie)
    })
  }

  closeSocket(socketId: bigint | number): void {
    const id = toU32(socketId)
    const slot = this.slots.get(id)
    if (!slot) return
    this.finishSlot(slot)
    this.slots.delete(id)
    this.channel.sendMessage(MUX_SOCKET_CLOSE, { socket_id: id })
  }

  sendData(socketId: bigint | number, payload: Uint8Array): ObservablePromise {
    const id = toU32(socketId)
    const slot = this.slots.get(id)
    if (!slot) return ObservablePromise.resolved()
    const promise = new ObservablePromise()
    slot.outbound.push({ payload, promise })
    this.pump()
    return promise
  }

  grantWindow(socketId: bigint | number, addBytes: number): void {
    const id = toU32(socketId)
    const slot = this.slots.get(id)
    if (!slot || addBytes <= 0) return
    if (slot.grantPaused) {
      slot.unacked = satAddU32(slot.unacked, addBytes >>> 0)
      return
    }
    this.channel.sendMessage(MUX_SOCKET_WINDOW, {
      socket_id: id,
      add_bytes: addBytes >>> 0
    })
  }

  setPaused(socketId: bigint | number, paused: boolean): void {
    const id = toU32(socketId)
    const slot = this.slots.get(id)
    if (!slot) return
    slot.grantPaused = paused
    if (!paused && slot.unacked > 0) {
      const n = slot.unacked
      slot.unacked = 0
      this.grantWindow(id, n)
    }
  }

  remaining(socketId: bigint | number): number {
    return this.slots.get(toU32(socketId))?.remaining ?? 0
  }

  sent(socketId: bigint | number): number {
    return this.slots.get(toU32(socketId))?.sent ?? 0
  }

  hasSocket(socketId: bigint | number): boolean {
    return this.slots.has(toU32(socketId))
  }

  outboundCount(socketId: bigint | number): number {
    return this.slots.get(toU32(socketId))?.outbound.length ?? 0
  }

  onWritable(): void {
    this.pump()
  }

  private ensure(id: number): Slot {
    let slot = this.slots.get(id)
    if (slot) return slot
    slot = {
      id,
      remaining: 0,
      sent: 0,
      outbound: [],
      deficit: 0,
      starved: 0,
      openedLocal: false,
      grantPaused: false,
      unacked: 0
    }
    this.slots.set(id, slot)
    return slot
  }

  private onPeerOpen(id: number, kind: number, refId: number, cookie: number): void {
    if (id === MUX_SOCKET_RPC_RESERVED) return
    this.ensure(id)
    this.onOpen?.(id, kind, refId, cookie)
  }

  private onPeerData(id: number, payload: Uint8Array): void {
    if (!this.slots.has(id)) return
    this.onData?.(id, payload)
  }

  private onPeerClose(id: number): void {
    const slot = this.slots.get(id)
    if (!slot) return
    this.finishSlot(slot)
    this.slots.delete(id)
    this.onClose?.(id)
  }

  private onPeerWindow(id: number, addBytes: number): void {
    const slot = this.slots.get(id)
    if (!slot) return
    slot.remaining = satAddU32(slot.remaining, addBytes)
    this.pump()
  }

  private finishSlot(slot: Slot): void {
    const queued = slot.outbound
    slot.outbound = []
    slot.remaining = 0
    slot.sent = 0
    slot.unacked = 0
    for (const item of queued) item.promise.resolve()
  }

  private consume(slot: Slot, size: number): void {
    slot.sent = satAddU32(slot.sent, size)
    if (slot.remaining > size) slot.remaining -= size
    else slot.remaining = 0
  }

  private pickReady(): Slot | null {
    const ready: Slot[] = []
    for (const slot of this.slots.values()) {
      if (slot.outbound.length > 0 && slot.remaining > 0) ready.push(slot)
    }
    if (ready.length === 0) return null
    ready.sort((a, b) => {
      if (b.starved !== a.starved) return b.starved - a.starved
      return a.id - b.id
    })
    const chosen = ready[0]
    for (const slot of ready) {
      if (slot !== chosen) slot.starved++
    }
    return chosen
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.channel.isWritable()) {
        const slot = this.pickReady()
        if (!slot) break
        if (slot.deficit <= 0) slot.deficit += this.quantum
        const item = slot.outbound[0]
        const ok = this.channel.tryQueueMessage(MUX_SOCKET_DATA, {
          socket_id: slot.id,
          payload: item.payload
        })
        if (!ok) break
        slot.outbound.shift()
        this.consume(slot, item.payload.length)
        slot.deficit = Math.max(0, slot.deficit - item.payload.length)
        slot.starved = 0
        item.promise.resolve()
      }
    } finally {
      this.pumping = false
      const sock = (this.channel as { socket?: { flush?: () => void } }).socket
      sock?.flush?.()
    }
  }
}
