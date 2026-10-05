import { TypeKind, type TypeDescription, type TypeRegistry } from '../typeDescription.js'

export interface TsRegistryGeneratorOptions {
  functionName?: string
}

export interface TypeRegistryGenerationResult {
  varNames: string[]
  varNameMap: Map<TypeDescription, string>
  registryCode: string
  typesCode: string
}

// TypeScript reserved keywords that cannot be used as variable names
const TS_KEYWORDS = new Set([
  'void', 'any', 'unknown', 'never', 'object', 'string', 'number', 'boolean', 'bigint', 'symbol',
  'undefined', 'null', 'true', 'false',
  'let', 'const', 'var', 'function', 'class', 'interface', 'type', 'enum', 'namespace',
  'export', 'import', 'from', 'as', 'default', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new', 'this',
  'super', 'extends', 'implements', 'static', 'public', 'private', 'protected', 'readonly',
  'abstract', 'async', 'await', 'yield', 'of', 'in', 'instanceof', 'typeof', 'delete',
  'get', 'set', 'constructor', 'declare', 'module', 'require'
])

export function sanitizeVariableName(name: string): string {
  // Replace invalid characters with underscores
  return name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^[0-9]/, '_$&') // Can't start with number
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, '') // Remove leading/trailing underscores
}

export function escapeTypeScriptKeyword(name: string): string {
  if (TS_KEYWORDS.has(name)) {
    return `${name}_`
  }
  return name
}

export function assignTypeVariableNames(types: TypeDescription[]): string[] {
  const usedNames = new Set<string>()
  const varNames: string[] = []

  for (let i = 0; i < types.length; i++) {
    const type = types[i]
    let baseName = type.name
      ? sanitizeVariableName(type.name)
      : `type_${i}`
    baseName = escapeTypeScriptKeyword(baseName)

    let varName = baseName
    let collision = 2
    while (usedNames.has(varName)) {
      varName = `${baseName}_${collision}`
      collision++
    }
    usedNames.add(varName)
    varNames.push(varName)
  }

  return varNames
}

export function getTypeVariableName(type: TypeDescription, index: number, allTypes: TypeDescription[]): string {
  return assignTypeVariableNames(allTypes)[index]
}

export function renderKind(kind: TypeKind): string {
  switch (kind) {
    case TypeKind.Void: return 'TypeKind.Void'
    case TypeKind.Boolean: return 'TypeKind.Boolean'
    case TypeKind.UnsignedInteger8: return 'TypeKind.UnsignedInteger8'
    case TypeKind.SignedInteger8: return 'TypeKind.SignedInteger8'
    case TypeKind.UnsignedInteger16: return 'TypeKind.UnsignedInteger16'
    case TypeKind.SignedInteger16: return 'TypeKind.SignedInteger16'
    case TypeKind.UnsignedInteger32: return 'TypeKind.UnsignedInteger32'
    case TypeKind.SignedInteger32: return 'TypeKind.SignedInteger32'
    case TypeKind.UnsignedInteger64: return 'TypeKind.UnsignedInteger64'
    case TypeKind.SignedInteger64: return 'TypeKind.SignedInteger64'
    case TypeKind.FloatingPoint32: return 'TypeKind.FloatingPoint32'
    case TypeKind.FloatingPoint64: return 'TypeKind.FloatingPoint64'
    case TypeKind.Enum: return 'TypeKind.Enum'
    case TypeKind.Array: return 'TypeKind.Array'
    case TypeKind.String: return 'TypeKind.String'
    case TypeKind.Binary: return 'TypeKind.Binary'
    case TypeKind.Map: return 'TypeKind.Map'
    case TypeKind.Object: return 'TypeKind.Object'
    case TypeKind.DynamicObject: return 'TypeKind.DynamicObject'
    case TypeKind.Message: return 'TypeKind.Message'
    case TypeKind.Exception: return 'TypeKind.Exception'
    case TypeKind.Pointer: return 'TypeKind.Pointer'
    case TypeKind.Function: return 'TypeKind.Function'
    case TypeKind.Method: return 'TypeKind.Method'
    default: return 'TypeKind.Void'
  }
}

