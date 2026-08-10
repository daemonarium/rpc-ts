import { CodecRegistry } from './codec.js'
import {
  GrowableByteBuffer,
  encodeI8,
  encodeSVarInt,
  encodeSortableF32,
  encodeSortableF64,
  encodeUVarInt,
  toUnsigned,
} from './compressedEncoding.js'
import type { IWriter, TypedWriteValue, WriteLater } from './writerTypes.js'

/**
 * Key format writer: [data][meta][u8 meta_size].
 * Scalars → data (compressed encodings); lengths → meta.
 */
export class KeyWriter implements IWriter {
  private readonly data: GrowableByteBuffer
  private readonly meta: GrowableByteBuffer
  private readonly textEncoder = new TextEncoder()
  private readonly scratch = new ArrayBuffer(8)
  private readonly scratchView = new DataView(this.scratch)
  private finished = false

  constructor(_codecs: CodecRegistry, initialCapacity = 64) {
    this.data = new GrowableByteBuffer(initialCapacity)
    this.meta = new GrowableByteBuffer(Math.min(initialCapacity, 64))
  }

  beginFrame(): void {}

  endFrame(): void {}

  saveOffset(): void {}

  writeRest(): void {}

  deferredPointerUsesTypeIndex(): boolean {
    return false
  }

  writeU64(value: bigint | number): void {
    this.ensureWritable()
    encodeUVarInt(this.data, toUnsigned(value))
  }

  writeI64(value: bigint | number): void {
    this.ensureWritable()
    encodeSVarInt(this.data, BigInt(value))
  }

  writeU32(value: number): void {
    this.ensureWritable()
    if (value < 0 || value > 0xFFFFFFFF) throw new Error('u32 out of range')
    encodeUVarInt(this.data, value >>> 0)
  }

  writeI32(value: number): void {
    this.ensureWritable()
    if (value < -0x80000000 || value > 0x7FFFFFFF) throw new Error('i32 out of range')
    encodeSVarInt(this.data, BigInt(value))
  }

  writeU16(value: number): void {
    this.ensureWritable()
    if (value < 0 || value > 0xFFFF) throw new Error('u16 out of range')
    encodeUVarInt(this.data, value & 0xFFFF)
  }

  writeI16(value: number): void {
    this.ensureWritable()
    if (value < -0x8000 || value > 0x7FFF) throw new Error('i16 out of range')
    encodeSVarInt(this.data, BigInt(value))
  }

  writeU8(value: number): void {
    this.ensureWritable()
    this.data.writeByte(value & 0xFF)
  }

  writeI8(value: number): void {
    this.ensureWritable()
    encodeI8(this.data, value)
  }

  writeF32(value: number): void {
    this.ensureWritable()
    encodeSortableF32(this.data, value, this.scratchView)
  }

  writeF64(value: number): void {
    this.ensureWritable()
    encodeSortableF64(this.data, value, this.scratchView)
  }

  writeBool(value: boolean): void {
    this.ensureWritable()
    this.data.writeByte(value ? 1 : 0)
  }

  writeLength(length: number): void {
    this.ensureWritable()
    if (length < 0) throw new Error('Length cannot be negative')
    encodeUVarInt(this.meta, length >>> 0)
  }

  writeString(value: string): void {
    this.ensureWritable()
    const encoded = this.textEncoder.encode(value)
    encodeUVarInt(this.meta, encoded.length)
    this.data.writeBytes(encoded)
  }

  writeBinary(value: ArrayBufferView | ArrayBuffer): void {
    this.ensureWritable()
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    encodeUVarInt(this.meta, bytes.length)
    this.data.writeBytes(bytes)
  }

  writeTyped(_value: TypedWriteValue): void {
    throw new Error('key format: writeTyped not supported')
  }

  writePointer(_value: unknown, _writeLater: WriteLater): void {
    throw new Error('key format: pointer not supported')
  }

  writeMap(
    _entries: ReadonlyArray<[unknown, unknown]>,
    _writeKey: (w: IWriter, key: unknown) => void,
    _writeVal: (w: IWriter, val: unknown) => void
  ): void {
    throw new Error('key format: map not supported')
  }

  /** Build [data][meta][u8 meta_size]. Throws if meta > 255. */
  finish(): Uint8Array {
    this.ensureWritable()
    if (this.meta.size > 255) {
      throw new Error('key format: meta too large')
    }
    const dataBytes = this.data.toUint8Array()
    const metaBytes = this.meta.toUint8Array()
    const out = new Uint8Array(dataBytes.length + metaBytes.length + 1)
    out.set(dataBytes, 0)
    out.set(metaBytes, dataBytes.length)
    out[out.length - 1] = metaBytes.length
    this.finished = true
    return out
  }

  toUint8Array(): Uint8Array {
    return this.finish()
  }

  toArrayBuffer(): ArrayBuffer {
    const bytes = this.finish()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  private ensureWritable(): void {
    if (this.finished) {
      throw new Error('key format: writer already finished')
    }
  }
}
