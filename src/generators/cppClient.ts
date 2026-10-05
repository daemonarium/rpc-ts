import { TypeRegistry, TypeKind, type TypeDescription, type TypeMember } from '../typeDescription.js'

export interface GeneratorOptions {
  className?: string
  namespace?: string
  importPath?: string
}

export function generateCppGlueCode(registry: TypeRegistry, options: GeneratorOptions = {}): string {
  const namespace = options.namespace
  const objectTypes = registry.getTypes().filter(type =>
    type.kind === TypeKind.Object || type.kind === TypeKind.DynamicObject || type.kind === TypeKind.Message
  )

  const objectsWithMethods = objectTypes
    .map(type => ({
      type,
      methods: (type.members || []).filter(member =>
        member.type?.kind === TypeKind.Method || member.type?.kind === TypeKind.Function
      )
    }))
    .filter(entry => entry.methods.length > 0)

  if (objectsWithMethods.length === 0) {
    return '// No object types with methods found'
  }

  // Build method ids globally in registry order to match RPC server registration
  const methodIdMap = buildMethodIdMap(registry)

  let code = ''
  
  // Add includes
  code += '#include <serialization/rpc_client.hpp>\n'
  code += '#include <serialization/promise.hpp>\n'
  code += '#include <memory>\n'
  code += '#include <string>\n'
  code += '#include <vector>\n'
  code += '#include <map>\n'
  code += '#include <cstdint>\n'
  code += '\n'

  // Add namespace if specified
  if (namespace) {
    code += `namespace ${namespace} {\n\n`
  }

  // Generate one client class per object type
  for (const { type, methods } of objectsWithMethods) {
    const defaultName = type.name ? `${type.name}_rpc` : 'generated_rpc'
    const finalClassName =
      objectsWithMethods.length === 1 && options.className
        ? options.className
        : defaultName

    code += `template <typename rpc_client_type>\n`
    code += `class ${finalClassName} {\n`
    code += `  public:\n`
    code += `    ${finalClassName}(std::shared_ptr<rpc_client_type> rpc_client) : rpc_client_(rpc_client) {}\n`
    code += `    ~${finalClassName}() {}\n`
    code += `    \n`

    for (const method of methods) {
      const returnType = getCppType(method.type.item || { kind: TypeKind.Void, name: 'void' } as TypeDescription)
      const methodName = (method.name?.split('.').pop() || method.name || 'call')
      const params = method.type.members || []
      const methodId = methodIdMap.get(method.type) ?? -1
      
      code += `    std::shared_ptr<serialization::promise<${returnType}>> ${methodName}(`
      
      const paramStrings: string[] = []
      for (const param of params) {
        const paramType = param.type ? getCppType(param.type) : 'void*'
        paramStrings.push(`${paramType} ${param.name}`)
      }
      code += paramStrings.join(', ')
      code += `) {\n`
      
      code += `      return rpc_client_->template call<${returnType}>(${methodId}`
      for (const param of params) {
        code += `, ${param.name}`
      }
      code += `);\n`
      code += `    }\n\n`
    }

    code += `  private:\n`
    code += `    std::shared_ptr<rpc_client_type> rpc_client_;\n`
    code += `};\n\n`
  }

  // Close namespace if specified
  if (namespace) {
    code += `\n} // namespace ${namespace}\n`
  }

  return code
}

function buildMethodIdMap(registry: TypeRegistry): Map<TypeDescription, number> {
  const map = new Map<TypeDescription, number>()
  let id = 0
  for (const type of registry.getTypes()) {
    if (type.kind !== TypeKind.Object && type.kind !== TypeKind.DynamicObject && type.kind !== TypeKind.Message) continue
    for (const member of type.members || []) {
      if (member.type?.kind === TypeKind.Method || member.type?.kind === TypeKind.Function) {
        map.set(member.type, member.type.methodId ?? id)
        id++
      }
    }
  }
  return map
}

function getCppType(type: TypeDescription): string {
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
