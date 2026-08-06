import type { Reader } from './reader.js'
import type { Writer } from './writer.js'
import type { TypedValue } from './codec.js'
import { TypeKind, type TypeDescription, type TypeMember, TypeRegistry } from './typeDescription.js'
import { CodecRegistry } from './codec.js'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }
  | Uint8Array
  | Map<JsonValue, JsonValue>
  | bigint
  | TypedValue

export const serializeTypedJson = (writer: Writer, registry: TypeRegistry, value: TypedValue): void => {
  const type = registry.getTypeByName(value._type)
  if (!type) {
    throw new Error(`Type ${value._type} not found in registry`)
  }
  serializeValueByType(writer, registry, type, value)
}

export const deserializeTypedJson = (reader: Reader, registry: TypeRegistry, typeName: string): TypedValue => {
  const type = registry.getTypeByName(typeName)
  if (!type) {
    throw new Error(`Type ${typeName} not found in registry`)
  }
  let result
  deserializeValueByType(reader, registry, type, (value) => result = value)
  reader.readRest()
  return result
}

export const serializeValueByType = (writer: Writer, registry: TypeRegistry, type: TypeDescription, value: JsonValue): void => {
  switch (type.kind) {
    case TypeKind.UnsignedInteger8:
      writer.writeU8(Number(toNumber(value, false)) & 0xff)
      break
    case TypeKind.SignedInteger8:
      writer.writeI8(toNumber(value, true) << 24 >> 24)
      break
    case TypeKind.UnsignedInteger16:
      writer.writeU16(Number(toNumber(value, false)) & 0xffff)
      break
    case TypeKind.SignedInteger16:
      writer.writeI16(toNumber(value, true) << 16 >> 16)
      break
    case TypeKind.UnsignedInteger32:
      writer.writeU32(Number(toNumber(value, false)) >>> 0)
      break
    case TypeKind.SignedInteger32:
      writer.writeI32(toNumber(value, true) | 0)
      break
    case TypeKind.UnsignedInteger64:
      writer.writeU64(toBigInt(value, false))
      break
    case TypeKind.SignedInteger64:
      writer.writeI64(toBigInt(value, true))
      break
    case TypeKind.FloatingPoint32:
      writer.writeF32(assertNumber(value))
      break
    case TypeKind.FloatingPoint64:
      writer.writeF64(assertNumber(value))
      break
    case TypeKind.Boolean:
      writer.writeBool(Boolean(value))
      break
    case TypeKind.String:
      writer.writeString(assertString(value))
      writer.saveOffset()
      break
    case TypeKind.Binary:
      writer.writeBinary(toUint8Array(value))
      writer.saveOffset()
      break
    case TypeKind.Enum:
      writer.writeU64(resolveEnumValue(type, value))
      break
    case TypeKind.Array:
      writer.beginFrame()
      {
        const list = Array.isArray(value) ? value : []
        writer.writeLength(list.length)
        for (const element of list) {
          serializeValueByType(writer, registry, ensureType(type.item), element)
        }
      }
      writer.endFrame()
      writer.saveOffset()
      break
    case TypeKind.Map:
      writer.beginFrame()
      {
        const entries = extractEntries(value)
        writer.writeLength(entries.length)
        for (const [keyValue, entryValue] of entries) {
          serializeValueByType(writer, registry, ensureType(type.key), keyValue)
          serializeValueByType(writer, registry, ensureType(type.item), entryValue)
        }
      }
      writer.endFrame()
      writer.saveOffset()
      break
    case TypeKind.Object:      
      serializeObject(writer, registry, type, value as Record<string, JsonValue>)
      break
    case TypeKind.DynamicObject:
      serializeObject(writer, registry, type, value as Record<string, JsonValue>)
      break
    case TypeKind.Message:
      serializeObject(writer, registry, type, value as Record<string, JsonValue>)
      break
    case TypeKind.Exception:
      serializeObject(writer, registry, type, value as Record<string, JsonValue>)
      break
    case TypeKind.Pointer: {
      if (value === null || value === undefined) {
        writer.writePointer(null, () => {})
        break
      }
      const typed = value as TypedValue
      if (!typed || typeof typed._type !== 'string') {
        throw new Error('Pointer value must provide _type')
      }
      writer.writePointer(typed, () => writer.writeTyped(typed))
      break
    }
    default:
      throw new Error(`Unsupported serialization for TypeKind ${type.kind}`)
  }
}

