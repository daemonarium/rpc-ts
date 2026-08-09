/**
 * Socket message channel (compressed): length-prefixed frames with type_index
 * (u64 varint) and serialized message body. Matches cpp-rpc socket_message_channel
 * wire format. RPC is one kind of message; user message types can be registered too.
 * Register RPC types first (rpc_request, rpc_response, rpc_error) in that order
 * for cpp-rpc compatibility.
 */

import { LocalSocket } from './LocalSocket.js'
import { LocalCircularBufferReader } from './LocalCircularBufferReader.js'
import { LocalCircularBufferWriter } from './LocalCircularBufferWriter.js'
import { CodecRegistry } from './codec.js'
import {
  SocketMessageChannelBase,
  type SocketMessageChannelSocket,
} from './socketMessageFraming.js'

export type { SocketMessageChannelSocket }

export class SocketMessageChannel extends SocketMessageChannelBase {
  private readonly reader: LocalCircularBufferReader
  private readonly writer: LocalCircularBufferWriter

  constructor(socket: LocalSocket, codecs: CodecRegistry) {
    super(socket, codecs)
    this.reader = new LocalCircularBufferReader(socket.inputBuffer, codecs)
    this.writer = new LocalCircularBufferWriter(socket.outputBuffer, codecs)
  }

  protected get framingWriter(): LocalCircularBufferWriter {
    return this.writer
  }

  protected get framingReader(): LocalCircularBufferReader {
    return this.reader
  }

  protected writeMessageBody(typeName: string, value: object): void {
    const wireIndex = this.codecs.messages.getIndexOrThrow(typeName)
    this.writer.writeU64(wireIndex)
    const codec = this.codecs.messages.getByIndex(wireIndex)
    codec.serialize(this.writer, value)
    this.writer.writeRest()
  }

  protected readMessageBody(): { typeIndex: number, msg: unknown } {
    const typeIndex = Number(this.reader.readU64())
    if (typeIndex >= this.dispatchTable.length || !this.dispatchTable[typeIndex]) {
      // Still need to leave framing able to throw with skip; deserialize not attempted.
      return { typeIndex, msg: undefined }
    }
    let msg: unknown
    const codec = this.codecs.messages.getByIndex(typeIndex)
    codec.deserialize(this.reader, (v: unknown) => { msg = v })
    this.reader.readRest()
    return { typeIndex, msg }
  }

  /**
   * Begin sending a message; caller may write payload to returned writer, then call commitSend().
   */
  beginSend(typeName: string, value: object): LocalCircularBufferWriter {
    this.beginSendFrame(typeName, value)
    return this.writer
  }

  getReader(): LocalCircularBufferReader {
    return this.reader
  }

  getWriter(): LocalCircularBufferWriter {
    return this.writer
  }
}
