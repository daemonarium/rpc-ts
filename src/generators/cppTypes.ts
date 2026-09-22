import { TypeKind, type TypeDescription, type TypeRegistry } from '../typeDescription.js'
import type { GeneratorOptions } from './cppClient.js'

function isPairType(type: TypeDescription): boolean {
  if (type.kind !== TypeKind.Object && type.kind !== TypeKind.DynamicObject && type.kind !== TypeKind.Message) {
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
  if (type.kind !== TypeKind.Object && type.kind !== TypeKind.DynamicObject && type.kind !== TypeKind.Message) {
    return false
  }
  const name = type.name?.toLowerCase() || ''
  if (!name.includes('tuple')) {
    return false
  }
  const members = type.members || []
  return members.length > 0
}

function normalizeExceptionName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^std::/, '')
    .replace(/^std::chrono::/, '')
    .replace(/^std::filesystem::/, 'filesystem::')
}

type StdExceptionInfo = {
  cppType: string
  createExpression: string
}

const BUILTIN_CPP_TYPE_MAP = new Map<string, string>([
  ['rpc_request', 'serialization::rpc_request'],
  ['rpc_response', 'serialization::rpc_response'],
  ['rpc_error', 'serialization::rpc_error'],
  ['unknown_exception', 'serialization::unknown_exception'],
  ['read_annotation', 'serialization::read_annotation'],
  ['observable_annotation', 'serialization::observable_annotation'],
  ['streamable_annotation', 'serialization::streamable_annotation'],
  ['member_annotation', 'serialization::member_annotation']
])

const STD_EXCEPTION_MAP = new Map<string, StdExceptionInfo>([
  ['logic_error', { cppType: 'std::logic_error', createExpression: 'std::logic_error(std::string{})' }],
  ['invalid_argument', { cppType: 'std::invalid_argument', createExpression: 'std::invalid_argument(std::string{})' }],
  ['domain_error', { cppType: 'std::domain_error', createExpression: 'std::domain_error(std::string{})' }],
  ['length_error', { cppType: 'std::length_error', createExpression: 'std::length_error(std::string{})' }],
  ['out_of_range', { cppType: 'std::out_of_range', createExpression: 'std::out_of_range(std::string{})' }],
  ['future_error', { cppType: 'std::future_error', createExpression: 'std::future_error(std::future_errc::broken_promise)' }],
  ['runtime_error', { cppType: 'std::runtime_error', createExpression: 'std::runtime_error(std::string{})' }],
  ['range_error', { cppType: 'std::range_error', createExpression: 'std::range_error(std::string{})' }],
  ['overflow_error', { cppType: 'std::overflow_error', createExpression: 'std::overflow_error(std::string{})' }],
  ['underflow_error', { cppType: 'std::underflow_error', createExpression: 'std::underflow_error(std::string{})' }],
  ['regex_error', { cppType: 'std::regex_error', createExpression: 'std::regex_error(std::regex_constants::error_collate)' }],
  ['system_error', { cppType: 'std::system_error', createExpression: 'std::system_error(std::error_code{})' }],
  ['ios_base::failure', { cppType: 'std::ios_base::failure', createExpression: 'std::ios_base::failure(std::string{})' }],
  ['filesystem::filesystem_error', { cppType: 'std::filesystem::filesystem_error', createExpression: 'std::filesystem::filesystem_error(std::string{}, std::filesystem::path{}, std::error_code{})' }],
  ['tx_exception', { cppType: 'std::tx_exception', createExpression: 'std::tx_exception{}' }],
  ['nonexistent_local_time', { cppType: 'std::chrono::nonexistent_local_time', createExpression: 'std::chrono::nonexistent_local_time(std::string{})' }],
  ['ambiguous_local_time', { cppType: 'std::chrono::ambiguous_local_time', createExpression: 'std::chrono::ambiguous_local_time(std::string{})' }],
  ['format_error', { cppType: 'std::format_error', createExpression: 'std::format_error(std::string{})' }],
  ['bad_typeid', { cppType: 'std::bad_typeid', createExpression: 'std::bad_typeid{}' }],
  ['bad_cast', { cppType: 'std::bad_cast', createExpression: 'std::bad_cast{}' }],
  ['bad_any_cast', { cppType: 'std::bad_any_cast', createExpression: 'std::bad_any_cast{}' }],
  ['bad_optional_access', { cppType: 'std::bad_optional_access', createExpression: 'std::bad_optional_access{}' }],
  ['bad_expected_access', { cppType: 'std::bad_expected_access<void>', createExpression: 'std::bad_expected_access<void>{}' }],
  ['bad_weak_ptr', { cppType: 'std::bad_weak_ptr', createExpression: 'std::bad_weak_ptr{}' }],
  ['bad_function_call', { cppType: 'std::bad_function_call', createExpression: 'std::bad_function_call{}' }],
  ['bad_alloc', { cppType: 'std::bad_alloc', createExpression: 'std::bad_alloc{}' }],
  ['bad_array_new_length', { cppType: 'std::bad_array_new_length', createExpression: 'std::bad_array_new_length{}' }],
  ['bad_exception', { cppType: 'std::bad_exception', createExpression: 'std::bad_exception{}' }],
  ['bad_variant_access', { cppType: 'std::bad_variant_access', createExpression: 'std::bad_variant_access{}' }]
])

