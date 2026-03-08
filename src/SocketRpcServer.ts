import type { TypeRegistry } from './typeDescription.js'
import { RawRpcServer } from './RawRpcServer.js'
import { LocalSocket } from './LocalSocket.js'
import { CircularBufferReader } from './CircularBufferReader.js'
import { LocalCircularBufferWriter } from './LocalCircularBufferWriter.js'
import { CodecRegistry } from './codec.js'

export class SocketRpcServer {
  private readonly rawRpcServer: RawRpcServer
  private readonly reader: CircularBufferReader
  private readonly writer: LocalCircularBufferWriter
  private readonly socket: LocalSocket
  private processing = false
  private pendingData = false

  constructor(socket: LocalSocket, typeRegistry: TypeRegistry, codecs: CodecRegistry) {
    this.socket = socket
    // Server reads requests from inputBuffer (data coming in)
    this.reader = new CircularBufferReader(socket.inputBuffer, codecs)
    // Server writes responses to outputBuffer (data going out)
    this.writer = new LocalCircularBufferWriter(socket.outputBuffer, codecs)
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
        if (this.processing) {
          this.pendingData = true
          return
        }
        this.processRequests()
      }
    })
  }

  /**
   * Process incoming requests from the socket
   */
  private async processRequests(): Promise<void> {
    this.processing = true
    const LENGTH_SIZE = 4

    try {
      while (true) {
        this.pendingData = false

        // Check if we have enough data for the length prefix
        if (this.socket.inputBuffer.readableBytes() < LENGTH_SIZE) {
          this.socket.drain()
          if (this.socket.inputBuffer.readableBytes() < LENGTH_SIZE) {
            return
          }
        }

        // Peek at the length
        const lengthBuffer = new Uint8Array(LENGTH_SIZE)
        const bytesPeeked = this.socket.peek(0, lengthBuffer, LENGTH_SIZE)
        if (bytesPeeked < LENGTH_SIZE) {
          return
        }

        // Convert to uint32 (little-endian, matching C++)
        const dataView = new DataView(lengthBuffer.buffer, lengthBuffer.byteOffset, lengthBuffer.byteLength)
        const messageLength = dataView.getUint32(0, true)
        console.log(`[SRS] messageLength=${messageLength}, available=${this.socket.inputBuffer.readableBytes()}`)

        // Check if we have enough data for the full message
        let available = this.socket.inputBuffer.readableBytes()
        if (available < LENGTH_SIZE + messageLength) {           
          this.socket.reserveForReading(messageLength + LENGTH_SIZE)
          this.socket.drain()
          available = this.socket.inputBuffer.readableBytes()
          if (available < LENGTH_SIZE + messageLength) {
            return // still not enough after drain
          }
        }

        // Consume length prefix
        this.socket.skipRead(LENGTH_SIZE)

        try {
          // Handle the RPC call
          await this.rawRpcServer.handleCall(this.reader as any, this.writer as any)

          // Flush the response
          this.socket.flush()
        } catch (error) {
          if (error instanceof Error && (error.message.includes('end of buffer') || error.message.includes('Unexpected end'))) {
            break
          }
          throw error
        }

        // Check for pending data from reentrant calls or continue loop
        if (this.socket.inputBuffer.readableBytes() === 0 && !this.pendingData) {
          this.socket.drain()
          if (this.socket.inputBuffer.readableBytes() === 0) {
            return
          }
        }
      }
    } finally {
      this.processing = false
      // If data arrived while we were processing, process it
      if (this.pendingData) {
        this.pendingData = false
        this.processRequests()
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
