import { TypeRegistry, TypeKind, type TypeDescription, type TypeMember } from '../typeDescription.js'

export interface GeneratorOptions {
  className?: string
  namespace?: string
}

export function generateCppGlueCode(registry: TypeRegistry, options: GeneratorOptions = {}): string {
  const className = options.className || 'GeneratedRpc'
  const namespace = options.namespace

  // Find all object types with methods
  const objectTypes = registry.getTypes().filter(type => {
    if (type.kind !== TypeKind.Object) {
      return false
    }
    return type.members?.some(member => 
      member.type.kind === TypeKind.Method || member.type.kind === TypeKind.Function
    ) || false
  })

  if (objectTypes.length === 0) {
    return '// No object types with methods found'
  }

  // For now, generate code for the first object type (can be extended later)
  const objectType = objectTypes[0]
  const methods = objectType.members?.filter(member => 
    member.type.kind === TypeKind.Method || member.type.kind === TypeKind.Function
  ) || []

  // Use object type name for class name if not specified
  const finalClassName = className === 'GeneratedRpc' && objectType.name 
    ? `${objectType.name}Rpc` 
    : className

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

  // Generate class template
  code += `template <typename rpc_client_type>\n`
  code += `class ${finalClassName} {\n`
  code += `  public:\n`
  code += `    ${finalClassName}(std::shared_ptr<rpc_client_type> rpc_client) : rpc_client_(rpc_client) {}\n`
  code += `    ~${finalClassName}() {}\n`
  code += `    \n`

  // Generate methods
  let methodId = 0
  for (const method of methods) {
    const returnType = getCppType(method.type.item || { kind: TypeKind.Void, name: 'void' } as TypeDescription)
    const methodName = method.name
    const params = method.type.members || []
    
    code += `    std::shared_ptr<serialization::promise<${returnType}>> ${methodName}(`
    
    // Generate parameters
    const paramStrings: string[] = []
    for (const param of params) {
      const paramType = getCppType(param.type)
      paramStrings.push(`${paramType} ${param.name}`)
    }
    code += paramStrings.join(', ')
    code += `) {\n`
    
    // Generate call
    code += `      return rpc_client_->template call<${returnType}>(${methodId}`
    for (const param of params) {
      code += `, ${param.name}`
    }
    code += `);\n`
    code += `    }\n\n`
    
    methodId++
  }

  code += `  private:\n`
  code += `    std::shared_ptr<rpc_client_type> rpc_client_;\n`
  code += `};\n`

  // Close namespace if specified
  if (namespace) {
    code += `\n} // namespace ${namespace}\n`
  }

  return code
}

function getCppType(type: TypeDescription): string {
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
