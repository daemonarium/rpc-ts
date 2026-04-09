import type { Reader } from './reader.js'
import type { Writer } from './writer.js'
import type { TypeRegistry, TypeDescription } from './typeDescription.js'
import { TypeKind } from './typeDescription.js'
import { serializeValueByType, type JsonValue } from './valueSerialization.js'
import { RpcMethodDispatcher } from './RpcMethodDispatcher.js'
type RpcErrorHandler = (requestId: number, error: unknown) => void

export interface MethodDescription {
  parameterTypes: TypeDescription[]
  returnType: TypeDescription
  idType?: TypeDescription // for dynamic methods
}

export class RawRpcServer {
  private readonly methodDispatcher: RpcMethodDispatcher
  private readonly typeRegistry: TypeRegistry
  private readonly beforeSend: () => void
  private readonly sender: () => void
  private readonly onError?: RpcErrorHandler

  constructor(typeRegistry: TypeRegistry, beforeSend: () => void, sender: () => void, onError?: RpcErrorHandler) {
    this.typeRegistry = typeRegistry
    this.beforeSend = beforeSend
    this.sender = sender
    this.onError = onError
    this.methodDispatcher = new RpcMethodDispatcher(typeRegistry)
  }

  /**
   * Handle an incoming RPC call
   */
  async handleCall(reader: Reader, writer: Writer): Promise<void> {
    const requestId = Number(reader.readU64())
    const methodId = Number(reader.readU64())
    return this.handleCallWithIds(requestId, methodId, reader, writer)
  }

  hasHandler(methodId: number): boolean {
    return this.methodDispatcher.hasMethod(methodId)
  }

  /**
   * Handle an RPC call when request_id and method_id were already read (e.g. from a message channel).
   */
  async handleCallWithIds(requestId: number, methodId: number, reader: Reader, writer: Writer): Promise<void> {
    if (!this.methodDispatcher.hasMethod(methodId)) {
      this.beforeSend()
      writer.writeU64(requestId)
      writer.writeBool(false)
      writer.writeString('Function not found')
      writer.writeRest()
      this.sender()
      return
    }
    const prepared = this.methodDispatcher.prepareCall(methodId, reader)
    await this.processCall(prepared.callFn, prepared.returnType, writer, requestId)
  }

  private async processCall(
    callFn: () => any,
    returnType: TypeDescription,
    writer: Writer,
    requestId: number
  ): Promise<void> {
    try {
      const result = await callFn()
      this.beforeSend()
      writer.writeU64(requestId)
      writer.writeBool(true)
      if (returnType.kind !== TypeKind.Void) {
        serializeValueByType(writer, this.typeRegistry, returnType, result as JsonValue)
      }
      writer.writeRest()
      this.sender()
    } catch (error) {
      if (this.onError) {
        this.onError(requestId, error)
        return
      }
      this.beforeSend()
      writer.writeU64(requestId)
      writer.writeBool(false)
      const errorMessage = error instanceof Error ? error.message : String(error)
      writer.writeString(errorMessage)
      writer.writeRest()
      this.sender()
    }
  }
}
