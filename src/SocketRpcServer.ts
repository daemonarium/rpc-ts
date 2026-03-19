import type { TypeRegistry } from './typeDescription.js'
import { RawRpcServer } from './RawRpcServer.js'
import { CodecRegistry } from './codec.js'
import { SocketMessageChannel, type SocketMessageChannelSocket } from './SocketMessageChannel.js'
import { ensureRpcTypesInRegistry, ensureRpcCodecs, RPC_REQUEST_TYPE, RPC_RESPONSE_TYPE, RPC_ERROR_TYPE } from './rpc.js'
import type { Writer } from './writer.js'
import { TypeKind } from './typeDescription.js'
import { serializeValueByType, deserializeValueByType, type JsonValue } from './valueSerialization.js'

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

  constructor(socket: SocketMessageChannelSocket, typeRegistry: TypeRegistry, codecs: CodecRegistry) {
    ensureRpcTypesInRegistry(typeRegistry)
    ensureRpcCodecs(codecs, typeRegistry)
    this.messageChannel = new SocketMessageChannel(socket, codecs)
    this.messageChannel.registerMessageType(RPC_REQUEST_TYPE)
    this.messageChannel.registerMessageType(RPC_RESPONSE_TYPE)
    this.messageChannel.registerMessageType(RPC_ERROR_TYPE)

    for (const type of typeRegistry.getTypes()) {
      if (type.kind !== TypeKind.Exception) continue
      this.messageChannel.registerExceptionType(
        type.name,
        (w, v) => serializeValueByType(w as any, typeRegistry, type, v as JsonValue),
        (r) => {
          let result: unknown
          deserializeValueByType(r as any, typeRegistry, type, (v) => {
            result = v
          })
          return result
        }
      )
    }

    const beforeSend = () => {
      this.messageChannel.beginSend(RPC_RESPONSE_TYPE, {
        request_id: this.currentRequestId
      })
    }
    const sender = () => {
      this.messageChannel.commitSend()
    }
    const onError = (requestId: number, error: unknown) => {
      const w = this.messageChannel.beginSend(RPC_ERROR_TYPE, { request_id: requestId })
      w.writeException('runtime_error', error)
      w.writeRest()
      this.messageChannel.commitSend()
    }
    this.rawRpcServer = new RawRpcServer(typeRegistry, beforeSend, sender, onError)

    this.messageChannel.onMessage(
      RPC_REQUEST_TYPE,
      async (msg: { request_id: number; function_id: number }, _payloadSize: number) => {
        this.currentRequestId = msg.request_id
        if (!this.rawRpcServer.hasHandler(msg.function_id)) {
          const w = this.messageChannel.beginSend(RPC_ERROR_TYPE, { request_id: msg.request_id })
          w.writeException('runtime_error', 'Function not found')
          w.writeRest()
          this.messageChannel.commitSend()
          return
        }
        const writer = createResponseWriterAdapter(() => this.messageChannel.getWriter() as any)
        await this.rawRpcServer.handleCallWithIds(
          msg.request_id,
          msg.function_id,
          this.messageChannel.getReader() as any,
          writer
        )
      }
    )

    socket.setOptions?.({
      dataEventCallback: async () => {
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
      }
    })
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
