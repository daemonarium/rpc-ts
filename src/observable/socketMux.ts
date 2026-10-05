/**
 * Virtual-socket multiplexer on a MessageChannel.
 *
 * mux_socket_data is credit-windowed per socket_id (bytes only). Control
 * frames (open/close/window) always go through. DRR + aging shares the
 * underlying channel across sockets so one stalled stream cannot HOL-block
 * the rest.
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
export const MUX_SOCKET_RPC_RESERVED = 0n

export const DEFAULT_MUX_WINDOW = 16384
export const DEFAULT_MUX_QUANTUM = 4096

export interface MuxSocketOpen {
  socket_id: bigint | number
}

export interface MuxSocketData {
  socket_id: bigint | number
  payload: Uint8Array
}

export interface MuxSocketClose {
  socket_id: bigint | number
}

export interface MuxSocketWindow {
  socket_id: bigint | number
  add_bytes: bigint | number
}

export interface SocketMuxOptions {
  quantum?: number
  defaultWindow?: number
  onData?: (socketId: bigint, payload: Uint8Array) => void
  onOpen?: (socketId: bigint) => void
  onClose?: (socketId: bigint) => void
}

interface Outbound {
  payload: Uint8Array
  promise: ObservablePromise
}

interface Slot {
  id: bigint
  remaining: bigint
  sent: bigint
  outbound: Outbound[]
  deficit: number
  starved: number
  openedLocal: boolean
  grantPaused: boolean
  unacked: number
}

function toId(value: bigint | number | undefined): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  return 0n
}

function satAdd(a: bigint, b: bigint): bigint {
  const max = 0xffffffffffffffffn
  if (b > max - a) return max
  return a + b
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array()
}

/** Add mux_socket_* message types to a type registry (session blob / codecs). */
export function addMuxSocketTypes(registry: TypeRegistry): void {
  const uint64 = registry.getTypeByName('uint64')
  const binary = registry.getTypeByName('binary')
  if (!uint64 || !binary) throw new Error('missing uint64 or binary')
  const message = (
    name: string,
    members: { name: string, type: typeof uint64 }[]
  ): void => {
    if (registry.getTypeByName(name)) return
    registry.registerType(TypeDescription.create({
      name,
      kind: TypeKind.Message,
      members: members.map((member) => ({ ...member, annotations: [] }))
    }))
  }
  message(MUX_SOCKET_OPEN, [{ name: 'socket_id', type: uint64 }])
  message(MUX_SOCKET_DATA, [
    { name: 'socket_id', type: uint64 },
    { name: 'payload', type: binary }
  ])
  message(MUX_SOCKET_CLOSE, [{ name: 'socket_id', type: uint64 }])
  message(MUX_SOCKET_WINDOW, [
    { name: 'socket_id', type: uint64 },
    { name: 'add_bytes', type: uint64 }
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
  private readonly slots = new Map<string, Slot>()
  private pumping = false

  constructor(channel: MessageChannel, options: SocketMuxOptions = {}) {
    this.channel = channel
    this.quantum = options.quantum ?? DEFAULT_MUX_QUANTUM
    this.defaultWindow = options.defaultWindow ?? DEFAULT_MUX_WINDOW
    this.onData = options.onData
    this.onOpen = options.onOpen
    this.onClose = options.onClose
    channel.onMessage(MUX_SOCKET_OPEN, (msg: MuxSocketOpen) => {
      this.onPeerOpen(toId(msg.socket_id))
    })
    channel.onMessage(MUX_SOCKET_DATA, (msg: MuxSocketData) => {
      this.onPeerData(toId(msg.socket_id), asBytes(msg.payload))
    })
    channel.onMessage(MUX_SOCKET_CLOSE, (msg: MuxSocketClose) => {
      this.onPeerClose(toId(msg.socket_id))
    })
    channel.onMessage(MUX_SOCKET_WINDOW, (msg: MuxSocketWindow) => {
      this.onPeerWindow(toId(msg.socket_id), toId(msg.add_bytes))
    })
    channel.onWritable(() => this.pump())
  }

  defaultWindowBytes(): number {
    return this.defaultWindow
  }

  openSocket(socketId: bigint | number): void {
    const id = toId(socketId)
    if (id === MUX_SOCKET_RPC_RESERVED) return
    const slot = this.ensure(id)
    if (slot.openedLocal) return
    slot.openedLocal = true
    this.channel.sendMessage(MUX_SOCKET_OPEN, { socket_id: id })
  }

  closeSocket(socketId: bigint | number): void {
    const id = toId(socketId)
    const slot = this.slots.get(id.toString())
    if (!slot) return
    this.finishSlot(slot)
    this.slots.delete(id.toString())
    this.channel.sendMessage(MUX_SOCKET_CLOSE, { socket_id: id })
  }

  sendData(socketId: bigint | number, payload: Uint8Array): ObservablePromise {
    const id = toId(socketId)
    const slot = this.slots.get(id.toString())
    if (!slot) return ObservablePromise.resolved()
    const promise = new ObservablePromise()
    slot.outbound.push({ payload, promise })
    this.pump()
    return promise
  }

  grantWindow(socketId: bigint | number, addBytes: number): void {
    const id = toId(socketId)
    const slot = this.slots.get(id.toString())
    if (!slot || addBytes <= 0) return
    if (slot.grantPaused) {
      slot.unacked += addBytes
      return
    }
    this.channel.sendMessage(MUX_SOCKET_WINDOW, {
      socket_id: id,
      add_bytes: BigInt(addBytes)
    })
  }

  setPaused(socketId: bigint | number, paused: boolean): void {
    const id = toId(socketId)
    const slot = this.slots.get(id.toString())
    if (!slot) return
    slot.grantPaused = paused
    if (!paused && slot.unacked > 0) {
      const n = slot.unacked
      slot.unacked = 0
      this.grantWindow(id, n)
    }
  }

  remaining(socketId: bigint | number): bigint {
    return this.slots.get(toId(socketId).toString())?.remaining ?? 0n
  }

  sent(socketId: bigint | number): bigint {
    return this.slots.get(toId(socketId).toString())?.sent ?? 0n
  }

  hasSocket(socketId: bigint | number): boolean {
    return this.slots.has(toId(socketId).toString())
  }

  outboundCount(socketId: bigint | number): number {
    return this.slots.get(toId(socketId).toString())?.outbound.length ?? 0
  }

  onWritable(): void {
    this.pump()
  }

  private ensure(id: bigint): Slot {
    const key = id.toString()
    let slot = this.slots.get(key)
    if (slot) return slot
    slot = {
      id,
      remaining: 0n,
      sent: 0n,
      outbound: [],
      deficit: 0,
      starved: 0,
      openedLocal: false,
      grantPaused: false,
      unacked: 0
    }
    this.slots.set(key, slot)
    return slot
  }

  private onPeerOpen(id: bigint): void {
    if (id === MUX_SOCKET_RPC_RESERVED) return
    this.ensure(id)
    this.onOpen?.(id)
  }

  private onPeerData(id: bigint, payload: Uint8Array): void {
    if (!this.slots.has(id.toString())) return
    this.onData?.(id, payload)
  }

  private onPeerClose(id: bigint): void {
    const slot = this.slots.get(id.toString())
    if (!slot) return
    this.finishSlot(slot)
    this.slots.delete(id.toString())
    this.onClose?.(id)
  }

  private onPeerWindow(id: bigint, addBytes: bigint): void {
    const slot = this.slots.get(id.toString())
    if (!slot) return
    slot.remaining = satAdd(slot.remaining, addBytes)
    this.pump()
  }

  private finishSlot(slot: Slot): void {
    const queued = slot.outbound
    slot.outbound = []
    slot.remaining = 0n
    slot.sent = 0n
    slot.unacked = 0
    for (const item of queued) item.promise.resolve()
  }

  private consume(slot: Slot, size: number): void {
    const n = BigInt(size)
    slot.sent = satAdd(slot.sent, n)
    if (slot.remaining > n) slot.remaining -= n
    else slot.remaining = 0n
  }

  private pickReady(): Slot | null {
    const ready: Slot[] = []
    for (const slot of this.slots.values()) {
      if (slot.outbound.length > 0 && slot.remaining > 0n) ready.push(slot)
    }
    if (ready.length === 0) return null
    ready.sort((a, b) => {
      if (b.starved !== a.starved) return b.starved - a.starved
      if (a.id < b.id) return -1
      if (a.id > b.id) return 1
      return 0
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
