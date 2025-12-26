import { TypeKind, type TypeDescription, type TypeMember, type TypeRegistry } from '../typeDescription.js'
import type { GeneratorOptions } from './cppClient.js'

function isPairType(type: TypeDescription): boolean {
  if (type.kind !== TypeKind.Object && type.kind !== TypeKind.DynamicObject) {
    return false
  }
  const name = type.name?.toLowerCase() || ''
  if (!name.includes('pair')) {
    return false
  }
  const members = type.members || []
  if (members.length !== 2) {
    return false
  }
  const memberNames = members.map(m => m.name.toLowerCase()).sort()
  return memberNames[0] === 'first' && memberNames[1] === 'second'
}

function isTupleType(type: TypeDescription): boolean {
  if (type.kind !== TypeKind.Object && type.kind !== TypeKind.DynamicObject) {
    return false
  }
  const name = type.name?.toLowerCase() || ''
  if (!name.includes('tuple')) {
    return false
  }
  const members = type.members || []
  return members.length > 0
}

export function generateCppServerCode(registry: TypeRegistry, options: GeneratorOptions = {}): string {
  const namespace = options.namespace
  const types = registry.getTypes()

  const enums = types.filter(type => type.kind === TypeKind.Enum)
  const objects = types.filter(type => {
    if (type.kind !== TypeKind.Object && type.kind !== TypeKind.DynamicObject) {
      return false
    }
    // Exclude pair and tuple types as they use std::pair and std::tuple
    return !isPairType(type) && !isTupleType(type)
  })
  const standaloneFunctions = types.filter(type => type.kind === TypeKind.Function && !type.name.includes('.'))

  // Check if pair or tuple types are used
  const usesPair = types.some(type => isPairType(type))
  const usesTuple = types.some(type => isTupleType(type))

  let code = ''
  code += '#pragma once\n\n'
  code += '#include <cstdint>\n'
  code += '#include <memory>\n'
  code += '#include <string>\n'
  code += '#include <vector>\n'
  code += '#include <map>\n'
  code += '#include <type_traits>\n'
  if (usesPair) {
    code += '#include <utility>\n'
  }
  if (usesTuple) {
    code += '#include <tuple>\n'
  }
  code += '\n'
  code += '#include "serialization/promise.hpp"\n'
  code += '#include "serialization/annotations.hpp"\n'
  code += '#include "serialization/type_description.hpp"\n'
  code += '#include "serialization/type_registry.hpp"\n'
  code += '#include "serialization/rpc_server.hpp"\n'
  code += '\n'

  if (namespace) {
    code += `namespace ${namespace} {\n\n`
  }

  const usesBinary = types.some(type => containsKind(type, TypeKind.Binary))
  if (usesBinary) {
    code += 'using binary = std::vector<std::uint8_t>;\n\n'
  }

  for (const enumType of enums) {
    code += renderEnum(enumType)
    code += '\n'
  }

  for (const objectType of objects) {
    code += renderObject(objectType)
    code += '\n'
  }

  if (standaloneFunctions.length > 0) {
    code += '// Standalone RPC functions\n'
    for (const fnType of standaloneFunctions) {
      code += renderStandaloneFunction(fnType)
      code += '\n'
    }
  }

  code += renderRegisterRpc(objects)
  code += '\n'
  code += renderRegisterTypes([...objects, ...enums])

  if (namespace) {
    code += `\n} // namespace ${namespace}\n`
  }

  return code
}

function renderEnum(enumType: TypeDescription): string {
  const members = enumType.enumMembers || []
  let result = `enum class ${enumType.name} {\n`
  members.forEach((member, index) => {
    const lineEnd = index === members.length - 1 ? '\n' : ',\n'
    result += `  ${member.name} = ${member.value}${lineEnd}`
  })
  result += '};\n'
  return result
}

function renderObject(objectType: TypeDescription): string {
  const dataMembers = (objectType.members || []).filter(member =>
    member.type.kind !== TypeKind.Method && member.type.kind !== TypeKind.Function
  )
  const methodMembers = (objectType.members || []).filter(member => member.type.kind === TypeKind.Method)
  const functionMembers = (objectType.members || []).filter(member => member.type.kind === TypeKind.Function)

  const bases = (objectType.bases || []).map(base => base.name).filter(Boolean)
  const baseClause = bases.length > 0 ? ` : ${bases.map(base => `public ${base}`).join(', ')}` : ''

  let result = `class ${objectType.name}${baseClause} {\n`
  result += ' public:\n'
  result += `  ${objectType.name}() = default;\n`
  result += '\n'

  for (const member of dataMembers) {
    const cppType = getCppType(member.type)
    result += `  ${cppType} ${member.name}{};\n`
  }
  if (dataMembers.length > 0) {
    result += '\n'
  }

  for (const member of methodMembers) {
    result += renderMethod(member, false)
    result += '\n'
  }

  for (const member of functionMembers) {
    result += renderMethod(member, true)
    result += '\n'
  }

  result += '};\n'
  return result
}

function renderMethod(member: TypeMember, isStatic: boolean): string {
  const methodType = member.type
  const methodName = methodType.name?.split('.').pop() || member.name
  const returnType = getCppType(methodType.item || { kind: TypeKind.Void, name: 'void' } as TypeDescription)
  const params = methodType.members || []

  const signatureParts: string[] = []
  if (isStatic) {
    signatureParts.push('static')
  }
  signatureParts.push(`std::shared_ptr<serialization::promise<${returnType}>>`)
  signatureParts.push(`${methodName}(`)

  const paramStrings = params.map(param => `${getCppType(param.type)} ${param.name}`)
  signatureParts.push(paramStrings.join(', '))
  signatureParts.push(')')

  const defaultValue = getDefaultValue(returnType)
  let body = ''
  body += '  {\n'
  body += '    /// TODO: implement\n'
  if (returnType === 'void') {
    body += '    return serialization::promise<void>::resolved();\n'
  } else if (defaultValue) {
    body += `    return serialization::promise<${returnType}>::resolved(${defaultValue});\n`
  } else {
    body += `    return std::make_shared<serialization::promise<${returnType}>>();\n`
  }
  body += '  }\n'

  return `  ${signatureParts.join(' ')}${body}`
}

