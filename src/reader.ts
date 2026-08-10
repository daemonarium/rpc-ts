import { CodecRegistry } from './codec.js'
import {
  decodeI8,
  decodeSVarInt,
  decodeSortableF32,
  decodeSortableF64,
  decodeUVarInt,
  type ByteCursor,
} from './compressedEncoding.js'
import type { IReader, ReadLater } from './writerTypes.js'

type AssignAfterRead = (value: unknown) => void

export class Reader implements IReader, ByteCursor {
  private readonly bytes: Uint8Array
  private offset = 0
  private readonly textDecoder = new TextDecoder()
  private readonly readPointers: unknown[] = []
  private readonly pendingPointers: Array<{ assignments: AssignAfterRead[], readLater: ReadLater }> = []
  private readonly scratch = new ArrayBuffer(8)
  private readonly scratchView = new DataView(this.scratch)

  constructor(source: ArrayBufferLike | ArrayBufferView, private readonly codecs: CodecRegistry) {
    if (source instanceof ArrayBuffer) {
      this.bytes = new Uint8Array(source)
    } else if (ArrayBuffer.isView(source)) {
      this.bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    } else {
      throw new Error('Unsupported buffer type')
    }
  }

  isIndexed(): boolean {
    return false
  }

  deferredPointerUsesTypeIndex(): boolean {
    return true
  }

  enterFrame(): void {}

  exitFrame(): void {}

  saveOffset(): void {}

  enterIndexedFrame(_id: number): void {
    throw new Error('Indexed frames are not supported in stream reader')
  }

  readU64(): number | bigint {
    return decodeUVarInt(this)
  }

  readI64(): number | bigint {
    return decodeSVarInt(this)
  }

  readU32(): number {
    const v = decodeUVarInt(this)
    const n = typeof v === 'bigint' ? Number(v) : v
    if (n < 0 || n > 0xFFFFFFFF) throw new Error('u32 out of range')
    return n >>> 0
  }

  readI32(): number {
    const v = decodeSVarInt(this)
    const n = typeof v === 'bigint' ? Number(v) : v
    if (n < -0x80000000 || n > 0x7FFFFFFF) throw new Error('i32 out of range')
    return n | 0
  }

  readU16(): number {
    const v = decodeUVarInt(this)
    const n = typeof v === 'bigint' ? Number(v) : v
    if (n < 0 || n > 0xFFFF) throw new Error('u16 out of range')
    return n & 0xFFFF
  }

  readI16(): number {
    const v = decodeSVarInt(this)
    const n = typeof v === 'bigint' ? Number(v) : v
    if (n < -0x8000 || n > 0x7FFF) throw new Error('i16 out of range')
    return n << 16 >> 16
  }

  readU8(): number {
    return this.readByte()
  }

  readI8(): number {
    return decodeI8(this)
  }

  readF32(): number {
    return decodeSortableF32(this, this.scratchView)
  }

  readF64(): number {
    return decodeSortableF64(this, this.scratchView)
  }

  readBool(): boolean {
    return this.readByte() !== 0
  }

  readString(): string {
    const length = this.readU32()
    const bytes = this.readBytes(length)
    return this.textDecoder.decode(bytes)
  }

  readBinary(): Uint8Array {
    const length = this.readU32()
    return this.readBytes(length)
  }

  /** Read exactly `length` raw bytes (no length prefix). */
  readRawBytes(length: number): Uint8Array {
    return this.readBytes(length)
  }

  readLength(): number {
    return this.readU32()
  }

  readTyped<T>(output: (value: T) => void): void {
    const index = this.readU32()
    const codec = this.codecs.typed.getByIndex(index)
    codec.deserialize(this, output)
  }

  readMap(
    readKey: (r: IReader, assign: (key: unknown) => void) => void,
    readVal: (r: IReader, assign: (val: unknown) => void) => void
  ): Array<[unknown, unknown]> {
    const n = this.readLength()
    const out: Array<[unknown, unknown]> = []
    for (let i = 0; i < n; ++i) {
      let key: unknown
      let val: unknown
      readKey(this, k => { key = k })
      readVal(this, v => { val = v })
      out.push([key, val])
    }
    return out
  }

  readPointer<T>(assign: (value: T) => void, readLater: ReadLater): void {
    const delta = this.readI32()
    if (delta === 0) {
      assign(null)
      return
    }
    if (delta < 0) {
      const index = this.readPointers.length + delta
      if (index < 0 || index >= this.readPointers.length) {
        throw new Error('Pointer delta out of range')
      }
      assign(this.readPointers[index] as T)
      return
    }
    const offset = delta - 1 // decrement delta, because 0 is null
    if (offset < this.pendingPointers.length) {
      this.pendingPointers[offset].assignments.push(value => assign(value as T))
      return
    }
    if (offset > this.pendingPointers.length) {
      throw new Error('Pointer delta too large, input is corrupted')
    }
    this.pendingPointers.push({
      assignments: [value => assign(value as T)],
      readLater
    })
  }

  readRest(): void {
    while (this.pendingPointers.length > 0) {
      const entry = this.pendingPointers[0]
      if (!entry) continue
      entry.readLater((value) => {
        this.pendingPointers.shift()
        this.readPointers.push(value)
        for (const assign of entry.assignments) {
          assign(value)
        }
      })
    }
  }

  readByte(): number {
    if (this.offset >= this.bytes.length) {
      throw new Error('Unexpected end of buffer')
    }
    return this.bytes[this.offset++]
  }

  readMultiple(count: number): number[] {
    const values = new Array<number>(count)
    for (let i = 0; i < count; ++i) {
      values[i] = this.readByte()
    }
    return values
  }

  private readBytes(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new Error('Unexpected end of buffer while reading bytes')
    }
    const slice = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return slice
  }
}
