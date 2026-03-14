import type { Reader } from './reader.js'
import type { Writer } from './writer.js'
import type { TypeRegistry, TypeDescription } from './typeDescription.js'
import { TypeKind } from './typeDescription.js'
import { deserializeValueByType, serializeValueByType, type JsonValue } from './valueSerialization.js'

type RpcHandler = (reader: Reader, writer: Writer, requestId: number) => Promise<void>

export interface MethodDescription {
  parameterTypes: TypeDescription[]
  returnType: TypeDescription
  idType?: TypeDescription // for dynamic methods
}

export class RawRpcServer {
  private readonly handlers = new Map<number, RpcHandler>()
  private readonly typeRegistry: TypeRegistry
  private readonly beforeSend: () => void
  private readonly sender: () => void

  constructor(typeRegistry: TypeRegistry, beforeSend: () => void, sender: () => void) {
    this.typeRegistry = typeRegistry
    this.beforeSend = beforeSend
    this.sender = sender
    this.registerFromRegistry()
  }

  /**
   * Register all methods from the registry
   * Must be called after assignMethodIds() has been called and implementations have been set
   */
  registerFromRegistry(): void {
    const methods = this.typeRegistry.getMethods()
    
    for (const method of methods) {
      const methodId = method.methodId
      const methodType = method.methodType
      const ownerType = method.ownerType
      const memberName = method.memberName
      
      if (methodType.kind === TypeKind.Function) {
        // Static method or function
        if (!methodType.implementation) {
          throw new Error(`Method ${methodId} (${memberName}) has no implementation`)
        }
        
        const handler = methodType.implementation
        const returnType = methodType.item || { kind: TypeKind.Void, name: 'void' } as TypeDescription
        const parameterTypes = (methodType.members || []).map(m => m.type)
        
        this.handlers.set(methodId, async (reader, writer, requestId) => {
          return this.processCall(
            () => this.callWithArgs(handler, reader, parameterTypes),
            returnType,
            writer,
            requestId
          )
        })
      } else if (methodType.kind === TypeKind.Method) {
        // Method - can be dynamic (needs ID) or singleton (no ID)
        const returnType = methodType.item || { kind: TypeKind.Void, name: 'void' } as TypeDescription
        const parameterTypes = (methodType.members || []).map(m => m.type)
        
        // Check if this is a singleton method (has singletonInstance function)
        const getSingletonInstance = ownerType.singletonInstance
        if (getSingletonInstance) {
          // Singleton method - no ID needed, use singleton instance
          // Verify the method exists on the prototype/instance
          const testInstance = getSingletonInstance()
          const testMethodHandler = testInstance[memberName]
          if (!testMethodHandler || typeof testMethodHandler !== 'function') {
            throw new Error(`Method ${memberName} not found on singleton instance for type ${ownerType.name}`)
          }
          
          this.handlers.set(methodId, async (reader, writer, requestId) => {
            // Get singleton instance for each call
            const instance = getSingletonInstance()
            const methodHandler = instance[memberName]
            return this.processCall(
              () => this.callWithArgs((...args: any[]) => methodHandler.call(instance, ...args), reader, parameterTypes),
              returnType,
              writer,
              requestId
            )
          })
        } else {
          // Dynamic method - needs object instance via ID
          const fetchObject = ownerType.fetchObjectImplementation
          if (!fetchObject) {
            throw new Error(`Owner type ${ownerType.name} has no fetchObjectImplementation or singletonInstance for method ${methodId} (${memberName})`)
          }
          
          // Get method implementation from owner instance or prototype
          const instance = ownerType.implementationInstance || {}
          const methodHandler = instance[memberName]
          if (!methodHandler || typeof methodHandler !== 'function') {
            throw new Error(`Method ${memberName} not found on instance for type ${ownerType.name}`)
          }
          
          // Determine ID type from owner type (first non-method member, or custom logic)
          const idMember = ownerType.members?.find(m => 
            m.type.kind !== TypeKind.Method && m.type.kind !== TypeKind.Function
          )
          if (!idMember) {
            throw new Error(`Could not determine ID type for owner type ${ownerType.name}`)
          }
          const idType = idMember.type
          
          this.handlers.set(methodId, async (reader, writer, requestId) => {
            // Deserialize ID first
            let id: any
            deserializeValueByType(reader, this.typeRegistry, idType, (value) => {
              id = value
            })
            const object = fetchObject(id!)
            
            return this.processCall(
              () => this.callWithArgs((...args: any[]) => methodHandler.call(object, ...args), reader, parameterTypes),
              returnType,
              writer,
              requestId
            )
          })
        }
      }
    }
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
    return this.handlers.has(methodId)
  }

  /**
   * Handle an RPC call when request_id and method_id were already read (e.g. from a message channel).
   */
  async handleCallWithIds(requestId: number, methodId: number, reader: Reader, writer: Writer): Promise<void> {
    const handler = this.handlers.get(methodId)
    if (!handler) {
      this.beforeSend()
      writer.writeU64(requestId)
      writer.writeBool(false)
      writer.writeString('Function not found')
      writer.writeRest()
      this.sender()
      return
    }
    await handler(reader, writer, requestId)
  }

  private callWithArgs(
    handler: (...args: any[]) => any,
    reader: Reader,
    parameterTypes: TypeDescription[]
  ): any {
    const args: any[] = []
    for (const paramType of parameterTypes) {
      let argValue: any
      deserializeValueByType(reader, this.typeRegistry, paramType, (value) => {
        argValue = value
      })
      args.push(argValue)
    }
    reader.readRest()
    return handler(...args)
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