function renderStandaloneFunction(fnType: TypeDescription): string {
  const fnName = fnType.name
  const returnType = getCppType(fnType.item || { kind: TypeKind.Void, name: 'void' } as TypeDescription)
  const params = fnType.members || []
  const paramStrings = params.map(param => `${getCppType(param.type)} ${param.name}`)

  let result = `std::shared_ptr<serialization::promise<${returnType}>> ${fnName}(${paramStrings.join(', ')}) {\n`
  result += '  /// TODO: implement\n'
  if (returnType === 'void') {
    result += '  return serialization::promise<void>::resolved();\n'
  } else {
    const defaultValue = getDefaultValue(returnType) || `${returnType}{}`
    result += `  return serialization::promise<${returnType}>::resolved(${defaultValue});\n`
  }
  result += '}\n'
  return result
}

function renderRegisterRpc(objects: TypeDescription[]): string {
  let result = 'template <typename RpcServer>\n'
  result += 'void register_rpc_server(RpcServer& server) {\n'
  result += '  (void)server;\n'
  result += '  // TODO: register standalone functions manually using RpcServer::register_static_method\n'
  for (const objectType of objects) {
    result += `  // Register RPC for ${objectType.name}\n`
    result += `  if constexpr (std::is_default_constructible_v<${objectType.name}>) {\n`
    result += `    ${objectType.name} value{};\n`
    result += '    RpcServer::template register_recursive(value, server);\n'
    result += '  } else {\n'
    result += `    // TODO: provide an instance of ${objectType.name} to register\n`
    result += '  }\n'
  }
  result += '}\n'
  return result
}

function renderRegisterTypes(types: TypeDescription[]): string {
  let result = 'template <typename Registry>\n'
  result += 'void register_types(Registry& registry) {\n'
  result += '  (void)registry;\n'
  for (const type of types) {
    const name = type.name
    result += `  // Register type ${name}\n`
    result += `  if constexpr (std::is_default_constructible_v<${name}>) {\n`
    result += `    registry.register_type(serialization::type_description::create(${name}(), registry));\n`
    result += '  } else {\n'
    result += `    // TODO: register ${name} manually if it is not default-constructible\n`
    result += '  }\n'
  }
  result += '}\n'
  return result
}

function getCppType(type: TypeDescription): string {
  // Check for pair type first
  if (isPairType(type)) {
    const members = type.members || []
    if (members.length === 2) {
      const firstType = getCppType(members[0].type)
      const secondType = getCppType(members[1].type)
      return `std::pair<${firstType}, ${secondType}>`
    }
  }

  // Check for tuple type
  if (isTupleType(type)) {
    const members = type.members || []
    if (members.length > 0) {
      const memberTypes = members.map(m => getCppType(m.type))
      return `std::tuple<${memberTypes.join(', ')}>`
    }
  }

  switch (type.kind) {
    case TypeKind.Void:
      return 'void'
    case TypeKind.UnsignedInteger:
      return 'std::uint64_t'
    case TypeKind.SignedInteger:
      return 'std::int64_t'
    case TypeKind.FloatingPoint:
      return 'double'
    case TypeKind.Boolean:
      return 'bool'
    case TypeKind.String:
      return 'std::string'
    case TypeKind.Binary:
      return 'std::vector<std::uint8_t>'
    case TypeKind.Array:
      if (type.item) {
        const itemType = getCppType(type.item)
        return `std::vector<${itemType}>`
      }
      return 'std::vector<void>'
    case TypeKind.Object:
    case TypeKind.DynamicObject:
      return type.name || 'void'
    case TypeKind.Pointer:
      if (type.item) {
        const itemType = getCppType(type.item)
        return `${itemType}*`
      }
      return 'void*'
    case TypeKind.Map:
      if (type.key && type.item) {
        const keyType = getCppType(type.key)
        const valueType = getCppType(type.item)
        return `std::map<${keyType}, ${valueType}>`
      }
      return 'std::map<void, void>'
    case TypeKind.Enum:
      return type.name || 'int'
    default:
      return type.name || 'void'
  }
}

function getDefaultValue(cppType: string): string | undefined {
  switch (cppType) {
    case 'void':
      return undefined
    case 'bool':
      return 'false'
    case 'std::uint64_t':
    case 'std::int64_t':
      return '0'
    case 'double':
      return '0.0'
    case 'std::string':
      return 'std::string{}'
    default:
      if (cppType.endsWith('*')) {
        return 'nullptr'
      }
      if (cppType.startsWith('std::pair<')) {
        return `${cppType}{}`
      }
      if (cppType.startsWith('std::tuple<')) {
        return `${cppType}{}`
      }
      return `${cppType}{}`
  }
}

function containsKind(type: TypeDescription, target: TypeKind): boolean {
  if (type.kind === target) {
    return true
  }
  if (type.item && containsKind(type.item, target)) {
    return true
  }
  if (type.key && containsKind(type.key, target)) {
    return true
  }
  for (const member of type.members || []) {
    if (containsKind(member.type, target)) {
      return true
    }
  }
  return false
}

