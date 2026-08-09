/**
 * Flat socket message channel: length-prefixed frames matching C++
 * flat_materialized_codec + socket_message_framing.
 *
 * Body after [len u32 LE]:
 *   [typeIndex u32 LE][encoded_size_0=N+1][root][writeRest frames…][u32 0 sentinel][payload]
 */

import { LocalSocket } from './LocalSocket.js'
import { FlatLocalCircularBufferReader } from './flatLocalCircularBufferReader.js'
import { FlatLocalCircularBufferWriter } from './flatLocalCircularBufferWriter.js'
import { CodecRegistry } from './codec.js'
import {
  SocketMessageChannelBase,
  type SocketMessageChannelSocket,
} from './socketMessageFraming.js'

export type { SocketMessageChannelSocket }

export class FlatSocketMessageChannel extends SocketMessageChannelBase {
  private readonly reader: FlatLocalCircularBufferReader
  private readonly writer: FlatLocalCircularBufferWriter

  constructor(socket: LocalSocket, codecs: CodecRegistry) {
    super(socket, codecs)
    this.reader = new FlatLocalCircularBufferReader(socket.inputBuffer, codecs)
    this.writer = new FlatLocalCircularBufferWriter(socket.outputBuffer, codecs)
  }

  protected get framingWriter(): FlatLocalCircularBufferWriter {
    return this.writer
  }

  protected get framingReader(): FlatLocalCircularBufferReader {
    return this.reader
  }

  protected writeMessageBody(typeName: string, value: object): void {
    const wireIndex = this.codecs.messages.getIndexOrThrow(typeName)
    this.writer.writeU32(wireIndex)

    const sizePlaceholder = this.writer.getOffset()
    this.writer.writeU32(0)
    const frameStart = this.writer.getOffset()

    const codec = this.codecs.messages.getByIndex(wireIndex)
    codec.serialize(this.writer, value)

    const realSize = this.writer.getOffset() - frameStart
    this.writer.pokeU32(sizePlaceholder, realSize + 1)

    this.writer.writeRest()
    this.writer.writeU32(0) // sentinel
  }

  protected readMessageBody(): { typeIndex: number, msg: unknown } {
    const typeIndex = this.reader.readU32()
    // Consume encoded_size_0 (materialized path does not need the value).
    this.reader.readU32()

    if (typeIndex >= this.dispatchTable.length || !this.dispatchTable[typeIndex]) {
      return { typeIndex, msg: undefined }
    }

    let msg: unknown
    const codec = this.codecs.messages.getByIndex(typeIndex)
    codec.deserialize(this.reader, (v: unknown) => { msg = v })
    this.reader.readRest()

    const sentinel = this.reader.readU32()
    if (sentinel !== 0) {
      throw new Error(`flat codec: expected frame sentinel, got ${sentinel}`)
    }
    return { typeIndex, msg }
  }

  beginSend(typeName: string, value: object): FlatLocalCircularBufferWriter {
    this.beginSendFrame(typeName, value)
    return this.writer
  }

  getReader(): FlatLocalCircularBufferReader {
    return this.reader
  }

  getWriter(): FlatLocalCircularBufferWriter {
    return this.writer
  }
}
