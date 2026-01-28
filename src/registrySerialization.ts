import { CodecRegistry } from './codec.js'
import { Reader } from './reader.js'
import { TypeRegistry, TypeDescription, TypeKind, TypeDescriptionParameters } from './typeDescription.js'
import { 
  registerDynamicCodecs, serializeValueByType, deserializeValueByType, JsonValue,
  deserializeTypedJson
} from './valueSerialization.js'

export function deserializeTypeRegistry(serialized: Uint8Array): TypeRegistry {
  const typeRegistrySerializationRegistry = createTypeRegistrySerializationRegistry()
  const codecs = new CodecRegistry()  
  registerDynamicCodecs(codecs, typeRegistrySerializationRegistry)
  const reader = new Reader(serialized, codecs)
  const rawTypeRegistry = deserializeTypedJson(reader, typeRegistrySerializationRegistry, 'type_registry')
  const typeRegistry = new TypeRegistry(rawTypeRegistry._types as TypeDescription[])
  return typeRegistry
}

let typeRegistryCodecs: CodecRegistry | undefined = undefined
export function createTypeRegistryCodecs(): CodecRegistry {
  if (typeRegistryCodecs) {
    return typeRegistryCodecs
  }
  const typeRegistrySerializationRegistry = createTypeRegistrySerializationRegistry()
  const codecs = new CodecRegistry()  
  registerDynamicCodecs(codecs, typeRegistrySerializationRegistry)
  typeRegistryCodecs = codecs

  codecs.replace({
    name: 'type_description',
    serialize: (writer, value) => serializeValueByType(
      writer, typeRegistrySerializationRegistry, typeRegistrySerializationRegistry.getTypeByName('type_registry'), 
      value as JsonValue
    ),
    deserialize: (reader, output) => {
      let rawTypeDescription
      deserializeValueByType(reader, typeRegistrySerializationRegistry,
          typeRegistrySerializationRegistry.getTypeByName('type_description'), 
          (value) => rawTypeDescription = value as unknown as TypeDescriptionParameters
        )
      output(TypeDescription.create({
        name: rawTypeDescription.name,
        kind: TypeKind.Object,
        members: rawTypeDescription.members,
        annotations: rawTypeDescription.annotations,
        enumMembers: rawTypeDescription.enumMembers,
        bases: rawTypeDescription.bases,
        item: rawTypeDescription.item,
        key: rawTypeDescription.key
      }))
      return
    }
  })
  return codecs
}
let typeRegistrySerializationRegistry: TypeRegistry | undefined = undefined
export function createTypeRegistrySerializationRegistry(): TypeRegistry {
  if (typeRegistrySerializationRegistry) {
    return typeRegistrySerializationRegistry
  }
  const registry = new TypeRegistry()
  typeRegistrySerializationRegistry = registry
  
  const memberAnnotationsListType = TypeDescription.create({ 
    name: 'vector<shared_ptr<member_annotation>, allocator<shared_ptr<member_annotation>>>', 
    kind: TypeKind.Array, item: registry.getTypeByName('pointer')
  })
  const memberEntryType = TypeDescription.create({ 
    name: 'member', kind: TypeKind.Object, members: [
      { name: 'name', type: registry.getTypeByName('string'), annotations: [] },
      { name: 'type', type: registry.getTypeByName('pointer'), annotations: [] },
      { name: 'annotations', type: memberAnnotationsListType, annotations: [] }
    ] 
  })
  const membersType = TypeDescription.create({ 
    name: 'vector<member, allocator<member>>',
    kind: TypeKind.Array, item: memberEntryType
  })

  const enumMemberEntryType = TypeDescription.create({ 
    name: 'enum_member', kind: TypeKind.Object, members: [
      { name: 'name', type: registry.getTypeByName('string'), annotations: [] },
      { name: 'value', type: registry.getTypeByName('uint'), annotations: [] }
    ] 
  })
  const enumMembersType = TypeDescription.create({ 
    name: 'vector<enum_member>',
    kind: TypeKind.Array, item: enumMemberEntryType 
  })
  const typeDescriptionListType = TypeDescription.create({ 
    name: 'vector<shared_ptr<type_description>, allocator<shared_ptr<type_description>>>', 
    kind: TypeKind.Array, item: registry.getTypeByName('pointer')
  })
  const typeAnnotationsListType = TypeDescription.create({ 
    name: 'vector<shared_ptr<type_annotation>, allocator<shared_ptr<type_annotation>>>', 
    kind: TypeKind.Array, item: registry.getTypeByName('pointer')
  })
  const typeDescriptionType = TypeDescription.create({ 
    name: 'type_description', kind: TypeKind.DynamicObject, members: [
      { name: 'name', type: registry.getTypeByName('string'), annotations: [] },
      { name: 'kind', type: registry.getTypeByName('uint'), annotations: [] },
      { name: 'members', type: membersType, annotations: [] },
      { name: 'item', type: registry.getTypeByName('pointer'), annotations: [] },
      { name: 'key', type: registry.getTypeByName('pointer'), annotations: [] },
      { name: 'enumMembers', type: enumMembersType, annotations: [] },
      { name: 'bases', type: typeDescriptionListType, annotations: [] },
      { name: 'annotations', type: typeAnnotationsListType, annotations: [] }
    ] 
  })  
  const typeRegistryType = TypeDescription.create({ 
    name: 'type_registry', kind: TypeKind.Object, members: [
      { name: '_types', type: typeDescriptionListType, annotations: [] }
    ]
  })
  registry.registerType(typeRegistryType)
  registry.registerType(typeDescriptionListType)
  registry.registerType(typeDescriptionType)
  registry.registerType(membersType)
  registry.registerType(memberEntryType)  
  registry.registerType(memberAnnotationsListType)
  registry.registerType(enumMembersType)
  registry.registerType(enumMemberEntryType)
  registry.registerType(typeAnnotationsListType)

  const memberAnnotationType = TypeDescription.create({ 
    name: 'member_annotation', kind: TypeKind.DynamicObject, members: [] 
  })
  const readAnnotationType = TypeDescription.create({ 
    name: 'read_annotation', kind: TypeKind.DynamicObject, members: [],
    bases: [memberAnnotationType]
  })
  registry.registerType(readAnnotationType)
  registry.registerType(memberAnnotationType)
  return registry

}