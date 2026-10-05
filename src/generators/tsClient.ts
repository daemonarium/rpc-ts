import {
  TypeKind,
  isMemberObservable,
  isMemberStreamable,
  type TypeDescription,
  type TypeMember,
  type TypeRegistry,
} from '../typeDescription.js'
import type { GeneratorOptions } from './cppClient.js'
import { generateTypeRegistryCode, sanitizeVariableName } from './tsTypeRegistry.js'

export interface TsClientGeneratorOptions extends GeneratorOptions {
  importPath?: string
}

function shortMethodName(member: TypeMember): string {
  return member.name?.split('.').pop() || member.name || 'call'
}

function isStreamHandleParam(param: TypeMember): boolean {
  return param.type.name === 'stream_handle' || param.name === 'stream'
}

function extraMethodParams(params: TypeMember[]): TypeMember[] {
  if (params.length > 0 && isStreamHandleParam(params[0])) {
    return params.slice(1)
  }
  return params
}

function getTypeString(type: TypeDescription, varNameMap: Map<TypeDescription, string>): string {
  switch (type.kind) {
    case TypeKind.Void:
      return 'void'
    case TypeKind.UnsignedInteger8:
    case TypeKind.SignedInteger8:
    case TypeKind.UnsignedInteger16:
    case TypeKind.SignedInteger16:
    case TypeKind.UnsignedInteger32:
    case TypeKind.SignedInteger32:
    case TypeKind.FloatingPoint32:
    case TypeKind.FloatingPoint64:
      return 'number'
    case TypeKind.UnsignedInteger64:
    case TypeKind.SignedInteger64:
      return 'bigint'
    case TypeKind.Boolean:
      return 'boolean'
    case TypeKind.String:
      return 'string'
    case TypeKind.Binary:
      return 'Uint8Array'
    case TypeKind.Array:
      if (type.item) {
        return `${getTypeString(type.item, varNameMap)}[]`
      }
      return 'any[]'
    case TypeKind.Object:
    case TypeKind.DynamicObject:
    case TypeKind.Message: {
      const objVarName = varNameMap.get(type)
      if (objVarName) {
        return objVarName
      }
      return type.name || 'any'
    }
    case TypeKind.Pointer:
      if (type.item) {
        return `${getTypeString(type.item, varNameMap)} | null`
      }
      return 'any | null'
    case TypeKind.Map:
      if (type.key && type.item) {
        return `Map<${getTypeString(type.key, varNameMap)}, ${getTypeString(type.item, varNameMap)}>`
      }
      return 'Map<any, any>'
    case TypeKind.Enum: {
      const enumVarName = varNameMap.get(type)
      if (enumVarName) {
        return enumVarName
      }
      return type.name || 'number'
    }
    default:
      return 'any'
  }
}

function getReturnTypeString(type: TypeDescription, varNameMap: Map<TypeDescription, string>): string {
  if (!type.item || type.item.kind === TypeKind.Void) {
    return 'Promise<void>'
  }
  return `Promise<${getTypeString(type.item, varNameMap)}>`
}

function buildMethodIdMap(registry: TypeRegistry): Map<TypeDescription, number> {
  const map = new Map<TypeDescription, number>()
  let id = 0
  for (const type of registry.getTypes()) {
    if (type.kind !== TypeKind.Object && type.kind !== TypeKind.DynamicObject && type.kind !== TypeKind.Message) continue
    for (const member of type.members || []) {
      if (member.type.kind === TypeKind.Method || member.type.kind === TypeKind.Function) {
        map.set(member.type, member.type.methodId ?? id)
        id++
      }
    }
  }
  return map
}

function renderParamList(params: TypeMember[], varNameMap: Map<TypeDescription, string>): string {
  return params.map((param) => {
    const propertyName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(param.name)
      ? param.name
      : JSON.stringify(param.name)
    return `${propertyName}: ${getTypeString(param.type, varNameMap)}`
  }).join(', ')
}

function renderArgList(params: TypeMember[]): string {
  return params.map((param) => {
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(param.name)) {
      return param.name
    }
    return JSON.stringify(param.name)
  }).join(', ')
}

function clientClassName(type: TypeDescription, objectsWithMethods: number, options: TsClientGeneratorOptions): string {
  const sanitized = type.name ? `${sanitizeVariableName(type.name)}_client` : 'generated_client'
  if (objectsWithMethods === 1 && options.className) {
    return options.className
  }
  return sanitized
}

function renderOriginalMethod(
  member: TypeMember,
  methodId: number,
  varNameMap: Map<TypeDescription, string>
): string {
  const methodName = shortMethodName(member)
  const params = member.type.members || []
  const returnType = getReturnTypeString(member.type, varNameMap)
  const paramList = renderParamList(params, varNameMap)
  const argList = renderArgList(params)
  const callArgs = argList.length > 0 ? `, ${argList}` : ''
  const lines: string[] = []
  lines.push(`  ${methodName}(${paramList}): ${returnType} {`)
  lines.push(`    return this.rpcClient.call(${methodId}${callArgs})`)
  lines.push('  }')
  return lines.join('\n')
}

