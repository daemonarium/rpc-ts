export type WriteLater = () => void
export type ReadLater = (output: (value: unknown) => void) => void

/** Minimal typed-value shape required by writeTyped (full TypedValue lives in codec.ts). */
export interface TypedWriteValue {
  _type: string
  [key: string]: unknown
}

/**
 * Common writer contract used by valueSerialization and codecs.
 * Compressed: varint scalars, no-op frames, interleaved maps.
 * Flat: fixed LE scalars, real trailers, SoA maps.
 * Key: compressed scalars split into data/meta ([data][meta][meta_size]);
 * map/pointer/typed throw.
 */
export interface IWriter {
  beginFrame(): void
  endFrame(): void
  saveOffset(): void
  writeU64(value: bigint | number): void
  writeI64(value: bigint | number): void
  writeU32(value: number): void
  writeI32(value: number): void
  writeU16(value: number): void
  writeI16(value: number): void
  writeU8(value: number): void
  writeI8(value: number): void
  writeF32(value: number): void
  writeF64(value: number): void
  writeBool(value: boolean): void
  writeString(value: string): void
  writeBinary(value: ArrayBufferView | ArrayBuffer): void
  writeLength(length: number): void
  writeTyped(value: TypedWriteValue): void
  writePointer(value: unknown, writeLater: WriteLater): void
  writeRest(): void
  /**
   * When true (compressed), deferred pointer bodies use writeTyped (type index on wire).
   * When false (flat), deferred bodies are homogeneous serialize without type index.
   */
  deferredPointerUsesTypeIndex(): boolean
  writeMap(
    entries: ReadonlyArray<[unknown, unknown]>,
    writeKey: (w: IWriter, key: unknown) => void,
    writeVal: (w: IWriter, val: unknown) => void
  ): void
}

/**
 * Common reader contract used by valueSerialization and codecs.
 * saveOffset is a no-op on compressed readers; flat readers use it to
 * count checkpoints for trailer skip on exitFrame.
 */
export interface IReader {
  isIndexed(): boolean
  enterFrame(): void
  exitFrame(): void
  saveOffset(): void
  readU64(): number | bigint
  readI64(): number | bigint
  readU32(): number
  readI32(): number
  readU16(): number
  readI16(): number
  readU8(): number
  readI8(): number
  readF32(): number
  readF64(): number
  readBool(): boolean
  readString(): string
  readBinary(): Uint8Array
  readLength(): number
  readTyped<T>(output: (value: T) => void): void
  readPointer<T>(assign: (value: T) => void, readLater: ReadLater): void
  readRest(): void
  /**
   * Mirror of IWriter.deferredPointerUsesTypeIndex for deserialize path.
   */
  deferredPointerUsesTypeIndex(): boolean
  readMap(
    readKey: (r: IReader, assign: (key: unknown) => void) => void,
    readVal: (r: IReader, assign: (val: unknown) => void) => void
  ): Array<[unknown, unknown]>
}
