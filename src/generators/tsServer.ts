import { TypeKind, type TypeDescription, type TypeRegistry } from '../typeDescription.js'
import { generateTypeRegistryCode, getTypeVariableName, sanitizeVariableName, renderKind } from './tsTypeRegistry.js'

export interface TsServerGeneratorOptions {
  registryFunctionName?: string
  implementationFunctionName?: string
  setupFunctionName?: string
}

function getFunctionName(type: TypeDescription, varNameMap: Map<TypeDescription, string>): string {
  // Use the variable name from the registry generation to ensure uniqueness
  const varName = varNameMap.get(type)
  if (varName) {
    return `${varName}_impl`
  }
  // Fallback: sanitize the type name
  return sanitizeVariableName(type.name || 'unknown') + '_impl'
}

function getReturnTypeString(type: TypeDescription, varNameMap: Map<TypeDescription, string>): string {
  if (!type.item || type.item.kind === TypeKind.Void) {
    return 'Promise<void>'
  }
  return `Promise<${getTypeString(type.item, varNameMap)}>`
}

function getTypeString(type: TypeDescription, varNameMap: Map<TypeDescription, string>): string {
  switch (type.kind) {
    case TypeKind.Void:
      return 'void'
    case TypeKind.UnsignedInteger:
      return 'number'
    case TypeKind.SignedInteger:
      return 'number'
    case TypeKind.FloatingPoint:
      return 'number'
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
      // Use the generated TypeScript type name (variable name from registry)
      const objVarName = varNameMap.get(type)
      if (objVarName) {
        return objVarName
      }
      return type.name || 'any'
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
    case TypeKind.Enum:
      // Use the generated TypeScript type name (variable name from registry)
      const enumVarName = varNameMap.get(type)
      if (enumVarName) {
        return enumVarName
      }
      return type.name || 'number'
    default:
      return 'any'
  }
}

export function generateTsServer(registry: TypeRegistry, options: TsServerGeneratorOptions = {}): string {
  const registryFnName = options.registryFunctionName || 'createGeneratedTypeRegistry'
  const implementationFnName = options.implementationFunctionName || 'implementMethods'
  const setupFnName = options.setupFunctionName || 'setupServer'
  
  const types = registry.getTypes()
  const result = generateTypeRegistryCode(registry, registryFnName)
  const { varNames, varNameMap } = result
  
  // Find all Function and Method types
  const functionTypes: TypeDescription[] = []
  const methodTypes: TypeDescription[] = []
  
  for (const type of types) {
    if (type.kind === TypeKind.Function) {
      functionTypes.push(type)
    } else if (type.kind === TypeKind.Method) {
      methodTypes.push(type)
    }
  }
  
  const lines: string[] = []
  lines.push('// Auto-generated TypeScript RPC Server')
  lines.push("import { TypeRegistry, TypeDescription, TypeKind } from '@wa-os/ts-rpc'")
  lines.push('')
  
  // Generate TypeScript type definitions
  lines.push(result.typesCode)
  lines.push('')
  
  // Generate registry function
  lines.push(result.registryCode)
  lines.push('')
  
  // Generate empty implementations
  lines.push('// Empty method implementations')
  for (const type of [...functionTypes, ...methodTypes]) {
    const fnName = getFunctionName(type, varNameMap)
    const returnType = getReturnTypeString(type, varNameMap)
    const params = type.members || []
    
    lines.push(`async function ${fnName}(`)
    const paramStrings = params.map((p, i) => {
      const paramType = getTypeString(p.type, varNameMap)
      return `  ${p.name}: ${paramType}`
    })
    if (paramStrings.length > 0) {
      lines.push(paramStrings.join(',\n'))
    }
    lines.push(`): ${returnType} {`)
    lines.push('  /// TODO: implement')
    if (returnType === 'Promise<void>') {
      lines.push('  return Promise.resolve()')
    } else {
      const innerType = returnType.replace('Promise<', '').replace('>', '')
      if (innerType === 'number') {
        lines.push('  return Promise.resolve(0)')
      } else if (innerType === 'boolean') {
        lines.push('  return Promise.resolve(false)')
      } else if (innerType === 'string') {
        lines.push("  return Promise.resolve('')")
      } else if (innerType.endsWith('[]')) {
        lines.push('  return Promise.resolve([])')
      } else {
        lines.push(`  return Promise.resolve(null as any as ${innerType})`)
      }
    }
    lines.push('}')
    lines.push('')
  }
  
  // Generate implementation function
  lines.push(`export function ${implementationFnName}(result: ReturnType<typeof ${registryFnName}>): void {`)
  lines.push('  const { registry, types } = result')
  for (const type of [...functionTypes, ...methodTypes]) {
    const varName = varNameMap.get(type)
    const fnName = getFunctionName(type, varNameMap)
    if (varName) {
      lines.push(`  types['${varName}'].implementation = ${fnName}`)
    }
  }
  lines.push('}')
  lines.push('')
  
  // Generate setup function
  lines.push(`export function ${setupFnName}(): TypeRegistry {`)
  lines.push(`  const result = ${registryFnName}()`)
  lines.push(`  ${implementationFnName}(result)`)
  lines.push('  result.registry.assignMethodIds()')
  lines.push('  return result.registry')
  lines.push('}')
  lines.push('')
  
  return lines.join('\n')
}

