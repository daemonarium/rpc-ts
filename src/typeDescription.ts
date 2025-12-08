import { CodecRegistry, type TypedValue } from './codec.js'
import type { Reader } from './reader.js'
import type { Writer } from './writer.js'

export enum TypeKind {
  Void = 0,
  UnsignedInteger = 1,
  SignedInteger = 2,
  FloatingPoint = 3,
  Boolean = 4,
  String = 5,
  Binary = 6,
  Enum = 7,
  Array = 8,
  Object = 9,
  DynamicObject = 10,
  Pointer = 11,
  Map = 12,
  Function = 16,
  Method = 17
}

export interface TypeMember {
  name: string
  type: TypeDescription
}

export interface EnumMember {
  name: string
  value: bigint
}

export interface TypeDescriptionParameters {
  name: string
  kind: TypeKind
  members?: TypeMember[]
  enumMembers?: EnumMember[]
  bases?: TypeDescription[]
  item?: TypeDescription
  key?: TypeDescription
}

export class TypeDescription {
  _type = 'type_description'
  name = ''
  kind: TypeKind = TypeKind.Void
  members: TypeMember[] = []
  enumMembers: EnumMember[] = []
  bases: TypeDescription[] = []
  item?: TypeDescription
  key?: TypeDescription
  hash?: number

  serialize(writer: Writer): void {
    writeString(writer, this.name)
    writer.writeU64(BigInt(this.kind))
    writer.saveOffset()
    if (this.kind === TypeKind.Object) {
      writeMembers(writer, this.members)
      writePointerVector(writer, this.bases)
    }
    if (this.kind === TypeKind.Array) {
      writePointer(writer, this.item)
    }
    if (this.kind === TypeKind.Map) {
      writePointer(writer, this.key)
      writePointer(writer, this.item)
    }
    if (this.kind === TypeKind.Enum) {
      writeEnumMembers(writer, this.enumMembers)
    }
    if (this.kind === TypeKind.Function || this.kind === TypeKind.Method) {
      writeMembers(writer, this.members)
      writePointer(writer, this.item)
    }
  }

  static deserialize(reader: Reader): TypeDescription {
    const type = new TypeDescription()
    type.name = reader.readString()
    type.kind = Number(reader.readU64()) as TypeKind
    switch (type.kind) {
      case TypeKind.Object:
        type.members = readMembers(reader)
        type.bases = readPointerVector(reader)
        break
      case TypeKind.Array:
        assignPointer(reader, value => {
          type.item = value
        })
        break
      case TypeKind.Map:
        assignPointer(reader, value => {
          type.key = value
        })
        assignPointer(reader, value => {
          type.item = value
        })
        break
      case TypeKind.Enum:
        type.enumMembers = readEnumMembers(reader)
        break
      case TypeKind.Function:
      case TypeKind.Method:
        type.members = readMembers(reader)
        assignPointer(reader, value => {
          type.item = value
        })
        break
      default:
        break
    }
    return type
  }

  computeHash(): number {
    let hash = 0x9747b28c >>> 0
    hash = mixHash(hash, this.kind)
    for (const member of this.members) {
      for (const char of member.name) {
        hash = mixHash(hash, char.charCodeAt(0))
      }
      hash = mixHash(hash, member.type.computeHashIfNeeded())
    }
    if (this.item) {
      hash = mixHash(hash, this.item.computeHashIfNeeded())
    }
    if (this.key) {
      hash = mixHash(hash, this.key.computeHashIfNeeded())
    }
    if (this.enumMembers.length > 0) {
      hash = mixHash(hash, this.enumMembers.length)
    }
    for (const enumMember of this.enumMembers) {
      for (const char of enumMember.name) {
        hash = mixHash(hash, char.charCodeAt(0))
      }
      hash = mixHash(hash, Number(enumMember.value & 0xFFFFFFFFn))
    }
    this.hash = hash >>> 0
    return this.hash
  }

  computeHashIfNeeded(): number {
    if (this.hash === undefined) {
      return this.computeHash()
    }
    return this.hash
  }