function getStandardExceptionInfo(typeName?: string): StdExceptionInfo | undefined {
  if (!typeName) return undefined
  const normalized = normalizeExceptionName(typeName)
  return STD_EXCEPTION_MAP.get(normalized)
}

function getBuiltinCppType(typeName?: string): string | undefined {
  if (!typeName) return undefined
  return BUILTIN_CPP_TYPE_MAP.get(typeName)
}

export function generateCppTypesCode(registry: TypeRegistry, options: GeneratorOptions = {}): string {
  const namespace = options.namespace
  const types = registry.getTypes()

  const enums = types.filter(type => type.kind === TypeKind.Enum)
  const objects = types.filter(type => {
    if (type.kind !== TypeKind.Object && type.kind !== TypeKind.DynamicObject && type.kind !== TypeKind.Message) {
      return false
    }
    return !isPairType(type) && !isTupleType(type)
  })
  const exceptions = types.filter(type => type.kind === TypeKind.Exception)
  const dynamicObjects = types.filter(type => type.kind === TypeKind.DynamicObject)
  const messages = types.filter(type => type.kind === TypeKind.Message)
  const customExceptions = exceptions.filter(type => !getStandardExceptionInfo(type.name))
  const generatedObjects = objects.filter(type => !getBuiltinCppType(type.name))
  const generatedEnums = enums.filter(type => !getBuiltinCppType(type.name))
  const generatedCustomExceptions = customExceptions.filter(type => !getBuiltinCppType(type.name))
  const declarationOrder = orderTypeDeclarations(generatedEnums, generatedObjects, generatedCustomExceptions)

  const usesPair = types.some(type => isPairType(type))
  const usesTuple = types.some(type => isTupleType(type))

  let code = ''
  code += '#pragma once\n\n'
  code += '#include <cstdint>\n'
  code += '#include <exception>\n'
  code += '#include <future>\n'
  code += '#include <functional>\n'
  code += '#include <map>\n'
  code += '#include <memory>\n'
  code += '#include <optional>\n'
  code += '#include <regex>\n'
  code += '#include <string>\n'
  code += '#include <system_error>\n'
  code += '#include <typeinfo>\n'
  code += '#include <variant>\n'
  code += '#include <vector>\n'
  code += '#include <chrono>\n'
  code += '#include <filesystem>\n'
  code += '#include <stdexcept>\n'
  code += '#include <new>\n'
  if (usesPair) {
    code += '#include <utility>\n'
  }
  if (usesTuple) {
    code += '#include <tuple>\n'
  }
  code += '\n'
  code += '#include <serialization/annotations.hpp>\n'
  code += '#include <serialization/rpc.hpp>\n'
  code += '#include <serialization/type_description.hpp>\n'
  code += '#include <serialization/type_registry.hpp>\n'
  code += '\n'

  if (namespace) {
    code += `namespace ${namespace} {\n\n`
  }

  const usesBinary = types.some(type => containsKind(type, TypeKind.Binary))
  if (usesBinary) {
    code += 'using binary = std::vector<std::uint8_t>;\n\n'
  }

  for (const type of declarationOrder) {
    if (type.kind === TypeKind.Enum) {
      code += renderEnum(type)
    } else if (type.kind === TypeKind.Exception) {
      code += renderCustomException(type)
    } else {
      code += renderObject(type)
    }
    code += '\n'
  }

  code += renderRegisterTypes([...objects, ...enums], exceptions)
  code += '\n'
  code += renderRegisterCodecs(dynamicObjects, messages, exceptions)

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
  result += '};\n'
  return result
}

