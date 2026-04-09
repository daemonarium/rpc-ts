import type { TypeRegistry } from './typeDescription.js'
import { CodecRegistry } from './codec.js'
import { SocketMessageChannel } from './SocketMessageChannel.js'
import { LocalSocket } from './LocalSocket.js'
import { ensureRpcTypesInRegistry, ensureRpcCodecs, RPC_REQUEST_TYPE, RPC_RESPONSE_TYPE, RPC_ERROR_TYPE } from './rpc.js'
import type { TypeDescription } from './typeDescription.js'
import { TypeKind } from './typeDescription.js'
import { serializeValueByType, deserializeValueByType, type JsonValue } from './valueSerialization.js'
import { RpcMethodDispatcher } from './RpcMethodDispatcher.js'

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)

function toRequestId(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
}

function toMethodId(value: number | bigint): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
      throw new Error(`Invalid function_id: ${value}`)
    }
    return value
  }
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new Error(`Invalid function_id: ${value.toString()}`)
  }
  return Number(value)
}

function toRuntimeErrorValue(error: unknown): { _type: string, what: string } {
  const objectError = error as { what?: unknown } | null | undefined
  return {
    _type: 'runtime_error',
    what:
      typeof objectError?.what === 'string'
        ? objectError.what
        : error instanceof Error
          ? error.message
          : String(error)
  }
}

export class SocketRpcServer {
  private readonly messageChannel: SocketMessageChannel
  private readonly typeRegistry: TypeRegistry
  private readonly methodDispatcher: RpcMethodDispatcher

  constructor(socket: LocalSocket, typeRegistry: TypeRegistry, codecs: CodecRegistry) {
    this.typeRegistry = typeRegistry
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

    this.methodDispatcher = new RpcMethodDispatcher(typeRegistry)

    this.messageChannel.onMessage(
      RPC_REQUEST_TYPE,
      async (msg: { request_id: number | bigint; function_id: number | bigint }, _payloadSize: number) => {
        const requestId = toRequestId(msg.request_id)
        let functionId: number
        try {
          functionId = toMethodId(msg.function_id)
        } catch (error) {
          this.sendError(requestId, error)
          return
        }
        if (!this.methodDispatcher.hasMethod(functionId)) {
          this.sendError(requestId, 'Function not found')
          return
        }

        const prepared = this.methodDispatcher.prepareCall(functionId, this.messageChannel.getReader() as any)
        try {
          const result = await prepared.callFn()
          this.sendResponse(requestId, prepared.returnType, result)
        } catch (error) {
          this.sendError(requestId, error)
        }
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

  private sendResponse(requestId: bigint, returnType: TypeDescription, result: unknown): void {
    if (returnType.kind === TypeKind.Void) {
      this.messageChannel.sendMessage(RPC_RESPONSE_TYPE, { request_id: requestId })
      return
    }
    const writer = this.messageChannel.beginSend(RPC_RESPONSE_TYPE, { request_id: requestId })
    serializeValueByType(writer as any, this.typeRegistry, returnType, result as JsonValue)
    writer.writeRest()
    this.messageChannel.commitSend()
  }

  private sendError(requestId: bigint, error: unknown): void {
    const writer = this.messageChannel.beginSend(RPC_ERROR_TYPE, { request_id: requestId })
    writer.writeException('runtime_error', toRuntimeErrorValue(error))
    writer.writeRest()
    this.messageChannel.commitSend()
  }
}
