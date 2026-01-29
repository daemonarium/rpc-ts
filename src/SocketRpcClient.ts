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
    
    const sender = () => {
      // Flush the socket to send data
      socket.flush()
    }
    
    this.rawRpcClient = new RawRpcClient(this.writer as any, typeRegistry, sender)
    
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
    // Check if there's data available in inputBuffer (responses coming in)
    while (this.socket.inputBuffer.readableBytes() > 0) {
      try {
        // Read the response
        this.rawRpcClient.handleResponse(this.reader as any)
      } catch (error) {
        // If we can't read a complete response yet, wait for more data
        if (error instanceof Error && (error.message.includes('end of buffer') || error.message.includes('Unexpected end'))) {
          break
        }
        throw error
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