  static create(
    { name, kind, members = [], enumMembers = [], bases = [], item = undefined, key = undefined }: TypeDescriptionParameters): TypeDescription {
    const type = new TypeDescription()
    type.name = name
    type.kind = kind
    type.members = members
    type.enumMembers = enumMembers
    type.bases = bases
    type.item = item
    type.key = key
    return type
  }
}

const mixHash = (hash: number, value: number | TypeKind): number => {
  let k = Number(value) >>> 0
  k = Math.imul(k, 0xcc9e2d51) >>> 0
  k = (k << 15) | (k >>> 17)
  k = Math.imul(k, 0x1b873593) >>> 0
  hash ^= k
  hash = ((hash << 13) | (hash >>> 19)) >>> 0
  hash = (Math.imul(hash, 5) + 0xe6546b64) >>> 0
  return hash >>> 0
}

const writeString = (writer: Writer, value: string): void => {
  writer.writeString(value)
  writer.saveOffset()
}

const writeMembers = (writer: Writer, members: TypeMember[]): void => {
  writer.beginFrame()
  writer.writeLength(members.length)
  for (const member of members) {
    writer.beginFrame()
    writeString(writer, member.name)
    writePointer(writer, member.type)
    writer.endFrame()
    writer.saveOffset()
  }
  writer.endFrame()
  writer.saveOffset()
}

const writeEnumMembers = (writer: Writer, members: EnumMember[]): void => {
  writer.beginFrame()
  writer.writeLength(members.length)
  for (const member of members) {
    writer.beginFrame()
    writeString(writer, member.name)
    writer.writeU64(member.value)
    writer.endFrame()
    writer.saveOffset()
  }
  writer.endFrame()
  writer.saveOffset()
}

const writePointerVector = (writer: Writer, values: TypeDescription[]): void => {
  writer.beginFrame()
  writer.writeLength(values.length)
  for (const value of values) {
    writePointer(writer, value)
  }
  writer.endFrame()
  writer.saveOffset()
}

const writePointer = (writer: Writer, value?: TypeDescription): void => {
  if (!value) {
    throw new Error('Pointer value missing during serialization')
  }
  const typed = value as unknown as TypedValue
  writer.writePointer(typed, () => writer.writeTyped(typed))
}

const readMembers = (reader: Reader): TypeMember[] => {
  reader.enterFrame()
  const length = reader.readLength()
  const members: TypeMember[] = new Array(length)
  for (let i = 0; i < length; ++i) {
    reader.enterFrame()
    const name = reader.readString()
    const member: TypeMember = { name, type: undefined as unknown as TypeDescription }
    assignPointer(reader, value => {
      member.type = value
    })
    reader.exitFrame()
    members[i] = member
  }
  reader.exitFrame()
  return members
}

const readEnumMembers = (reader: Reader): EnumMember[] => {
  reader.enterFrame()
  const length = reader.readLength()
  const members: EnumMember[] = []
  for (let i = 0; i < length; ++i) {
    reader.enterFrame()
    const name = reader.readString()
    const value = reader.readU64()
    reader.exitFrame()
    members.push({ name, value })
  }
  reader.exitFrame()
  return members
}

const readPointerVector = (reader: Reader): TypeDescription[] => {
  reader.enterFrame()
  const length = reader.readLength()
  const result: TypeDescription[] = new Array(length)
  for (let i = 0; i < length; ++i) {
    assignPointer(reader, value => {
      result[i] = value
    })
  }
  reader.exitFrame()
  return result
}

const assignPointer = (reader: Reader, setter: (value: TypeDescription) => void): void => {
  reader.readPointer<TypeDescription>(
    value => {
      setter(value)
    },
    () => reader.readTyped<TypeDescription>()
  )
}

const BUILTIN_TYPES: Array<{ name: string, kind: TypeKind }> = [
  { name: 'void', kind: TypeKind.Void },
  { name: 'uint', kind: TypeKind.UnsignedInteger },
  { name: 'sint', kind: TypeKind.SignedInteger },
  { name: 'float', kind: TypeKind.FloatingPoint },
  { name: 'bool', kind: TypeKind.Boolean },
  { name: 'string', kind: TypeKind.String },
  { name: 'binary', kind: TypeKind.Binary },
  { name: 'pointer', kind: TypeKind.Pointer },
  { name: 'map', kind: TypeKind.Map }
]

