/**
 * Shared length-prefix framing for socket message channels (compressed + flat).
 * Body layout is policy-specific via writeMessageBody / readMessageBody.
 */

import { LocalSocket } from './LocalSocket.js'
import type { IWriter, IReader } from './writerTypes.js'
import { CodecRegistry } from './codec.js'
import type { MessageChannel } from './MessageChannel.js'

export const SOCKET_MESSAGE_LENGTH_SIZE = 4

export type SocketMessageChannelSocket = LocalSocket

export interface DispatchEntry {
  typeName: string
  handler?: (msg: unknown, payloadSize?: number) => void
}

/** Minimal writer surface used by framing commitSend. */
export interface FramingWriter {
  offset: number
}

/** Minimal reader surface used by framing handleData. */
export interface FramingReader {
  setReadOffset(offset: number): void
  getReadOffset(): number
}

/** Writer returned by beginSend for RPC payload (args / result / exception). */
export type MessageChannelWriter = IWriter & FramingWriter & {
  writeException(typeName: string, value: unknown): void
}

/** Reader used for RPC payload deserialize / readException. */
export type MessageChannelReader = IReader & FramingReader & {
  readException(): { typeName: string, value: unknown }
}

/**
 * Length-prefixed message framing: peek/wait, commitSend, handleData loop,
 * dispatch table, onMessage arity → payloadSize.
 */
export abstract class SocketMessageChannelBase implements MessageChannel {
  readonly socket: LocalSocket
  protected handlingData = false
  protected handleDataQueued = false
  protected readonly codecs: CodecRegistry
  protected readonly dispatchTable: DispatchEntry[] = []
  private minWritableBytes = 0
  private readonly writableHandlers: Array<() => void> = []
  private writableHookInstalled = false

  constructor(socket: LocalSocket, codecs: CodecRegistry) {
    this.socket = socket
    this.codecs = codecs
  }

  /** 0 = always queue (C++ default). Non-zero requires that many writable bytes. */
  setMinWritableBytes(bytes: number): void {
    this.minWritableBytes = bytes
  }

  protected abstract get framingWriter(): FramingWriter
  protected abstract get framingReader(): FramingReader

  /**
   * Write type index + serialized body (+ flat size/sentinel as needed).
   * Leaves the writer positioned at the start of optional payload.
   */
  protected abstract writeMessageBody(typeName: string, value: object): void

  /**
   * Read type index + body (+ flat size/sentinel). Reader starts at offset 0
   * (after length prefix was skipped). Leaves cursor at payload start.
   */
  protected abstract readMessageBody(): { typeIndex: number, msg: unknown }

  abstract beginSend(typeName: string, value: object): MessageChannelWriter
  abstract getReader(): MessageChannelReader
  abstract getWriter(): MessageChannelWriter

  registerMessageType(typeName: string): void {
    if (!this.codecs.messages.has(typeName)) {
      throw new Error(`Message codec ${typeName} not registered`)
    }
    const wireIndex = this.codecs.messages.getIndexOrThrow(typeName)
    if (this.dispatchTable[wireIndex]) return
    this.dispatchTable[wireIndex] = { typeName }
  }

  registerExceptionType(
    typeName: string,
    serializer: (writer: IWriter, value: unknown) => void,
    deserializer: (reader: IReader) => unknown
  ): void {
    if (this.codecs.exceptions.has(typeName)) return
    this.codecs.exceptions.register({
      name: typeName,
      serialize: (w, v) => serializer(w, v),
      deserialize: (r, out) => out(deserializer(r))
    })
  }

  sendMessage(typeName: string, value: object): void {
    this.beginSendFrame(typeName, value)
    this.commitSend()
  }

  /**
   * Queue a complete message without flushing. Returns false when the
   * output buffer is below minWritableBytes (C++ try_queue_message).
   */
  tryQueueMessage(typeName: string, value: object): boolean {
    if (!this.isWritable()) return false
    this.beginSendFrame(typeName, value)
    this.commitSendNoFlush()
    return true
  }

  isWritable(): boolean {
    if (this.minWritableBytes === 0) return true
    return this.socket.outputBuffer.writableBytes() >= this.minWritableBytes
  }

  onWritable(handler: () => void): void {
    this.writableHandlers.push(handler)
    this.installWritableHook()
  }

