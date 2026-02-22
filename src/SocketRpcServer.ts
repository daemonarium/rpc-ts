import type { TypeRegistry } from './typeDescription.js'
import { RawRpcServer } from './RawRpcServer.js'
import { LocalSocket } from './LocalSocket.js'
import { CircularBufferReader } from './CircularBufferReader.js'
import { CircularBufferWriter } from './CircularBufferWriter.js'
import { CodecRegistry } from './codec.js'

export class SocketRpcServer {
  private readonly rawRpcServer: RawRpcServer
  private readonly reader: CircularBufferReader
  private readonly writer: CircularBufferWriter
  private readonly socket: LocalSocket

  constructor(socket: LocalSocket, typeRegistry: TypeRegistry, codecs: CodecRegistry) {
    this.socket = socket
    // Server reads requests from inputBuffer (data coming in)
    this.reader = new CircularBufferReader(socket.inputBuffer, codecs)
    // Server writes responses to outputBuffer (data going out)
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
    this.rawRpcServer = new RawRpcServer(typeRegistry, beforeSend, sender)
    // Set up data event handler to process incoming requests
    socket.setOptions({
      dataEventCallback: (dataSize: number) => {
        this.processRequests()
      }
    })
  }

  /**
   * Process incoming requests from the socket
   */
  private async processRequests(): Promise<void> {
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

      // Consume length prefix
      this.socket.skipRead(LENGTH_SIZE)

      // Now create a new reader that starts after the length prefix
      // We need to create a temporary reader for just this message
      // The reader was already created with the full buffer, but we've skipped the length
      // So it should now point to the message data
      
      try {
        // Handle the RPC call
        await this.rawRpcServer.handleCall(this.reader as any, this.writer as any)
        
        // Flush the response
        this.socket.flush()
      } catch (error) {
        // If we can't read a complete request yet, wait for more data
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
   * Handle incoming requests manually (for cases where data event isn't triggered)
   */
  async handleRequests(): Promise<void> {
    await this.processRequests()
  }
}
