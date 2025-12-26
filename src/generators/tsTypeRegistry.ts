import { TypeKind, type TypeDescription, type TypeRegistry } from '../typeDescription.js'

export interface TsRegistryGeneratorOptions {
  functionName?: string
}

export interface TypeRegistryGenerationResult {
  varNames: string[]
  varNameMap: Map<TypeDescription, string>
  registryCode: string
}

export function sanitizeVariableName(name: string): string {
  // Replace invalid characters with underscores
  return name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^[0-9]/, '_$&') // Can't start with number
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, '') // Remove leading/trailing underscores
}

export function getTypeVariableName(type: TypeDescription, index: number, allTypes: TypeDescription[]): string {
  const baseName = sanitizeVariableName(type.name || `type_${index}`)
  
  // Check for duplicates and add index suffix if needed
  let varName = baseName
  let suffix = 0
  for (let i = 0; i < index; i++) {
    const otherType = allTypes[i]
    const otherBaseName = sanitizeVariableName(otherType.name || `type_${i}`)
    if (otherBaseName === baseName) {
      suffix++
    }
  }
  
  if (suffix > 0) {
    varName = `${baseName}_${suffix}`
  }
  
  // Ensure it's a valid identifier
  if (!varName || /^[0-9]/.test(varName)) {
    varName = `type_${varName || index}`
  }
  
  return varName
}

export function renderKind(kind: TypeKind): string {
  switch (kind) {
    case TypeKind.Void: return 'TypeKind.Void'
    case TypeKind.UnsignedInteger: return 'TypeKind.UnsignedInteger'
    case TypeKind.SignedInteger: return 'TypeKind.SignedInteger'
    case TypeKind.FloatingPoint: return 'TypeKind.FloatingPoint'
    case TypeKind.Boolean: return 'TypeKind.Boolean'
    case TypeKind.String: return 'TypeKind.String'
    case TypeKind.Binary: return 'TypeKind.Binary'
    case TypeKind.Enum: return 'TypeKind.Enum'
    case TypeKind.Array: return 'TypeKind.Array'
    case TypeKind.Object: return 'TypeKind.Object'
    case TypeKind.DynamicObject: return 'TypeKind.DynamicObject'
    case TypeKind.Pointer: return 'TypeKind.Pointer'
    case TypeKind.Map: return 'TypeKind.Map'
    case TypeKind.Function: return 'TypeKind.Function'
    case TypeKind.Method: return 'TypeKind.Method'
    default: return 'TypeKind.Void'
  }
}

export function generateTypeRegistryCode(
  registry: TypeRegistry,
  fnName: string
): TypeRegistryGenerationResult {
  const types = registry.getTypes()

  // Generate variable names for all types
  const varNames = types.map((type, i) => getTypeVariableName(type, i, types))
  const varNameMap = new Map<TypeDescription, string>()
  types.forEach((type, i) => varNameMap.set(type, varNames[i]))

  const lines: string[] = []
  lines.push(`export function ${fnName}(): TypeRegistry {`)
  lines.push('  const registry = new TypeRegistry()')
  lines.push('')

  // Step 1: declare type vars
  lines.push('  // Declare types (without members/item/key yet)')
  for (let i = 0; i < types.length; i++) {
    const type = types[i]
    const varName = varNames[i]
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

  lines.push('  return registry')
  lines.push('}')

  return {
    varNames,
    varNameMap,
    registryCode: lines.join('\n')
  }
}

export function generateTsTypeRegistry(registry: TypeRegistry, options: TsRegistryGeneratorOptions = {}): string {
  const fnName = options.functionName || 'createGeneratedTypeRegistry'
  const result = generateTypeRegistryCode(registry, fnName)
  
  const lines: string[] = []
  lines.push('// Auto-generated TypeScript TypeRegistry builder')
  lines.push("import { TypeRegistry, TypeDescription, TypeKind } from '@wa-os/ts-rpc'")
  lines.push('')
  lines.push(result.registryCode)
  lines.push('')
  
  return lines.join('\n')
}