function generateTypeScriptType(type: TypeDescription, varNameMap: Map<TypeDescription, string>, typeVarName: string): string {
  switch (type.kind) {
    case TypeKind.Enum:
      if (type.enumMembers && type.enumMembers.length > 0) {
        const enumValues = type.enumMembers
          .map((m, idx) => {
            let name: string
            if (m.name && m.name.trim()) {
              name = sanitizeVariableName(m.name)
            } else {
              name = `Value${m.value !== undefined ? m.value : idx}`
            }
            const value = m.value !== undefined ? m.value : idx
            return `  ${name} = ${value}`
          })
          .join(',\n')
        return `export enum ${typeVarName} {\n${enumValues}\n}`
      }
      return `export type ${typeVarName} = number`
    
    case TypeKind.Object:
    case TypeKind.DynamicObject:
    case TypeKind.Message:
      if (type.members && type.members.length > 0) {
        const members = type.members
          .map(m => {
            const memberType = getTypeScriptTypeForMember(m.type, varNameMap)
            // Use quotes for property names that contain dots or other special characters
            const propertyName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(m.name) ? m.name : JSON.stringify(m.name)
            return `  ${propertyName}: ${memberType}`
          })
          .join('\n')
        return `export interface ${typeVarName} {\n${members}\n}`
      }
      return `export interface ${typeVarName} {}`
    
    default:
      return ''
  }
}

function getTypeScriptTypeForMember(type: TypeDescription, varNameMap: Map<TypeDescription, string>): string {
  switch (type.kind) {
    case TypeKind.Void:
      return 'void'
    case TypeKind.UnsignedInteger8:
    case TypeKind.SignedInteger8:
    case TypeKind.UnsignedInteger16:
    case TypeKind.SignedInteger16:
    case TypeKind.UnsignedInteger32:
    case TypeKind.SignedInteger32:
    case TypeKind.UnsignedInteger64:
    case TypeKind.SignedInteger64:
    case TypeKind.FloatingPoint32:
    case TypeKind.FloatingPoint64:
      return type.kind === TypeKind.UnsignedInteger64 || type.kind === TypeKind.SignedInteger64 ? 'bigint' : 'number'
    case TypeKind.Boolean:
      return 'boolean'
    case TypeKind.String:
      return 'string'
    case TypeKind.Binary:
      return 'Uint8Array'
    case TypeKind.Array:
      if (type.item) {
        const itemType = getTypeScriptTypeForMember(type.item, varNameMap)
        return `${itemType}[]`
      }
      return 'any[]'
    case TypeKind.Pointer:
      if (type.item) {
        const itemType = getTypeScriptTypeForMember(type.item, varNameMap)
        return `${itemType} | null`
      }
      return 'any | null'
    case TypeKind.Map:
      if (type.key && type.item) {
        const keyType = getTypeScriptTypeForMember(type.key, varNameMap)
        const itemType = getTypeScriptTypeForMember(type.item, varNameMap)
        return `Map<${keyType}, ${itemType}>`
      }
      return 'Map<any, any>'
    case TypeKind.Enum:
    case TypeKind.Object:
    case TypeKind.DynamicObject:
    case TypeKind.Message:
      const varName = varNameMap.get(type)
      if (varName) {
        return varName
      }
      return type.name || 'any'
    default:
      return 'any'
  }
}