const serializeObject = (writer: Writer, registry: TypeRegistry, type: TypeDescription, value: Record<string, JsonValue>): void => {
  const typed = value as Partial<TypedValue>
  if (typed._type && typed._type !== type.name) {
    throw new Error(`Expected value of type ${type.name}, got ${String(typed._type)}`)
  }
  writer.beginFrame()
  for (const member of flattenMembers(type)) {
    if (!(member.name in value)) {
      throw new Error(`Missing property ${member.name} for type ${type.name}`)
    }
    serializeValueByType(writer, registry, member.type, value[member.name])
  }
  writer.endFrame()
  writer.saveOffset()
}

export const deserializeValueByType = (reader: Reader, registry: TypeRegistry, type: TypeDescription, output: (value: JsonValue) => void): void => {
  switch (type.kind) {
    case TypeKind.UnsignedInteger8:
      return output(reader.readU8())
    case TypeKind.SignedInteger8:
      return output(reader.readI8())
    case TypeKind.UnsignedInteger16:
      return output(reader.readU16())
    case TypeKind.SignedInteger16:
      return output(reader.readI16())
    case TypeKind.UnsignedInteger32:
      return output(reader.readU32())
    case TypeKind.SignedInteger32:
      return output(reader.readI32())
    case TypeKind.UnsignedInteger64:
      return output(reader.readU64())
    case TypeKind.SignedInteger64:
      return output(reader.readI64())
    case TypeKind.FloatingPoint32:
      return output(reader.readF32())
    case TypeKind.FloatingPoint64:
      return output(reader.readF64())
    case TypeKind.Boolean:
      return output(reader.readBool())
    case TypeKind.String:
      return output(reader.readString())
    case TypeKind.Binary:
      return output(reader.readBinary())
    case TypeKind.Enum:
      return output(resolveEnumValue(type, reader.readU64()))
    case TypeKind.Array:
      reader.enterFrame()
      {
        const length = reader.readLength()
        const result: JsonValue[] = new Array(length)
        for (let i = 0; i < length; ++i) {
          deserializeValueByType(reader, registry, ensureType(type.item), (value) => result[i] = value)
        }
        reader.exitFrame()
        return output(result)
      }
    case TypeKind.Map:
      reader.enterFrame()
      {
        const length = reader.readLength()
        const entries: Array<[JsonValue, JsonValue]> = new Array(length)
        const keyType = ensureType(type.key)
        const itemType = ensureType(type.item)
        for (let i = 0; i < length; ++i) {
          entries[i] = [undefined, undefined]
          const key = deserializeValueByType(reader, registry, keyType, (value) => entries[i][0] = value)
          const val = deserializeValueByType(reader, registry, itemType, (value) => entries[i][1] = value)          
        }
        reader.exitFrame()
        if (keyType.kind === TypeKind.String) {
          const object: Record<string, JsonValue> = {}
          for (const [k, v] of entries) {
            object[String(k)] = v
          }
          return
        }
        output(new Map(entries))
        return
      }
    case TypeKind.Object:
      reader.enterFrame()
      {
        const result: Record<string, JsonValue> = { _type: type.name }
        for (const member of flattenMembers(type)) {
          result[member.name] = undefined
          deserializeValueByType(reader, registry, member.type, (value) => result[member.name] = value)
        }
        reader.exitFrame()
        output(result as TypedValue)
        return
      }
    case TypeKind.Exception:
      reader.enterFrame()
      {
        const result: Record<string, JsonValue> = { _type: type.name }
        for (const member of flattenMembers(type)) {
          deserializeValueByType(reader, registry, member.type, (value) => {
            result[member.name] = value
          })
        }
        reader.exitFrame()
        output(result as TypedValue)
        return
      }
    case TypeKind.DynamicObject:
      reader.enterFrame()
      {
        const result: Record<string, JsonValue> = { _type: type.name }
        for (const member of flattenMembers(type)) {
          result[member.name] = undefined
          deserializeValueByType(reader, registry, member.type, (value) => result[member.name] = value)
        }
        reader.exitFrame()
        output(result as TypedValue)
        return
      }
    case TypeKind.Message:
      reader.enterFrame()
      {
        const result: Record<string, JsonValue> = { _type: type.name }
        for (const member of flattenMembers(type)) {
          result[member.name] = undefined
          deserializeValueByType(reader, registry, member.type, (value) => result[member.name] = value)
        }
        reader.exitFrame()
        output(result as TypedValue)
        return
      }
    case TypeKind.Pointer: {
      const placeholder: Record<string, unknown> = {}
      reader.readPointer(
        (value) => output(value as TypedValue),
        (output) => reader.readTyped(output)
      )
      return
    }
    default:
      throw new Error(`Unsupported deserialization for TypeKind ${type.kind}`)
  }
}

