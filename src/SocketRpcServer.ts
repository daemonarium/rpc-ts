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
    this.rawRpcServer = new RawRpcServer(typeRegistry)
    
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
    while (this.socket.inputBuffer.readableBytes() > 0) {
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
    }
  }

  /**
   * Handle incoming requests manually (for cases where data event isn't triggered)
   */
  async handleRequests(): Promise<void> {
    await this.processRequests()
  }
}
