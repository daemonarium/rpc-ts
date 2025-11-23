import type { CodecRegistry, TypedValue } from './codec.js'
import { TypeKind, type TypeDescription, TypeRegistry } from './typeDescription.js'
import { deserializeValueByType, serializeValueByType } from './valueSerialization.js'

export const registerRuntimeCodecs = (codecs: CodecRegistry, registry: TypeRegistry): void => {
  for (const type of registry.getTypes()) {
    maybeRegisterTypeCodec(codecs, registry, type)
  }
}

const maybeRegisterTypeCodec = (codecs: CodecRegistry, registry: TypeRegistry, type: TypeDescription): void => {
  if (type.kind !== TypeKind.Object) {
    return
  }
  if (codecs.has(type.name)) {
    return
  }
  codecs.register({
    name: type.name,
    serialize: (writer, value) => {
      const typed = value as TypedValue
      if (!typed || typed._type !== type.name) {
        throw new Error(`Value does not match type ${type.name}`)
      }
      serializeValueByType(writer, registry, type, typed)
    },
    deserialize: reader => deserializeValueByType(reader, registry, type) as TypedValue
  })
}

