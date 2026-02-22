import type { TypeRegistry, RegisteredMethod } from './typeDescription.js'
import { RawRpcClient } from './RawRpcClient.js'
import { LocalSocket } from './LocalSocket.js'
import { CircularBufferReader } from './CircularBufferReader.js'
import { CircularBufferWriter } from './CircularBufferWriter.js'
import { CodecRegistry } from './codec.js'
import type { RpcClient } from './RpcClient.js'

export class SocketRpcClient implements RpcClient {
  private readonly rawRpcClient: RawRpcClient
  private readonly reader: CircularBufferReader
  private readonly writer: CircularBufferWriter
  private readonly codecs: CodecRegistry
  private readonly socket: LocalSocket

  constructor(socket: LocalSocket, typeRegistry: TypeRegistry, codecs: CodecRegistry) {
    this.codecs = codecs
    this.socket = socket
    // Client reads responses from inputBuffer (data coming in)
    this.reader = new CircularBufferReader(socket.inputBuffer, codecs)
    // Client writes requests to outputBuffer (data going out)
    this.writer = new CircularBufferWriter(socket.outputBuffer, codecs)
      
    const beforeSend = () => {
      socket.poke(0, new Uint8Array(4), 4)
      this.writer.offset = 4
    }

    const sender = () => {
      // write the request length as uint32_t
      const requestLength = new Uint32Array([this.writer.offset - 4])
      socket.poke(0, new Uint8Array(requestLength.buffer), 4)
      socket.commitWrite(this.writer.offset)      
      // Flush the socket to send data
      socket.flush()
    }
    
    this.rawRpcClient = new RawRpcClient(this.writer as any, typeRegistry, sender, beforeSend)
    
    // Set up data event handler to process incoming responses
    socket.setOptions({
      dataEventCallback: (dataSize: number) => {
        this.processResponses()
      }
    })
  }

  getMethod(methodId: number): RegisteredMethod {
    return this.rawRpcClient.getMethod(methodId)
  }

  call(methodId: number, ...args: any[]): Promise<any> {
    return this.rawRpcClient.call(methodId, ...args)
  }

  callMethod<TId>(methodId: number, id: TId, ...args: any[]): Promise<any> {
    return this.rawRpcClient.callMethod(methodId, id, ...args)
  }

  /**
   * Process incoming responses from the socket
   */
  private processResponses(): void {
    const LENGTH_SIZE = 4
    
    while (true) {
      // Check if we have enough data for the length prefix
      if (this.socket.inputBuffer.readableBytes() < LENGTH_SIZE) {
        this.socket.drain()
        return // not enough data yet
      }

      // Peek at the length
      const lengthBuffer = new Uint8Array(LENGTH_SIZE)
      const bytesPeeked = this.socket.peek(0, lengthBuffer, LENGTH_SIZE)
      if (bytesPeeked < LENGTH_SIZE) {
        this.socket.drain()
        return // not enough data yet
      }

      // Convert to uint32 (little-endian, matching C++)
      const dataView = new DataView(lengthBuffer.buffer, lengthBuffer.byteOffset, lengthBuffer.byteLength)
      const messageLength = dataView.getUint32(0, true)

      // Check if we have enough data for the full message
      const available = this.socket.inputBuffer.readableBytes()
      if (available < LENGTH_SIZE + messageLength) {
        this.socket.reserveForReading(messageLength + LENGTH_SIZE)
        this.socket.drain()
        return // wait for full message
      }

      this.socket.skipRead(LENGTH_SIZE)

      try {
        // Handle the RPC response
        this.rawRpcClient.handleResponse(this.reader as any)
      } catch (error) {
        // If we can't read a complete response yet, wait for more data
        if (error instanceof Error && (error.message.includes('end of buffer') || error.message.includes('Unexpected end'))) {
          break
        }
        throw error
      }

      // If no more data, drain and return
      if (this.socket.inputBuffer.readableBytes() === 0) {
        this.socket.drain()
        return
      }
    }
  }

  /**
   * Handle an incoming response manually (for cases where data event isn't triggered)
   */
  handleResponse(): void {
    this.processResponses()
  }
}
