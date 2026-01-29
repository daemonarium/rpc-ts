import type { Reader } from './reader.js'
import type { Writer } from './writer.js'
import type { TypeRegistry, TypeDescription, RegisteredMethod } from './typeDescription.js'
import { TypeKind } from './typeDescription.js'
import { serializeValueByType, deserializeValueByType, type JsonValue } from './valueSerialization.js'
import { RpcException } from './RpcException.js'
import type { RpcClient } from './RpcClient.js'

type ResponseHandler = (reader: Reader) => void

export class RawRpcClient implements RpcClient {
  private readonly responseHandlers = new Map<number, ResponseHandler>()
  private lastRequestId = 0
  private readonly writer: Writer
  private readonly typeRegistry: TypeRegistry
  private readonly sender: () => void
  private readonly methodsById = new Map<number, RegisteredMethod>()

  constructor(writer: Writer, typeRegistry: TypeRegistry, sender: () => void) {
    this.writer = writer
    this.typeRegistry = typeRegistry
    this.sender = sender
    // Build method lookup map
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

  /**
   * Call a static or singleton method using methodId from registry
   */
  call(methodId: number, ...args: any[]): Promise<any> {
    const method = this.getMethod(methodId)
    if (method.methodType.kind === TypeKind.Method) {
      throw new Error(`Method ${methodId} is a dynamic method, use callMethod instead`)
    }
    
    const returnType = method.methodType.item || { kind: TypeKind.Void, name: 'void' } as TypeDescription
    const parameterTypes = (method.methodType.members || []).map(m => m.type)
    
    return new Promise((resolve, reject) => {
      const requestId = this.lastRequestId++
      this.responseHandlers.set(requestId, (reader) => {
        const success = reader.readBool()
        if (!success) {
          const errorMessage = reader.readString()
          reject(new RpcException(errorMessage))
          return
        }
        if (returnType.kind === TypeKind.Void) {
          resolve(undefined)
          return
        }
        let result: any
        deserializeValueByType(reader, this.typeRegistry, returnType, (value) => {
          result = value
        })
        reader.readRest()
        resolve(result)
      })
      this.writeCall(requestId, methodId, parameterTypes, args)
      this.sender()
    })
  }

  /**
   * Call a dynamic method (requires object ID) using methodId from registry
   */
  callMethod<TId>(methodId: number, id: TId, ...args: any[]): Promise<any> {
    const method = this.getMethod(methodId)
    if (method.methodType.kind === TypeKind.Function) {
      throw new Error(`Method ${methodId} is a static/singleton method, use call instead`)
    }
    
    // For dynamic methods, we need to find the ID type from the owner type
    // This assumes the owner type has an ID field - we might need to adjust this logic
    // For now, let's assume the first member of owner type that's not a method is the ID
    const ownerType = method.ownerType
    const idMember = ownerType.members?.find(m => 
      m.type.kind !== TypeKind.Method && m.type.kind !== TypeKind.Function
    )
    if (!idMember) {
      throw new Error(`Could not determine ID type for dynamic method ${methodId}`)
    }
    const idType = idMember.type
    
    const returnType = method.methodType.item || { kind: TypeKind.Void, name: 'void' } as TypeDescription
    const parameterTypes = (method.methodType.members || []).map(m => m.type)
    
    return new Promise((resolve, reject) => {
      const requestId = this.lastRequestId++
      this.responseHandlers.set(requestId, (reader) => {
        const success = reader.readBool()
        if (!success) {
          const errorMessage = reader.readString()
          reject(new RpcException(errorMessage))
          return
        }
        if (returnType.kind === TypeKind.Void) {
          resolve(undefined)
          return
        }
        let result: any
        deserializeValueByType(reader, this.typeRegistry, returnType, (value) => {
          result = value
        })
        reader.readRest()
        resolve(result)
      })
      this.writeMethodCall(requestId, methodId, id, idType, parameterTypes, args)
      this.sender()
    })
  }

  /**
   * Handle an incoming response
   */
  handleResponse(reader: Reader): void {
    const requestId = Number(reader.readU64())
    const handler = this.responseHandlers.get(requestId)
    if (!handler) {
      throw new Error(`Response handler ${requestId} not found`)
    }
    handler(reader)
    this.responseHandlers.delete(requestId)
  }

  private writeCall(requestId: number, functionId: number, parameterTypes: TypeDescription[], args: any[]): void {
    this.writer.writeU64(requestId)
    this.writer.writeU64(functionId)
    if (args.length !== parameterTypes.length) {
      throw new Error(`Argument count mismatch: expected ${parameterTypes.length}, got ${args.length}`)
    }
    for (let i = 0; i < args.length; i++) {
      serializeValueByType(this.writer, this.typeRegistry, parameterTypes[i], args[i] as JsonValue)
    }
    this.writer.writeRest()
  }

  private writeMethodCall<TId>(
    requestId: number,
    functionId: number,
    id: TId,
    idType: TypeDescription,
    parameterTypes: TypeDescription[],
    args: any[]
  ): void {
    this.writer.writeU64(requestId)
    this.writer.writeU64(functionId)
    serializeValueByType(this.writer, this.typeRegistry, idType, id as JsonValue)
    if (args.length !== parameterTypes.length) {
      throw new Error(`Argument count mismatch: expected ${parameterTypes.length}, got ${args.length}`)
    }
    for (let i = 0; i < args.length; i++) {
      serializeValueByType(this.writer, this.typeRegistry, parameterTypes[i], args[i] as JsonValue)
    }
    this.writer.writeRest()
  }
}