export function generateTypeRegistryCode(
  registry: TypeRegistry,
  fnName: string
): TypeRegistryGenerationResult {
  const types = registry.getTypes()

  // Generate variable names for all types
  const varNames = assignTypeVariableNames(types)
  const varNameMap = new Map<TypeDescription, string>()
  types.forEach((type, i) => varNameMap.set(type, varNames[i]))

  // Generate TypeScript type definitions
  const typesLines: string[] = []
  typesLines.push('// TypeScript type definitions')
  for (let i = 0; i < types.length; i++) {
    const type = types[i]
    const varName = varNames[i]
    const tsType = generateTypeScriptType(type, varNameMap, varName)
    if (tsType) {
      typesLines.push(`// type index: ${i}`)
      typesLines.push(tsType)
      typesLines.push('')
    }
  }

  const lines: string[] = []
  lines.push(`export function ${fnName}(): { registry: TypeRegistry, types: { [key: string]: TypeDescription } } {`)
  lines.push('  const registry = new TypeRegistry()')
  lines.push('  const types: { [key: string]: TypeDescription } = {}')
  lines.push('')

  // Step 1: declare type vars
  lines.push('  // Declare types (without members/item/key yet)')
  for (let i = 0; i < types.length; i++) {
    const type = types[i]
    const varName = varNames[i]
    lines.push(`  // type index: ${i}`)
    lines.push(`  const ${varName} = TypeDescription.create({`)
    lines.push(`    name: ${JSON.stringify(type.name)},`)
    lines.push(`    kind: ${renderKind(type.kind)},`)
    if (type.enumMembers && type.enumMembers.length > 0) {
      lines.push('    enumMembers: [],')
    }
    if (type.bases && type.bases.length > 0) {
      lines.push('    bases: [],')
    }
    lines.push('  })')
    lines.push(`  types['${varName}'] = ${varName}`)
    lines.push('')
  }

  // Step 2: register in order
  lines.push('  // Register all types to preserve indices')
  for (let i = 0; i < types.length; i++) {
    lines.push(`  registry.registerType(${varNames[i]})`)
  }
  lines.push('')

  // Step 3: fill enumMembers, bases, item/key
  lines.push('  // Fill enumMembers, bases, item/key')
  for (let i = 0; i < types.length; i++) {
    const type = types[i]
    const varName = varNames[i]
    if (type.enumMembers && type.enumMembers.length > 0) {
      lines.push(`  ${varName}.enumMembers = [`)
      for (const m of type.enumMembers) {
        lines.push(`    { name: ${JSON.stringify(m.name)}, value: ${m.value} },`)
      }
      lines.push('  ]')
    }
    if (type.bases && type.bases.length > 0) {
      lines.push(`  ${varName}.bases = [`)
      for (const b of type.bases) {
        const baseVarName = varNameMap.get(b)
        if (baseVarName) {
          lines.push(`    ${baseVarName},`)
        }
      }
      lines.push('  ]')
    }
    if (type.item) {
      const itemVarName = varNameMap.get(type.item)
      if (itemVarName) {
        lines.push(`  ${varName}.item = ${itemVarName}`)
      }
    }
    if (type.key) {
      const keyVarName = varNameMap.get(type.key)
      if (keyVarName) {
        lines.push(`  ${varName}.key = ${keyVarName}`)
      }
    }
    if (type.enumMembers?.length || type.bases?.length || type.item || type.key) {
      lines.push('')
    }
  }

  // Step 4: fill members
  lines.push('  // Fill members (after all types exist)')
  for (let i = 0; i < types.length; i++) {
    const type = types[i]
    const varName = varNames[i]
    if (type.members && type.members.length > 0) {
      lines.push(`  ${varName}.members = [`)
      for (const m of type.members) {
        if (!m.type) {
          lines.push('    {')
          lines.push(`      name: ${JSON.stringify(m.name)},`)
          lines.push('      type: null as unknown as TypeDescription,')
          lines.push('      annotations: [],')
          lines.push('    },')
          continue
        }
        const memberVarName = varNameMap.get(m.type)
        if (memberVarName) {
          lines.push('    {')
          lines.push(`      name: ${JSON.stringify(m.name)},`)
          lines.push(`      type: ${memberVarName},`)
          lines.push('      annotations: [],')
          lines.push('    },')
        }
      }
      lines.push('  ]')
      lines.push('')
    }
  }

  lines.push('  return { registry, types }')
  lines.push('}')

  return {
    varNames,
    varNameMap,
    registryCode: lines.join('\n'),
    typesCode: typesLines.join('\n')
  }
}

export function generateTsTypeRegistry(registry: TypeRegistry, options: TsRegistryGeneratorOptions = {}): string {
  const fnName = options.functionName || 'createGeneratedTypeRegistry'
  const result = generateTypeRegistryCode(registry, fnName)
  
  const lines: string[] = []
  lines.push('// Auto-generated TypeScript TypeRegistry builder')
  lines.push("import { TypeRegistry, TypeDescription, TypeKind } from '@wa-os/ts-rpc'")
  lines.push('')
  lines.push(result.typesCode)
  lines.push('')
  lines.push(result.registryCode)
  lines.push('')
  
  return lines.join('\n')
}