export class TypeRegistry {
  private types: TypeDescription[] = []
  private readonly typesByName = new Map<string, TypeDescription>()

  constructor() {
    for (const def of BUILTIN_TYPES) {
      const type = new TypeDescription()
      type.name = def.name
      type.kind = def.kind
      this.types.push(type)
      this.typesByName.set(type.name, type)
    }
  }

  registerType(type: TypeDescription): number {
    const index = this.types.length
    this.types.push(type)
    this.typesByName.set(type.name, type)
    return index
  }

  getType(index: number): TypeDescription {
    const type = this.types[index]
    if (!type) {
      throw new Error(`Type at index ${index} not found`)
    }
    return type
  }

  getTypeByName(name: string): TypeDescription | undefined {
    return this.typesByName.get(name)
  }

  getTypes(): TypeDescription[] {
    return this.types
  }

  serialize(writer: Writer): void {
    const extra = this.types.length - BUILTIN_TYPES.length
    writer.writeLength(extra)
    for (let i = BUILTIN_TYPES.length; i < this.types.length; ++i) {
      this.types[i].serialize(writer)
    }
  }

  static deserialize(reader: Reader): TypeRegistry {
    const registry = new TypeRegistry()
    const count = reader.readLength()
    for (let i = 0; i < count; ++i) {
      const type = TypeDescription.deserialize(reader)
      registry.registerType(type)
    }
    reader.readRest()
    return registry
  }
}

export function typeRegistrySerializationRegistry(): TypeRegistry {
  const registry = new TypeRegistry()
  
  const memberAnnotationsListType = TypeDescription.create({ 
    name: 'vector<shared_ptr<member_annotation>, allocator<shared_ptr<member_annotation>>>', 
    kind: TypeKind.Array, item: registry.getTypeByName('pointer')
  })
  const memberEntryType = TypeDescription.create({ 
    name: 'member', kind: TypeKind.Object, members: [
      { name: 'name', type: registry.getTypeByName('string') },
      { name: 'type', type: registry.getTypeByName('pointer') },
      { name: 'annotations', type: memberAnnotationsListType }
    ] 
  })
  const membersType = TypeDescription.create({ 
    name: 'vector<member, allocator<member>>',
    kind: TypeKind.Array, item: memberEntryType
  })

  const enumMemberEntryType = TypeDescription.create({ 
    name: 'pair<basic_string<char, char_traits<char>, allocator<char>>, unsigned long>', kind: TypeKind.Object, members: [
      { name: 'first', type: registry.getTypeByName('string') },
      { name: 'second', type: registry.getTypeByName('uint') }
    ] 
  })
  const enumMembersType = TypeDescription.create({ 
    name: 'vector<pair<basic_string<char, char_traits<char>, allocator<char>>, uint64_t>, allocator<pair<basic_string<char, char_traits<char>, allocator<char>>, uint64_t>>>',
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
      { name: 'name', type: registry.getTypeByName('string') },
      { name: 'kind', type: registry.getTypeByName('uint') },
      { name: 'members', type: membersType },
      { name: 'item', type: registry.getTypeByName('pointer') },
      { name: 'key', type: registry.getTypeByName('pointer') },
      { name: 'enumMembers', type: enumMembersType },
      { name: 'bases', type: typeDescriptionListType },
      { name: 'annotations', type: typeAnnotationsListType }
    ] 
  })  
  const typeRegistryType = TypeDescription.create({ 
    name: 'type_registry', kind: TypeKind.Object, members: [
      { name: '_types', type: typeDescriptionListType }
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

export const registerTypeDescriptionCodec = (codecs: CodecRegistry): void => {
  codecs.register<TypeDescription>({
    name: 'type_description',
    serialize: (writer, value) => value.serialize(writer),
    deserialize: reader => TypeDescription.deserialize(reader)
  })
}

