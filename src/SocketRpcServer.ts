import type { TypeRegistry } from './typeDescription.js'
import { RawRpcServer } from './RawRpcServer.js'
import { CodecRegistry } from './codec.js'
import { SocketMessageChannel, type SocketMessageChannelSocket } from './SocketMessageChannel.js'
import { ensureRpcTypesInRegistry, ensureRpcCodecs, RPC_REQUEST_TYPE, RPC_RESPONSE_TYPE, RPC_ERROR_TYPE } from './rpc.js'
import type { Writer } from './writer.js'

/**
 * Writer adapter that skips the first writeU64 and writeBool (rpc_response header already sent via channel).
 */
function createResponseWriterAdapter(getWriter: () => Writer): Writer {
  let skip = 2
  return new Proxy({} as Writer, {
    get(_, prop) {
      const w = getWriter()
      const val = (w as any)[prop]
      if (typeof val !== 'function') return val
      if (prop === 'writeU64' || prop === 'writeBool') {
        return (...args: any[]) => {
          if (skip > 0) {
            skip--
            return
          }
          return (val as (...a: any[]) => any).apply(w, args)
        }
      }
      return (...args: any[]) => (val as (...a: any[]) => any).apply(w, args)
    }
  })
}

export class SocketRpcServer {
  private readonly messageChannel: SocketMessageChannel
  private readonly rawRpcServer: RawRpcServer
  private currentRequestId = 0
  private processing = false
  private pendingData = false

  constructor(socket: SocketMessageChannelSocket, typeRegistry: TypeRegistry, codecs: CodecRegistry) {
    ensureRpcTypesInRegistry(typeRegistry)
    ensureRpcCodecs(codecs, typeRegistry)
    this.messageChannel = new SocketMessageChannel(socket, codecs)
    this.messageChannel.registerMessageType(RPC_REQUEST_TYPE)
    this.messageChannel.registerMessageType(RPC_RESPONSE_TYPE)
    this.messageChannel.registerMessageType(RPC_ERROR_TYPE)

    const beforeSend = () => {
      this.messageChannel.beginSend(RPC_RESPONSE_TYPE, {
        request_id: this.currentRequestId,
        success: true
      })
    }
    const sender = () => {
      this.messageChannel.commitSend()
    }
    this.rawRpcServer = new RawRpcServer(typeRegistry, beforeSend, sender)

    this.messageChannel.onMessage(
      RPC_REQUEST_TYPE,
      async (msg: { request_id: number; function_id: number }, _payloadSize: number) => {
        this.currentRequestId = msg.request_id
        if (!this.rawRpcServer.hasHandler(msg.function_id)) {
          this.messageChannel.sendMessage(RPC_ERROR_TYPE, {
            request_id: msg.request_id,
            success: false,
            error: 'Function not found'
          })
          return
        }
        const writer = createResponseWriterAdapter(() => this.messageChannel.getWriter() as any)
        try {
          await this.rawRpcServer.handleCallWithIds(
            msg.request_id,
            msg.function_id,
            this.messageChannel.getReader() as any,
            writer
          )
        } catch (error) {
          this.messageChannel.sendMessage(RPC_ERROR_TYPE, {
            request_id: msg.request_id,
            success: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    )

    socket.setOptions?.({
      dataEventCallback: () => {
        if (this.processing) {
          this.pendingData = true
          return
        }
        this.processRequests()
      }
    })
  }

  private async processRequests(): Promise<void> {
    this.processing = true
    try {
      this.pendingData = false
      try {
        await this.messageChannel.handleData()
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('end of buffer') || error.message.includes('Unexpected end'))
        ) {
          return
        }
        throw error
      }
    } finally {
      this.processing = false
      if (this.pendingData) {
        this.pendingData = false
        this.processRequests()
      }
    }
  }

  async handleRequests(): Promise<void> {
    await this.processRequests()
  }

  registerMessageType(typeName: string): void {
    this.messageChannel.registerMessageType(typeName)
  }

  onMessage(typeName: string, handler: (msg: unknown) => void): void
  onMessage(typeName: string, handler: (msg: unknown, payloadSize: number) => void): void
  onMessage(typeName: string, handler: (msg: unknown, payloadSize?: number) => void): void {
    this.messageChannel.onMessage(typeName, handler as (msg: unknown, payloadSize?: number) => void)
  }

  sendMessage(typeName: string, value: object): void {
    this.messageChannel.sendMessage(typeName, value)
  }

  channel(): SocketMessageChannel {
    return this.messageChannel
  }
}