function renderCustomException(exceptionType: TypeDescription): string {
  const dataMembers = (exceptionType.members || []).filter(member =>
    member.type.kind !== TypeKind.Method && member.type.kind !== TypeKind.Function && member.name !== 'what'
  )

  let result = `class ${exceptionType.name} : public std::exception {\n`
  result += ' public:\n'
  result += `  ${exceptionType.name}() = default;\n`
  result += `  explicit ${exceptionType.name}(std::string message) : message_(std::move(message)) {}\n`
  result += '  const char* what() const noexcept override { return message_.c_str(); }\n'

  if (dataMembers.length > 0) {
    result += '\n'
    for (const member of dataMembers) {
      result += `  ${getCppType(member.type)} ${member.name}{};\n`
    }
  }

  result += '\n'
  result += ' private:\n'
  result += '  std::string message_{};\n'
  result += '};\n'
  return result
}

function renderRegisterTypes(types: TypeDescription[], exceptions: TypeDescription[]): string {
  let result = 'template <typename Registry>\n'
  result += 'void register_types(Registry& registry) {\n'
  result += '  (void)registry;\n'

  for (const type of types) {
    const name = type.name
    result += `  // Register type ${name}\n`
    result += `  registry.register_type(serialization::type_description::create(${getTypeCreateExpression(type)}, registry));\n`
  }

  for (const exceptionType of exceptions) {
    const name = exceptionType.name
    const stdInfo = getStandardExceptionInfo(name)
    result += `  // Register exception ${name}\n`
    if (stdInfo) {
      result += `  registry.register_type(serialization::type_description::create(${stdInfo.createExpression}, registry));\n`
    } else {
      result += `  registry.register_type(serialization::type_description::create(${getTypeCreateExpression(exceptionType)}, registry));\n`
    }
  }

  result += '}\n'
  return result
}

function orderTypeDeclarations(
  enums: TypeDescription[],
  objects: TypeDescription[],
  customExceptions: TypeDescription[]
): TypeDescription[] {
  const all: TypeDescription[] = [...enums, ...objects, ...customExceptions]
  const byName = new Map<string, TypeDescription>()
  for (const type of all) {
    if (type.name) byName.set(type.name, type)
  }

  const originalIndex = new Map<TypeDescription, number>()
  all.forEach((type, index) => originalIndex.set(type, index))

  const deps = new Map<TypeDescription, Set<TypeDescription>>()
  const reverse = new Map<TypeDescription, Set<TypeDescription>>()
  const indegree = new Map<TypeDescription, number>()
  for (const type of all) {
    deps.set(type, new Set())
    reverse.set(type, new Set())
    indegree.set(type, 0)
  }

  for (const type of all) {
    for (const dep of getDeclarationDependencies(type, byName)) {
      if (dep === type) continue
      const depSet = deps.get(type)!
      if (depSet.has(dep)) continue
      depSet.add(dep)
      reverse.get(dep)!.add(type)
      indegree.set(type, (indegree.get(type) || 0) + 1)
    }
  }

  const queue: TypeDescription[] = all
    .filter(type => (indegree.get(type) || 0) === 0)
    .sort((a, b) => (originalIndex.get(a) || 0) - (originalIndex.get(b) || 0))

  const result: TypeDescription[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    result.push(current)
    const dependants = Array.from(reverse.get(current) || [])
      .sort((a, b) => (originalIndex.get(a) || 0) - (originalIndex.get(b) || 0))
    for (const dependant of dependants) {
      const nextIn = (indegree.get(dependant) || 0) - 1
      indegree.set(dependant, nextIn)
      if (nextIn === 0) queue.push(dependant)
    }
  }

  // Cycle fallback: keep registry order for unresolved nodes.
  if (result.length !== all.length) {
    const inResult = new Set(result)
    for (const type of all) {
      if (!inResult.has(type)) result.push(type)
    }
  }
  return result
}

