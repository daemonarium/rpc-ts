import { CodecRegistry, type TypedValue } from './codec.js'
import {
  encodeI8,
  encodeSVarInt,
  encodeSortableF32,
  encodeSortableF64,
  encodeUVarInt,
  toUnsigned,
  type ByteSink,
} from './compressedEncoding.js'
import type { IWriter, WriteLater } from './writerTypes.js'

export class Writer implements IWriter, ByteSink {
  private buffer: Uint8Array
  private length = 0
  private readonly textEncoder = new TextEncoder()
  private readonly writtenPointers: unknown[] = []
  private readonly pendingPointers: Array<{ value: unknown, writeLater: WriteLater }> = []
  private readonly scratch = new ArrayBuffer(8)
  private readonly scratchView = new DataView(this.scratch)

  constructor(private readonly codecs: CodecRegistry, initialCapacity = 1024) {
    this.buffer = new Uint8Array(initialCapacity)
  }

  get size(): number {
    return this.length
  }

  toArrayBuffer(): ArrayBuffer {
    return this.buffer.buffer.slice(0, this.length) as ArrayBuffer
  }

  beginFrame(): void {}

  endFrame(): void {}

  saveOffset(): void {}

  writeU64(value: bigint | number): void {
    encodeUVarInt(this, toUnsigned(value))
  }

  writeI64(value: bigint | number): void {
    encodeSVarInt(this, BigInt(value))
  }

  writeU32(value: number): void {
    if (value < 0 || value > 0xFFFFFFFF) throw new Error('u32 out of range')
    encodeUVarInt(this, value >>> 0)
  }

  writeI32(value: number): void {
    if (value < -0x80000000 || value > 0x7FFFFFFF) throw new Error('i32 out of range')
    encodeSVarInt(this, BigInt(value))
  }

  writeU16(value: number): void {
    if (value < 0 || value > 0xFFFF) throw new Error('u16 out of range')
    encodeUVarInt(this, value & 0xFFFF)
  }

  writeI16(value: number): void {
    if (value < -0x8000 || value > 0x7FFF) throw new Error('i16 out of range')
    encodeSVarInt(this, BigInt(value))
  }

  writeU8(value: number): void {
    this.writeByte(value & 0xFF)
  }

  writeI8(value: number): void {
    encodeI8(this, value)
  }

  writeF32(value: number): void {
    encodeSortableF32(this, value, this.scratchView)
  }

  writeF64(value: number): void {
    encodeSortableF64(this, value, this.scratchView)
  }

  writeBool(value: boolean): void {
    this.writeByte(value ? 1 : 0)
  }

  writeString(value: string): void {
    const encoded = this.textEncoder.encode(value)
    this.writeU32(encoded.length)
    this.writeBytes(encoded)
  }

  writeBinary(value: ArrayBufferView | ArrayBuffer): void {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    this.writeU32(bytes.length)
    this.writeBytes(bytes)
  }

  writeLength(length: number): void {
    if (length < 0) {
      throw new Error('Length cannot be negative')
    }
    this.writeU32(length)
  }

  writeTyped(value: TypedValue): void {
    if (!value || typeof value._type !== 'string') {
      throw new Error('Typed value must provide _type string')
    }
    const index = this.codecs.typed.getIndexOrThrow(value._type)
    this.writeU32(index)
    const codec = this.codecs.typed.getByIndex(index)
    codec.serialize(this, value)
  }

  writeMap(
    entries: ReadonlyArray<[unknown, unknown]>,
    writeKey: (w: IWriter, key: unknown) => void,
    writeVal: (w: IWriter, val: unknown) => void
  ): void {
    this.writeLength(entries.length)
    for (const [k, v] of entries) {
      writeKey(this, k)
      writeVal(this, v)
    }
  }

  writePointer(value: unknown, writeLater: WriteLater): void {
    if (value === null) {
      this.writeI32(0)
      return
    }
    const existingIndex = this.writtenPointers.indexOf(value)
    if (existingIndex !== -1) {
      const delta = existingIndex - this.writtenPointers.length
      this.writeI32(delta)
      return
    }
    const pendingIndex = this.pendingPointers.findIndex(entry => entry.value === value)
    if (pendingIndex !== -1) {
      const delta = pendingIndex + 1
      this.writeI32(delta)
      return
    }
    const delta = this.pendingPointers.length + 1
    this.writeI32(delta)
    this.pendingPointers.push({ value, writeLater })
  }

  writeRest(): void {
    // Match C++ stream_writer::write_rest: keep current entry in pending during
    // writeLater so forward-ref deltas stay aligned with peek-based readRest.
    while (this.pendingPointers.length > 0) {
      const entry = this.pendingPointers[0]
      if (!entry) continue
      entry.writeLater()
      this.writtenPointers.push(entry.value)
      this.pendingPointers.shift()
    }
  }

  deferredPointerUsesTypeIndex(): boolean {
    return true
  }

  writeByte(value: number): void {
    this.ensureCapacity(1)
    this.buffer[this.length++] = value & 0xFF
  }

  writeBytes(bytes: Uint8Array | number[]): void {
    if (bytes instanceof Uint8Array) {
      this.ensureCapacity(bytes.length)
      this.buffer.set(bytes, this.length)
      this.length += bytes.length
    } else {
      this.ensureCapacity(bytes.length)
      for (const byte of bytes) {
        this.buffer[this.length++] = byte & 0xFF
      }
    }
  }

  private ensureCapacity(extra: number): void {
    const required = this.length + extra
    if (required <= this.buffer.length) return
    let capacity = this.buffer.length * 2
    while (capacity < required) {
      capacity *= 2
    }
    const next = new Uint8Array(capacity)
    next.set(this.buffer.subarray(0, this.length))
    this.buffer = next
  }
}