const flattenMembers = (type: TypeDescription): TypeMember[] => {
  const members: TypeMember[] = []
  for (const base of type.bases) {
    members.push(...flattenMembers(base))
  }
  members.push(...type.members)
  return members
}

const toBigInt = (value: JsonValue, allowNegative: boolean): bigint => {
  if (typeof value === 'bigint') {
    if (!allowNegative && value < 0n) {
      throw new Error('Value must be non-negative')
    }
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (!allowNegative && value < 0) {
      throw new Error('Value must be non-negative')
    }
    return BigInt(Math.trunc(value))
  }
  throw new Error(`Expected numeric value, got ${String(value)}`)
}

const toNumber = (value: JsonValue, allowNegative: boolean): number => {
  if (typeof value === 'number') {
    if (!allowNegative && value < 0) {
      throw new Error('Value must be non-negative')
    }
    return value
  }
  if (typeof value === 'bigint') {
    if (!allowNegative && value < 0n) {
      throw new Error('Value must be non-negative')
    }
    return Number(value)
  }
  return Number(toBigInt(value, allowNegative))
}

const assertNumber = (value: JsonValue): number => {
  if (typeof value !== 'number') {
    throw new Error(`Expected number, got ${String(value)}`)
  }
  return value
}

const assertString = (value: JsonValue): string => {
  if (typeof value !== 'string') {
    throw new Error(`Expected string, got ${String(value)}`)
  }
  return value
}

const toUint8Array = (value: JsonValue): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value)) return Uint8Array.from(value)
  throw new Error('Binary value must be Uint8Array, ArrayBuffer or number[]')
}

const resolveEnumValue = (type: TypeDescription, value: JsonValue): number => {
  if (typeof value === 'string') {
    const match = type.enumMembers.find(member => member.name === value)
    if (!match) throw new Error(`Enum ${type.name} missing member ${value}`)
    return match.value
  }
  return toNumber(value, true)
}

const resolveEnumName = (type: TypeDescription, raw: number | bigint): JsonValue => {
  const match = type.enumMembers.find(member => member.value === Number(raw))
  return match ? match.name : raw
}

const ensureType = (type?: TypeDescription): TypeDescription => {
  if (!type) throw new Error('Type description missing referenced type')
  return type
}

const extractEntries = (value: JsonValue): Array<[JsonValue, JsonValue]> => {
  if (value instanceof Map) {
    return Array.from(value.entries()) as Array<[JsonValue, JsonValue]>
  }
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  ) {
    return Object.entries(value as Record<string, JsonValue>)
  }
  return []
}

export function registerDynamicCodecs(codecs: CodecRegistry, registry: TypeRegistry): void {
  for(const type of registry.getTypes()) {
    if(type.kind === TypeKind.DynamicObject) {
      codecs.typed.register({
        name: type.name,
        serialize: (writer, value) => serializeValueByType(writer, registry, type, value as JsonValue),
        deserialize: (reader, output) => deserializeValueByType(reader, registry, type, output),
      })
    }
  }
}

export function registerMessageCodecs(codecs: CodecRegistry, registry: TypeRegistry): void {
  for(const type of registry.getTypes()) {
    if(type.kind === TypeKind.Message) {
      codecs.messages.register({
        name: type.name,
        serialize: (writer, value) => serializeValueByType(writer, registry, type, value as JsonValue),
        deserialize: (reader, output) => deserializeValueByType(reader, registry, type, output),
      })
    }
  }
}

export function registerAllRuntimeCodecs(codecs: CodecRegistry, registry: TypeRegistry): void {
  registerDynamicCodecs(codecs, registry)
  registerMessageCodecs(codecs, registry)
}