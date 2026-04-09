import type { TypeRegistry, RegisteredMethod } from './typeDescription.js'
import type { TypeDescription } from './typeDescription.js'
import { TypeKind } from './typeDescription.js'
import { CodecRegistry } from './codec.js'
import { SocketMessageChannel, type SocketMessageChannelSocket } from './SocketMessageChannel.js'
import { ensureRpcTypesInRegistry, ensureRpcCodecs, RPC_REQUEST_TYPE, RPC_RESPONSE_TYPE, RPC_ERROR_TYPE } from './rpc.js'
import { serializeValueByType, deserializeValueByType, type JsonValue } from './valueSerialization.js'
import { RpcException } from './RpcException.js'
import type { RpcClient } from './RpcClient.js'

interface PendingResponse {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  returnType: TypeDescription
}

function toRequestId(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
}

export class SocketRpcClient implements RpcClient {
  private readonly messageChannel: SocketMessageChannel
  private readonly typeRegistry: TypeRegistry
  private readonly methodsById = new Map<number, RegisteredMethod>()
  private readonly responseHandlers = new Map<bigint, PendingResponse>()
  private lastRequestId = 0n

  constructor(socket: SocketMessageChannelSocket, typeRegistry: TypeRegistry, codecs: CodecRegistry) {
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

    this.messageChannel.onMessage(RPC_RESPONSE_TYPE, (msg: { request_id: number | bigint }, _payloadSize: number) => {
      const requestId = toRequestId(msg.request_id)
      const pending = this.responseHandlers.get(requestId)
      if (!pending) throw new Error(`Response handler ${requestId.toString()} not found`)
      this.responseHandlers.delete(requestId)
      if (pending.returnType.kind === TypeKind.Void) {
        pending.resolve(undefined)
        return
      }
      let result: unknown
      deserializeValueByType(this.messageChannel.getReader() as any, this.typeRegistry, pending.returnType, (value) => {
        result = value
      })
      this.messageChannel.getReader().readRest()
      pending.resolve(result)
    })

    this.messageChannel.onMessage(RPC_ERROR_TYPE, (msg: { request_id: number | bigint }) => {
      const requestId = toRequestId(msg.request_id)
      const pending = this.responseHandlers.get(requestId)
      if (!pending) throw new Error(`Response handler ${requestId.toString()} not found`)
      this.responseHandlers.delete(requestId)
      const exc = this.messageChannel.getReader().readException()
      this.messageChannel.getReader().readRest()
      const message = (exc.value as { what?: string }).what ?? String(exc.value)
      pending.reject(new RpcException(message, exc.typeName))
    })

    socket.setOptions?.({
      dataEventCallback: () => {
        this.messageChannel.handleData()
      }
    })

    for (const method of typeRegistry.getMethods()) {
      this.methodsById.set(method.methodId, method)
    }
  }

  getMethod(methodId: number): RegisteredMethod {
    const method = this.methodsById.get(methodId)
    if (!method) {
      throw new Error(`Method with id ${methodId} not found in registry`)
    }
    return method
  }

  call(methodId: number, ...args: any[]): Promise<any> {
    const method = this.getMethod(methodId)
    if (method.methodType.kind === TypeKind.Method) {
      throw new Error(`Method ${methodId} is a dynamic method, use callMethod instead`)
    }
    const returnType = method.methodType.item || ({ kind: TypeKind.Void, name: 'void' } as TypeDescription)
    const parameterTypes = (method.methodType.members || []).map((m) => m.type)
    const requestId = this.lastRequestId
    this.lastRequestId += 1n
    const promise = new Promise((resolve, reject) => {
      this.responseHandlers.set(requestId, { resolve, reject, returnType })
    })
    const writer = this.messageChannel.beginSend(RPC_REQUEST_TYPE, {
      request_id: requestId,
      function_id: BigInt(methodId)
    })
    if (args.length !== parameterTypes.length) {
      throw new Error(`Argument count mismatch: expected ${parameterTypes.length}, got ${args.length}`)
    }
    for (let i = 0; i < args.length; i++) {
      serializeValueByType(writer as any, this.typeRegistry, parameterTypes[i], args[i] as JsonValue)
    }
    writer.writeRest()
    this.messageChannel.commitSend()
    return promise
  }

  callMethod<TId>(methodId: number, id: TId, ...args: any[]): Promise<any> {
    const method = this.getMethod(methodId)
    if (method.methodType.kind === TypeKind.Function) {
      throw new Error(`Method ${methodId} is a static/singleton method, use call instead`)
    }
    const ownerType = method.ownerType
    const idMember = ownerType.members?.find((m) => m.type.kind !== TypeKind.Method && m.type.kind !== TypeKind.Function)
    if (!idMember) {
      throw new Error(`Could not determine ID type for dynamic method ${methodId}`)
    }
    const idType = idMember.type
    const returnType = method.methodType.item || ({ kind: TypeKind.Void, name: 'void' } as TypeDescription)
    const parameterTypes = (method.methodType.members || []).map((m) => m.type)
    const requestId = this.lastRequestId
    this.lastRequestId += 1n
    const promise = new Promise((resolve, reject) => {
      this.responseHandlers.set(requestId, { resolve, reject, returnType })
    })
    const writer = this.messageChannel.beginSend(RPC_REQUEST_TYPE, {
      request_id: requestId,
      function_id: BigInt(methodId)
    })
    serializeValueByType(writer as any, this.typeRegistry, idType, id as JsonValue)
    if (args.length !== parameterTypes.length) {
      throw new Error(`Argument count mismatch: expected ${parameterTypes.length}, got ${args.length}`)
    }
    for (let i = 0; i < args.length; i++) {
      serializeValueByType(writer as any, this.typeRegistry, parameterTypes[i], args[i] as JsonValue)
    }
    writer.writeRest()
    this.messageChannel.commitSend()
    return promise
  }

  handleResponse(): void {
    this.messageChannel.handleData()
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
