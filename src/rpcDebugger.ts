import type { Reader } from './reader.js'
import { Reader as ReaderImpl } from './reader.js'
import type { TypeRegistry, TypeDescription, RegisteredMethod } from './typeDescription.js'
import { TypeKind } from './typeDescription.js'
import { CodecRegistry } from './codec.js'

export interface RpcMessage {
  type: TypeDescription
  kind: 'request' | 'response'
  data: Uint8Array
  requestId: number
  success?: boolean  // only for response
}

export class RpcDebugger {
  private readonly typeRegistry: TypeRegistry
  private readonly methodsById = new Map<number, RegisteredMethod>()
  private readonly codecs: CodecRegistry

  constructor(typeRegistry: TypeRegistry, codecs: CodecRegistry) {
    this.typeRegistry = typeRegistry
    this.codecs = codecs
    // Build method lookup map
    for (const method of typeRegistry.getMethods()) {
      this.methodsById.set(method.methodId, method)
    }
  }

  /**
   * Decode a request packet
   */
  decodeRequest(data: ArrayBuffer | Uint8Array): RpcMessage {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const reader = new ReaderImpl(bytes, this.codecs)
    
    // Request format: [requestId: u64][methodId: u64][id?][...params]
    const requestId = Number(reader.readU64())
    const methodId = Number(reader.readU64())
    
    const method = this.methodsById.get(methodId)
    if (!method) {
      throw new Error(`Method with id ${methodId} not found in registry`)
    }
    
    return {
      type: method.methodType,
      kind: 'request',
      data: bytes,
      requestId
    }
  }

  /**
   * Decode a response packet
   * @param data Response data
   * @param methodId Method ID to determine return type (can be inferred from requestId if tracked)
   */
  decodeResponse(data: ArrayBuffer | Uint8Array, methodId?: number): RpcMessage {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const reader = new ReaderImpl(bytes, this.codecs)
    
    // Response format: [requestId: u64][success: bool][result_or_error]
    const requestId = Number(reader.readU64())
    const success = reader.readBool()
    
    let returnType: TypeDescription
    let actualMethodId = methodId
    
    // If methodId not provided, try to find it (this won't work perfectly without tracking)
    if (typeof actualMethodId !== 'number') { /// can be zero
      // We can't reliably determine methodId from response alone
      // For now, use void type
      returnType = { kind: TypeKind.Void, name: 'void' } as TypeDescription
    } else {
      const method = this.methodsById.get(actualMethodId)
      if (!method) {
        returnType = { kind: TypeKind.Void, name: 'void' } as TypeDescription
      } else {
        returnType = method.methodType.item || { kind: TypeKind.Void, name: 'void' } as TypeDescription
      }
    }
    
    // For error, use string type
    if (!success) {
      returnType = { kind: TypeKind.String, name: 'string' } as TypeDescription
    }
    
    return {
      type: returnType,
      kind: 'response',
      data: bytes,
      requestId,
      success
    }
  }
}
