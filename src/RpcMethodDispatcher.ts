import type { Reader } from './reader.js'
import type { TypeRegistry, TypeDescription } from './typeDescription.js'
import { TypeKind } from './typeDescription.js'
import { deserializeValueByType } from './valueSerialization.js'

export interface PreparedRpcCall {
  returnType: TypeDescription
  callFn: () => unknown
}

type CallPreparer = (reader: Reader) => PreparedRpcCall

export class RpcMethodDispatcher {
  private readonly typeRegistry: TypeRegistry
  private readonly callPreparers = new Map<number, CallPreparer>()

  constructor(typeRegistry: TypeRegistry) {
    this.typeRegistry = typeRegistry
    this.registerFromRegistry()
  }

  hasMethod(methodId: number): boolean {
    return this.callPreparers.has(methodId)
  }

  prepareCall(methodId: number, reader: Reader): PreparedRpcCall {
    const preparer = this.callPreparers.get(methodId)
    if (!preparer) {
      throw new Error('Function not found')
    }
    return preparer(reader)
  }

  private registerFromRegistry(): void {
    const methods = this.typeRegistry.getMethods()

    for (const method of methods) {
      const methodId = method.methodId
      const methodType = method.methodType
      const ownerType = method.ownerType
      const memberName = method.memberName
      const returnType = methodType.item || ({ kind: TypeKind.Void, name: 'void' } as TypeDescription)
      const parameterTypes = (methodType.members || []).map((member) => member.type)

      if (methodType.kind === TypeKind.Function) {
        const handler = methodType.implementation
        if (!handler) {
          throw new Error(`Method ${methodId} (${memberName}) has no implementation`)
        }
        this.callPreparers.set(methodId, (reader) => ({
          returnType,
          callFn: () => this.callWithArgs(handler, reader, parameterTypes)
        }))
        continue
      }

      if (methodType.kind !== TypeKind.Method) {
        continue
      }

      const getSingletonInstance = ownerType.singletonInstance
      if (getSingletonInstance) {
        const testInstance = getSingletonInstance()
        const testMethodHandler = testInstance[memberName]
        if (!testMethodHandler || typeof testMethodHandler !== 'function') {
          throw new Error(`Method ${memberName} not found on singleton instance for type ${ownerType.name}`)
        }

        this.callPreparers.set(methodId, (reader) => ({
          returnType,
          callFn: () => {
            const instance = getSingletonInstance()
            const methodHandler = instance[memberName]
            return this.callWithArgs((...args: any[]) => methodHandler.call(instance, ...args), reader, parameterTypes)
          }
        }))
        continue
      }

      const fetchObject = ownerType.fetchObjectImplementation
      if (!fetchObject) {
        throw new Error(`Owner type ${ownerType.name} has no fetchObjectImplementation or singletonInstance for method ${methodId} (${memberName})`)
      }

      const instance = ownerType.implementationInstance || {}
      const methodHandler = instance[memberName]
      if (!methodHandler || typeof methodHandler !== 'function') {
        throw new Error(`Method ${memberName} not found on instance for type ${ownerType.name}`)
      }

      const idMember = ownerType.members?.find((member) =>
        member.type.kind !== TypeKind.Method && member.type.kind !== TypeKind.Function
      )
      if (!idMember) {
        throw new Error(`Could not determine ID type for owner type ${ownerType.name}`)
      }
      const idType = idMember.type

      this.callPreparers.set(methodId, (reader) => {
        let id: any
        deserializeValueByType(reader, this.typeRegistry, idType, (value) => {
          id = value
        })
        const object = fetchObject(id)

        return {
          returnType,
          callFn: () => this.callWithArgs((...args: any[]) => methodHandler.call(object, ...args), reader, parameterTypes)
        }
      })
    }
  }

  private callWithArgs(
    handler: (...args: any[]) => any,
    reader: Reader,
    parameterTypes: TypeDescription[]
  ): unknown {
    // Pointer arguments are assigned during readRest, after the headers.
    // Hold slots so the handler sees the filled values, not the pre-rest snapshot.
    const slots: Array<{ value: unknown }> = []
    for (const paramType of parameterTypes) {
      const slot = { value: undefined as unknown }
      deserializeValueByType(reader, this.typeRegistry, paramType, (value) => {
        slot.value = value
      })
      slots.push(slot)
    }
    reader.readRest()
    return handler(...slots.map((slot) => slot.value))
  }
}
