import type { TypeRegistry } from './typeDescription.js'
import { CodecRegistry } from './codec.js'
import { SocketMessageChannel } from './SocketMessageChannel.js'
import { FlatSocketMessageChannel } from './FlatSocketMessageChannel.js'
import {
  ensureRpcTypesInRegistry,
  ensureRpcCodecs,
  RPC_REQUEST_TYPE,
  RPC_RESPONSE_TYPE,
  RPC_ERROR_TYPE,
  type SocketRpcOptions,
} from './rpc.js'
import type { TypeDescription } from './typeDescription.js'
import { TypeKind } from './typeDescription.js'
import { serializeValueByType, deserializeValueByType, type JsonValue } from './valueSerialization.js'
import { RpcMethodDispatcher } from './RpcMethodDispatcher.js'
import { RpcException } from './RpcException.js'
import type { SocketMessageChannelBase, SocketMessageChannelSocket } from './socketMessageFraming.js'
import { SerializationFormat } from './serializationFormat.js'

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

function exceptionMessage(error: unknown): string {
  const objectError = error as { what?: unknown, message?: unknown } | null | undefined
  if (typeof objectError?.what === 'string') {
    return objectError.what
  }
  if (error instanceof Error) {
    return error.message
  }
  if (typeof objectError?.message === 'string') {
    return objectError.message
  }
  return String(error)
}

function resolveExceptionWire(
  error: unknown,
  typeRegistry: TypeRegistry
): { typeName: string, value: { _type: string, what: string } } {
  const objectError = error as { _type?: unknown, typeName?: unknown } | null | undefined
  let typeName = 'runtime_error'
  if (error instanceof RpcException && error.typeName) {
    typeName = error.typeName
  } else if (typeof objectError?._type === 'string') {
    typeName = objectError._type
  } else if (typeof objectError?.typeName === 'string') {
    typeName = objectError.typeName
  }

  const registered = typeRegistry.getTypeByName(typeName)
  if (!registered || registered.kind !== TypeKind.Exception) {
    const runtimeError = typeRegistry.getTypeByName('runtime_error')
    const unknownException = typeRegistry.getTypeByName('unknown_exception')
    if (runtimeError && runtimeError.kind === TypeKind.Exception) {
      typeName = 'runtime_error'
    } else if (unknownException && unknownException.kind === TypeKind.Exception) {
      typeName = 'unknown_exception'
    } else {
      const anyException = typeRegistry.getTypes().find((type) => type.kind === TypeKind.Exception)
      typeName = anyException?.name ?? 'runtime_error'
    }
  }

  return {
    typeName,
    value: {
      _type: typeName,
      what: exceptionMessage(error)
    }
  }
}

function createRpcMessageChannel(
  socket: SocketMessageChannelSocket,
  codecs: CodecRegistry,
  options?: SocketRpcOptions
): SocketMessageChannelBase {
  if (options?.format === 'compressed') {
    return new SocketMessageChannel(socket, codecs)
  }
  return new FlatSocketMessageChannel(socket, codecs)
}

export class SocketRpcServer {
  private readonly messageChannel: SocketMessageChannelBase
  private readonly typeRegistry: TypeRegistry
  private readonly methodDispatcher: RpcMethodDispatcher

  constructor(
    socket: SocketMessageChannelSocket,
    typeRegistry: TypeRegistry,
    codecs: CodecRegistry,
    options?: SocketRpcOptions
  ) {
    this.typeRegistry = typeRegistry
    ensureRpcTypesInRegistry(typeRegistry)
    ensureRpcCodecs(codecs, typeRegistry)
    if (options?.format === 'compressed') {
      typeRegistry.dataFormat = SerializationFormat.Compressed
    } else {
      typeRegistry.dataFormat = SerializationFormat.Flat
    }
    this.messageChannel = createRpcMessageChannel(socket, codecs, options)
    this.messageChannel.registerMessageType(RPC_REQUEST_TYPE)
    this.messageChannel.registerMessageType(RPC_RESPONSE_TYPE)
    this.messageChannel.registerMessageType(RPC_ERROR_TYPE)

    for (const type of typeRegistry.getTypes()) {
      if (type.kind !== TypeKind.Exception) continue
      this.messageChannel.registerExceptionType(
        type.name,
        (w, v) => serializeValueByType(w, typeRegistry, type, v as JsonValue),
        (r) => {
          let result: unknown
          deserializeValueByType(r, typeRegistry, type, (v) => {
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

  channel(): SocketMessageChannelBase {
    return this.messageChannel
  }

  private sendResponse(requestId: bigint, returnType: TypeDescription, result: unknown): void {
    if (returnType.kind === TypeKind.Void) {
      this.messageChannel.sendMessage(RPC_RESPONSE_TYPE, { request_id: requestId })
      return
    }
    const writer = this.messageChannel.beginSend(RPC_RESPONSE_TYPE, { request_id: requestId })
    serializeValueByType(writer, this.typeRegistry, returnType, result as JsonValue)
    writer.writeRest()
    this.messageChannel.commitSend()
  }

  private sendError(requestId: bigint, error: unknown): void {
    const { typeName, value } = resolveExceptionWire(error, this.typeRegistry)
    const writer = this.messageChannel.beginSend(RPC_ERROR_TYPE, { request_id: requestId })
    writer.writeException(typeName, value)
    writer.writeRest()
    this.messageChannel.commitSend()
  }
}
