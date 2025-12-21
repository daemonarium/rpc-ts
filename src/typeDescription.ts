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
  annotations: TypedValue[]
}

export interface EnumMember {
  name: string
  value: number
}

export interface TypeDescriptionParameters {
  name: string
  kind: TypeKind
  members?: TypeMember[]
  annotations?: TypedValue[]
  enumMembers?: EnumMember[]
  bases?: TypeDescription[]
  item?: TypeDescription
  key?: TypeDescription
}


export class TypeDescription implements TypedValue {
  _type = 'type_description'
  name = ''
  kind: TypeKind = TypeKind.Void
  members: TypeMember[] = []
  enumMembers: EnumMember[] = []
  bases: TypeDescription[] = []
  item?: TypeDescription
  key?: TypeDescription
  annotations: TypedValue[] = []
  hash?: number
  [key: string]: unknown

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
      hash = mixHash(hash, Number(enumMember.value & 0xFFFFFFFF))
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
    { name, kind, members = [], enumMembers = [], bases = [], item = undefined, key = undefined, annotations = [] }: TypeDescriptionParameters): TypeDescription {
    const type = new TypeDescription()
    type.name = name
    type.kind = kind
    type.members = members
    type.enumMembers = enumMembers
    type.bases = bases
    type.item = item
    type.key = key
    type.annotations = annotations
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

  constructor(types: TypeDescription[] = undefined) {
    if(types) {
      this.types = types
      for (const type of types) {
        this.typesByName.set(type.name, type)
      }
      return
    }
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

}

