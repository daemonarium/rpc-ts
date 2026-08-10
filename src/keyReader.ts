import { CodecRegistry } from './codec.js'
import { Reader } from './reader.js'
import type { IReader, ReadLater } from './writerTypes.js'

export interface KeyBlobParts {
  data: Uint8Array
  meta: Uint8Array
  metaSize: number
}

export function parseKeyBlob(source: ArrayBufferLike | ArrayBufferView): KeyBlobParts {
  let bytes: Uint8Array
  if (source instanceof ArrayBuffer) {
    bytes = new Uint8Array(source)
  } else if (ArrayBuffer.isView(source)) {
    bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  } else {
    throw new Error('Unsupported buffer type')
  }
  if (bytes.length < 1) {
    throw new Error('key format: blob too small')
  }
  const metaSize = bytes[bytes.length - 1]
  if (metaSize + 1 > bytes.length) {
    throw new Error('key format: meta_size out of range')
  }
  const dataSize = bytes.length - 1 - metaSize
  return {
    data: bytes.subarray(0, dataSize),
    meta: bytes.subarray(dataSize, bytes.length - 1),
    metaSize,
  }
}

/**
 * Key format reader over a finished [data][meta][u8 meta_size] blob.
 */
export class KeyReader implements IReader {
  private readonly dataReader: Reader
  private readonly metaReader: Reader
  private readonly textDecoder = new TextDecoder()

  constructor(source: ArrayBufferLike | ArrayBufferView, codecs: CodecRegistry) {
    const parts = parseKeyBlob(source)
    this.dataReader = new Reader(parts.data, codecs)
    this.metaReader = new Reader(parts.meta, codecs)
  }

  isIndexed(): boolean {
    return false
  }

  deferredPointerUsesTypeIndex(): boolean {
    return false
  }

  enterFrame(): void {}

  exitFrame(): void {}

  saveOffset(): void {}

  readRest(): void {}

  readU64(): number | bigint {
    return this.dataReader.readU64()
  }

  readI64(): number | bigint {
    return this.dataReader.readI64()
  }

  readU32(): number {
    return this.dataReader.readU32()
  }

  readI32(): number {
    return this.dataReader.readI32()
  }

  readU16(): number {
    return this.dataReader.readU16()
  }

  readI16(): number {
    return this.dataReader.readI16()
  }

  readU8(): number {
    return this.dataReader.readU8()
  }

  readI8(): number {
    return this.dataReader.readI8()
  }

  readF32(): number {
    return this.dataReader.readF32()
  }

  readF64(): number {
    return this.dataReader.readF64()
  }

  readBool(): boolean {
    return this.dataReader.readBool()
  }

  readLength(): number {
    return this.metaReader.readLength()
  }

  readString(): string {
    const length = this.readLength()
    if (length === 0) return ''
    try {
      return this.textDecoder.decode(this.dataReader.readRawBytes(length))
    } catch {
      throw new Error('key format: short string/binary read')
    }
  }

  readBinary(): Uint8Array {
    const length = this.readLength()
    if (length === 0) return new Uint8Array(0)
    try {
      return this.dataReader.readRawBytes(length)
    } catch {
      throw new Error('key format: short string/binary read')
    }
  }

  readTyped<T>(_output: (value: T) => void): void {
    throw new Error('key format: readTyped not supported')
  }

  readPointer<T>(_assign: (value: T) => void, _readLater: ReadLater): void {
    throw new Error('key format: pointer not supported')
  }

  readMap(
    _readKey: (r: IReader, assign: (key: unknown) => void) => void,
    _readVal: (r: IReader, assign: (val: unknown) => void) => void
  ): Array<[unknown, unknown]> {
    throw new Error('key format: map not supported')
  }
}
