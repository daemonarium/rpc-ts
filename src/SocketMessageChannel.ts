/**
 * Socket message channel: length-prefixed frames with type_index (u64 varint) and
 * serialized message body. Matches cpp-rpc socket_message_channel wire format for
 * compatibility (length u32 LE | type_index u64 varint | body). RPC is one kind of
 * message; user message types can be registered too. Register RPC types first
 * (rpc_request, rpc_response, rpc_error) in that order for cpp-rpc compatibility.
 */

import type { Socket } from './Socket.js'
import { CircularBufferReader } from './CircularBufferReader.js'
import { CircularBufferWriter } from './CircularBufferWriter.js'
import { CodecRegistry } from './codec.js'

const LENGTH_SIZE = 4

export interface SocketMessageChannelSocket extends Socket {
  flush(): void
  drain(): void
  reserveForReading(size: number): number
  setOptions?(options: { dataEventCallback?: (dataSize: number) => void }): void
}

interface DispatchEntry {
  typeName: string
  codec: { serialize: (w: unknown, v: unknown) => void; deserialize: (r: unknown, out: (v: unknown) => void) => void }
  handler?: (msg: unknown, payloadSize?: number) => void
}

export class SocketMessageChannel {
  readonly socket: SocketMessageChannelSocket
  private readonly reader: CircularBufferReader
  private readonly writer: CircularBufferWriter
  private readonly codecs: CodecRegistry
  private readonly dispatchTable: DispatchEntry[] = []
  private readonly typeNameToIndex = new Map<string, number>()

  constructor(socket: SocketMessageChannelSocket, codecs: CodecRegistry) {
    this.socket = socket
    this.codecs = codecs
    this.reader = new CircularBufferReader(socket.inputBuffer, codecs)
    this.writer = new CircularBufferWriter(socket.outputBuffer, codecs)
  }

  /**
   * Register a message type by name. Type must exist in the codec registry.
   * Index is assigned in registration order (use same order as cpp-rpc for RPC types).
   */
  registerMessageType(typeName: string): void {
    if (this.typeNameToIndex.has(typeName)) {
      return
    }
    const codec = this.codecs.getByIndex(this.codecs.getIndexOrThrow(typeName))
    const index = this.dispatchTable.length
    this.dispatchTable.push({ typeName, codec })
    this.typeNameToIndex.set(typeName, index)
  }

  /**
   * Send a complete message (no payload).
   */
  sendMessage(typeName: string, value: object): void {
    this.beginSend(typeName, value)
    this.commitSend()
  }

  /**
   * Begin sending a message; caller may write payload to returned writer, then call commitSend().
   */
  beginSend(typeName: string, value: object): CircularBufferWriter {
    const index = this.typeNameToIndex.get(typeName)
    if (index === undefined) {
      throw new Error(`Message type ${typeName} not registered for sending`)
    }
    this.socket.outputBuffer.poke(0, new Uint8Array(LENGTH_SIZE), LENGTH_SIZE)
    this.writer.offset = LENGTH_SIZE
    this.writer.writeU64(index)
    const codec = this.codecs.getByIndex(this.codecs.getIndexOrThrow(typeName))
    codec.serialize(this.writer as any, value)
    this.writer.writeRest()
    return this.writer
  }

  /**
   * Commit the message started with beginSend: write length prefix and flush.
   */
  commitSend(): void {
    const payloadLen = this.writer.offset - LENGTH_SIZE
    const lengthBytes = new Uint8Array(LENGTH_SIZE)
    new DataView(lengthBytes.buffer).setUint32(0, payloadLen, true)
    this.socket.outputBuffer.poke(0, lengthBytes, LENGTH_SIZE)
    this.socket.outputBuffer.commitWrite(this.writer.offset)
    this.socket.flush()
  }

  /**
   * Register handler for a message type (no payload size).
   */
  onMessage(typeName: string, handler: (msg: unknown) => void): void
  /**
   * Register handler with payload size (handler may read payload from reader()).
   */
  onMessage(typeName: string, handler: (msg: unknown, payloadSize: number) => void): void
  onMessage(typeName: string, handler: (msg: unknown, payloadSize?: number) => void): void {
    const index = this.typeNameToIndex.get(typeName)
    if (index === undefined) {
      throw new Error(`Message type ${typeName} not registered`)
    }
    const entry = this.dispatchTable[index]
    if (!entry) throw new Error(`Dispatch entry missing for ${typeName}`)
    entry.handler = handler
  }

  /**
   * Process incoming data: read length-prefixed frames and dispatch to handlers.
   */
  async handleData(): Promise<void> {
    const input = this.socket.inputBuffer
    while (true) {
      if (input.readableBytes() < LENGTH_SIZE) {
        this.socket.drain()
        return
      }
      const lengthBuffer = new Uint8Array(LENGTH_SIZE)
      const peeked = this.socket.peek(0, lengthBuffer, LENGTH_SIZE)
      if (peeked < LENGTH_SIZE) {
        this.socket.drain()
        return
      }
      const msgLen = new DataView(lengthBuffer.buffer, lengthBuffer.byteOffset, lengthBuffer.byteLength).getUint32(0, true)
      const available = input.readableBytes()
      if (available < LENGTH_SIZE + msgLen) {
        this.socket.reserveForReading(msgLen + LENGTH_SIZE)
        this.socket.drain()
        return
      }
      this.socket.skipRead(LENGTH_SIZE)
      this.reader.setReadOffset(0)
      const typeIndex = Number(this.reader.readU64())
      if (typeIndex >= this.dispatchTable.length) {
        input.skipRead(msgLen)
        throw new Error(`Unknown message type index: ${typeIndex}`)
      }
      const entry = this.dispatchTable[typeIndex]
      if (!entry) {
        input.skipRead(msgLen)
        throw new Error(`No dispatch entry for index ${typeIndex}`)
      }
      let msg: unknown
      entry.codec.deserialize(this.reader as any, (v: unknown) => { msg = v })
      this.reader.readRest()
      const payloadSize = msgLen - this.reader.getReadOffset()
      if (entry.handler) {
        let result: unknown
        if (entry.handler.length >= 2) {
          result = (entry.handler as (m: unknown, p: number) => void)(msg, payloadSize)
        } else {
          result = (entry.handler as (m: unknown) => void)(msg)
        }
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          await (result as Promise<unknown>)
        }
      }
      input.skipRead(msgLen)
      if (input.readableBytes() === 0) {
        this.socket.drain()
        return
      }
    }
  }

  getReader(): CircularBufferReader {
    return this.reader
  }

  getWriter(): CircularBufferWriter {
    return this.writer
  }
}