function renderExtraMethod(
  member: TypeMember,
  methodId: number,
  suffix: string,
  varNameMap: Map<TypeDescription, string>
): string {
  const methodName = `${shortMethodName(member)}${suffix}`
  const params = extraMethodParams(member.type.members || [])
  const paramList = renderParamList(params, varNameMap)
  const argList = renderArgList(params)
  const callArgs = argList.length > 0 ? `, ${argList}` : ''
  const lines: string[] = []
  lines.push(`  ${methodName}(${paramList}): RemoteReference {`)
  lines.push(`    return this.remoteRegistry.getOrCreate(${methodId}${callArgs})`)
  lines.push('  }')
  return lines.join('\n')
}

function isStreamHandleDispatch(first: string): string {
  return `args.length > 0 && ${first} && typeof ${first} === 'object' && 'stream_id' in (${first} as object)`
}

function renderObservableOverloads(
  member: TypeMember,
  methodId: number,
  varNameMap: Map<TypeDescription, string>
): string {
  const methodName = shortMethodName(member)
  const origParams = member.type.members || []
  const extraParams = extraMethodParams(origParams)
  const origParamList = renderParamList(origParams, varNameMap)
  const extraParamList = renderParamList(extraParams, varNameMap)
  const returnType = getReturnTypeString(member.type, varNameMap)
  const lines: string[] = []
  lines.push(`  ${methodName}(${origParamList}): ${returnType}`)
  lines.push(`  ${methodName}(${extraParamList}): RemoteReference`)
  lines.push(`  ${methodName}(...args: any[]): ${returnType} | RemoteReference {`)
  lines.push(`    const first = args[0]`)
  lines.push(`    if (${isStreamHandleDispatch('first')}) {`)
  lines.push(`      return this.rpcClient.call(${methodId}, ...args)`)
  lines.push('    }')
  lines.push(`    return this.remoteRegistry.getOrCreate(${methodId}, ...args)`)
  lines.push('  }')
  return lines.join('\n')
}

export function generateTsClient(registry: TypeRegistry, options: TsClientGeneratorOptions = {}): string {
  const importPath = options.importPath || '@wa-os/ts-rpc'
  const objectTypes = registry.getTypes().filter((type) =>
    type.kind === TypeKind.Object || type.kind === TypeKind.DynamicObject || type.kind === TypeKind.Message
  )

  const objectsWithMethods = objectTypes
    .map((type) => ({
      type,
      methods: (type.members || []).filter((member) =>
        member.type.kind === TypeKind.Method || member.type.kind === TypeKind.Function
      )
    }))
    .filter((entry) => entry.methods.length > 0)

  const result = generateTypeRegistryCode(registry, 'createGeneratedTypeRegistry')
  const { varNameMap, typesCode } = result
  const methodIdMap = buildMethodIdMap(registry)

  const lines: string[] = []
  lines.push('// Auto-generated TypeScript RPC Client')
  lines.push(`import { SocketRpcClient, RemoteReference, RemoteRegistry, StreamMultiplexer, type MessageChannel } from '${importPath}'`)
  lines.push('')
  lines.push(typesCode)
  lines.push('')

  if (objectsWithMethods.length === 0) {
    lines.push('// No object types with methods found')
    lines.push('')
    return lines.join('\n')
  }

  for (const { type, methods } of objectsWithMethods) {
    const className = clientClassName(type, objectsWithMethods.length, options)
    lines.push(`export class ${className} {`)
    lines.push('  readonly rpcClient: SocketRpcClient')
    lines.push('  readonly remoteRegistry: RemoteRegistry')
    lines.push('')
    lines.push('  constructor(')
    lines.push('    rpcClient: SocketRpcClient,')
    lines.push('    returnPid: bigint | number,')
    lines.push('    returnSocket: number,')
    lines.push('    streamChannel?: MessageChannel,')
    lines.push('    remoteRegistry?: RemoteRegistry')
    lines.push('  ) {')
    lines.push('    this.rpcClient = rpcClient')
    lines.push('    this.remoteRegistry = remoteRegistry ?? new RemoteRegistry(')
    lines.push('      streamChannel')
    lines.push('        ? new StreamMultiplexer(rpcClient, streamChannel, returnPid, returnSocket)')
    lines.push('        : new StreamMultiplexer(rpcClient, returnPid, returnSocket)')
    lines.push('    )')
    lines.push('  }')
    lines.push('')

    for (const method of methods) {
      const methodId = methodIdMap.get(method.type) ?? method.type.methodId ?? -1
      if (isMemberObservable(method)) {
        lines.push(renderObservableOverloads(method, methodId, varNameMap))
        lines.push('')
      } else {
        lines.push(renderOriginalMethod(method, methodId, varNameMap))
        lines.push('')
        if (isMemberStreamable(method)) {
          lines.push(renderExtraMethod(method, methodId, '_stream', varNameMap))
          lines.push('')
        }
      }
    }

    lines.push('}')
    lines.push('')
  }

  return lines.join('\n')
}