function getDeclarationDependencies(type: TypeDescription, byName: Map<string, TypeDescription>): Set<TypeDescription> {
  const deps = new Set<TypeDescription>()
  const add = (candidate?: TypeDescription): void => {
    if (!candidate?.name) return
    const dep = byName.get(candidate.name)
    if (!dep || dep === type) return
    deps.add(dep)
  }

  if (type.kind === TypeKind.Object || type.kind === TypeKind.DynamicObject || type.kind === TypeKind.Message) {
    for (const base of type.bases || []) {
      add(base)
    }
  }

  if (
    type.kind === TypeKind.Object ||
    type.kind === TypeKind.DynamicObject ||
    type.kind === TypeKind.Message ||
    type.kind === TypeKind.Exception
  ) {
    for (const member of type.members || []) {
      if (member.type.kind === TypeKind.Method || member.type.kind === TypeKind.Function) continue
      if (type.kind === TypeKind.Exception && member.name === 'what') continue
      collectMemberTypeDependencies(member.type, byName, deps)
    }
  }

  return deps
}

function collectMemberTypeDependencies(
  type: TypeDescription,
  byName: Map<string, TypeDescription>,
  deps: Set<TypeDescription>
): void {
  const builtin = getBuiltinCppType(type.name)
  const stdEx = getStandardExceptionInfo(type.name)
  if (type.name && !builtin && !stdEx) {
    const dep = byName.get(type.name)
    if (dep) deps.add(dep)
  }
  if (type.item) collectMemberTypeDependencies(type.item, byName, deps)
  if (type.key) collectMemberTypeDependencies(type.key, byName, deps)
}

function renderRegisterCodecs(dynamicObjects: TypeDescription[], messages: TypeDescription[], exceptions: TypeDescription[]): string {
  let result = 'template <typename CodecRegistry>\n'
  result += 'void register_codecs(CodecRegistry& codecs) {\n'
  result += '  (void)codecs;\n'

  for (const type of dynamicObjects) {
    result += `  codecs.template register_dynamic_type<${getTypeRegistrationName(type)}>();\n`
  }

  for (const type of messages) {
    result += `  codecs.template register_message_type<${getTypeRegistrationName(type)}>();\n`
  }

  for (const type of exceptions) {
    const stdInfo = getStandardExceptionInfo(type.name)
    if (stdInfo) {
      result += `  codecs.template register_exception_type<${stdInfo.cppType}>();\n`
      continue
    }
    result += `  codecs.template register_exception_type<${getTypeRegistrationName(type)}>();\n`
  }

  result += '}\n'
  return result
}

function getTypeRegistrationName(type: TypeDescription): string {
  const builtin = getBuiltinCppType(type.name)
  if (builtin) return builtin
  return type.name || 'void'
}

function getTypeCreateExpression(type: TypeDescription): string {
  return `${getTypeRegistrationName(type)}{}`
}

function getCppType(type: TypeDescription): string {
  if (isPairType(type)) {
    const members = type.members || []
    if (members.length === 2) {
      const firstType = getCppType(members[0].type)
      const secondType = getCppType(members[1].type)
      return `std::pair<${firstType}, ${secondType}>`
    }
  }

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
    case TypeKind.UnsignedInteger8:
      return 'std::uint8_t'
    case TypeKind.SignedInteger8:
      return 'std::int8_t'
    case TypeKind.UnsignedInteger16:
      return 'std::uint16_t'
    case TypeKind.SignedInteger16:
      return 'std::int16_t'
    case TypeKind.UnsignedInteger32:
      return 'std::uint32_t'
    case TypeKind.SignedInteger32:
      return 'std::int32_t'
    case TypeKind.UnsignedInteger64:
      return 'std::uint64_t'
    case TypeKind.SignedInteger64:
      return 'std::int64_t'
    case TypeKind.FloatingPoint32:
      return 'float'
    case TypeKind.FloatingPoint64:
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
    case TypeKind.Message:
    case TypeKind.Exception: {
      const builtinType = getBuiltinCppType(type.name)
      if (builtinType) return builtinType
      const stdInfo = getStandardExceptionInfo(type.name)
      return stdInfo?.cppType || type.name || 'void'
    }
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