  private installWritableHook(): void {
    if (this.writableHookInstalled) return
    this.writableHookInstalled = true
    const prev = this.socket.getOptions().drainEventCallback
    this.socket.setOptions({
      drainEventCallback: (size) => {
        if (prev) prev(size)
        for (const handler of this.writableHandlers) handler()
      }
    })
  }

  /**
   * Reserve length placeholder at offset 0, set writer offset to 4, write body.
   * Subclasses expose typed beginSend that returns their writer.
   */
  protected beginSendFrame(typeName: string, value: object): void {
    this.socket.outputBuffer.poke(
      0,
      new Uint8Array(SOCKET_MESSAGE_LENGTH_SIZE),
      SOCKET_MESSAGE_LENGTH_SIZE
    )
    this.framingWriter.offset = SOCKET_MESSAGE_LENGTH_SIZE
    this.writeMessageBody(typeName, value)
  }

  commitSendNoFlush(): void {
    const payloadLen = this.framingWriter.offset - SOCKET_MESSAGE_LENGTH_SIZE
    const lengthBytes = new Uint8Array(SOCKET_MESSAGE_LENGTH_SIZE)
    new DataView(lengthBytes.buffer).setUint32(0, payloadLen, true)
    this.socket.outputBuffer.poke(0, lengthBytes, SOCKET_MESSAGE_LENGTH_SIZE)
    this.socket.outputBuffer.commitWrite(this.framingWriter.offset)
  }

  commitSend(): void {
    this.commitSendNoFlush()
    this.socket.flush()
  }

  onMessage(typeName: string, handler: (msg: unknown) => void): void
  onMessage(typeName: string, handler: (msg: unknown, payloadSize: number) => void): void
  onMessage(typeName: string, handler: (msg: unknown, payloadSize?: number) => void): void {
    const wireIndex = this.codecs.messages.getIndexOrThrow(typeName)
    const entry = this.dispatchTable[wireIndex]
    if (!entry) throw new Error(`Dispatch entry missing for ${typeName}`)
    entry.handler = handler
  }

  async handleData(): Promise<void> {
    if (this.handlingData) {
      // Nested dataEvent during an in-flight parse: remember to drain after.
      this.handleDataQueued = true
      return
    }
    this.handlingData = true
    try {
      const input = this.socket.inputBuffer
      while (true) {
        if (input.readableBytes() < SOCKET_MESSAGE_LENGTH_SIZE) {
          this.socket.drain()
          if (input.readableBytes() < SOCKET_MESSAGE_LENGTH_SIZE) return
        }
        const lengthBuffer = new Uint8Array(SOCKET_MESSAGE_LENGTH_SIZE)
        this.socket.peek(0, lengthBuffer, SOCKET_MESSAGE_LENGTH_SIZE)
        const msgLen = new DataView(
          lengthBuffer.buffer,
          lengthBuffer.byteOffset,
          lengthBuffer.byteLength
        ).getUint32(0, true)
        if (input.readableBytes() < SOCKET_MESSAGE_LENGTH_SIZE + msgLen) {
          this.socket.reserveForReading(msgLen + SOCKET_MESSAGE_LENGTH_SIZE)
          this.socket.drain()
          if (input.readableBytes() < SOCKET_MESSAGE_LENGTH_SIZE + msgLen) return
        }
        this.socket.skipRead(SOCKET_MESSAGE_LENGTH_SIZE)
        this.framingReader.setReadOffset(0)
        const { typeIndex, msg } = this.readMessageBody()
        if (typeIndex >= this.dispatchTable.length) {
          input.skipRead(msgLen)
          throw new Error(`Unknown message type index: ${typeIndex}`)
        }
        const entry = this.dispatchTable[typeIndex]
        if (!entry) {
          input.skipRead(msgLen)
          throw new Error(`No dispatch entry for index ${typeIndex}`)
        }
        const payloadSize = msgLen - this.framingReader.getReadOffset()
        try {
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
        } finally {
          input.skipRead(msgLen)
          if (input.readableBytes() === 0) {
            this.socket.drain()
            if (input.readableBytes() === 0) return
          }
        }
      }
    } finally {
      this.handlingData = false
      if (this.handleDataQueued) {
        this.handleDataQueued = false
        void this.handleData()
      }
    }
  }
}
