/**
 * Encoding of *data* described by a TypeRegistry (messages, rows, index keys).
 * The TypeRegistry blob body itself is always compressed; see registrySerialization.
 * Values match C++ serialization::serialization_format.
 */
export enum SerializationFormat {
  Compressed = 0,
  Flat = 1,
  Key = 2,
}

export const SERIALIZATION_FORMAT_ENVELOPE = 0x80
export const SERIALIZATION_FORMAT_RESERVED_MASK = 0x70
export const SERIALIZATION_FORMAT_VALUE_MASK = 0x0f

export function packSerializationFormatEnvelope(format: SerializationFormat): number {
  if (format < 0 || format > SerializationFormat.Key) {
    throw new Error(`serialization_format: unknown format value ${format}`)
  }
  return SERIALIZATION_FORMAT_ENVELOPE | format
}

/**
 * @returns format if byte is a v1 envelope; null if legacy (no envelope).
 */
export function tryUnpackSerializationFormatEnvelope(byte: number): SerializationFormat | null {
  const b = byte & 0xff
  if ((b & SERIALIZATION_FORMAT_ENVELOPE) === 0) {
    return null
  }
  if ((b & SERIALIZATION_FORMAT_RESERVED_MASK) !== 0) {
    throw new Error('serialization_format: reserved envelope bits must be 0')
  }
  const v = b & SERIALIZATION_FORMAT_VALUE_MASK
  if (v > SerializationFormat.Key) {
    throw new Error('serialization_format: unknown format nibble')
  }
  return v as SerializationFormat
}
