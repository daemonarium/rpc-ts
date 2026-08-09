import { CircularBuffer } from './CircularBuffer.js'
import { CodecRegistry } from './codec.js'
import type { IReader, ReadLater } from './writerTypes.js'

type AssignAfterRead = (value: unknown) => void

export class LocalCircularBufferReader implements IReader {
  private readonly textDecoder = new TextDecoder()
  private readonly readPointers: unknown[] = []
  private readonly pendingPointers: Array<{ assignments: AssignAfterRead[], readLater: ReadLater }> = []
  private readonly scratch = new ArrayBuffer(8)
  private readonly scratchView = new DataView(this.scratch)
  private readOffset = 0

  constructor(
    private readonly buffer: CircularBuffer,
    private readonly codecs: CodecRegistry
  ) {}

  getReadOffset(): number {
    return this.readOffset
  }

  setReadOffset(offset: number): void {
    this.readOffset = offset
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
    throw new Error('Indexed frames are not supported in circular buffer reader')
  }

  readU64(): number | bigint {
    return this.readUVarInt()
  }

  readI64(): number | bigint {
    return this.readSVarInt()
  }

  readU32(): number {
    const result = this.buffer.peekUVarInt32(this.readOffset)
    if (result.bytesRead === 0) {
      throw new Error('Unexpected end of buffer while reading uvarint32')
    }
    this.readOffset += result.bytesRead
    return result.value
  }

  readI32(): number {
    const result = this.buffer.peekSVarInt32(this.readOffset)
    if (result.bytesRead === 0) {
      throw new Error('Unexpected end of buffer while reading svarint32')
    }
    this.readOffset += result.bytesRead
    return result.value
  }

  readU16(): number {
    const result = this.buffer.peekUVarInt16(this.readOffset)
    if (result.bytesRead === 0) {
      throw new Error('Unexpected end of buffer while reading uvarint16')
    }
    this.readOffset += result.bytesRead
    return result.value
  }

  readI16(): number {
    const result = this.buffer.peekSVarInt16(this.readOffset)
    if (result.bytesRead === 0) {
      throw new Error('Unexpected end of buffer while reading svarint16')
    }
    this.readOffset += result.bytesRead
    return result.value
  }

  readU8(): number {
    const bytes = new Uint8Array(1)
    const read = this.buffer.peek(this.readOffset, bytes, 1)
    if (read !== 1) {
      throw new Error('Unexpected end of buffer while reading u8')
    }
    this.readOffset += 1
    return bytes[0]
  }

  readI8(): number {
    const b = this.readU8()
    return (b ^ 0x80) << 24 >> 24
  }

  readF32(): number {
    const bytes = new Uint8Array(4)
    const read = this.buffer.peek(this.readOffset, bytes, 4)
    if (read !== 4) {
      throw new Error('Unexpected end of buffer while reading float32')
    }
    this.readOffset += 4
    let v = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]
    if ((v & 0x80000000) !== 0) {
      v ^= 0x80000000
    } else {
      v = (~v) >>> 0
    }
    this.scratchView.setUint32(0, v, true)
    return this.scratchView.getFloat32(0, true)
  }

  readF64(): number {
    // C++ writes float64 as big-endian 8 bytes after transform; decode matches circular_buffer_reader.
    const bytes = new Uint8Array(8)
    const read = this.buffer.peek(this.readOffset, bytes, 8)
    if (read !== 8) {
      throw new Error('Unexpected end of buffer while reading float64')
    }
    this.readOffset += 8
    let value = (BigInt(bytes[0]) << 56n) | (BigInt(bytes[1]) << 48n) | (BigInt(bytes[2]) << 40n) |
      (BigInt(bytes[3]) << 32n) | (BigInt(bytes[4]) << 24n) | (BigInt(bytes[5]) << 16n) |
      (BigInt(bytes[6]) << 8n) | BigInt(bytes[7])
    const signMask = 0x8000000000000000n
    if ((value & signMask) !== 0n) {
      value ^= signMask
    } else {
      value = (~value) & 0xFFFFFFFFFFFFFFFFn
    }
    this.scratchView.setBigUint64(0, value, true)
    return this.scratchView.getFloat64(0, true)
  }

  readBool(): boolean {
    const bytes = new Uint8Array(1)
    const read = this.buffer.peek(this.readOffset, bytes, 1)
    if (read !== 1) {
      throw new Error('Unexpected end of buffer while reading bool')
    }
    this.readOffset += 1
    return bytes[0] !== 0
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

  readLength(): number {
    return this.readU32()
  }

  readException(): { typeName: string, value: unknown } {
    const index = this.readU32()
    const codec = this.codecs.exceptions.getByIndex(index)
    if (!codec) {
      throw new Error(`Exception type not registered for deserialization (index ${index})`)
    }
    let value: unknown
    codec.deserialize(this, (v) => {
      value = v
    })
    return { typeName: codec.name, value }
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
      assign(null as any)
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
      readLater: readLater as ReadLater
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

  private readLittleEndianUint64(): bigint {
    const bytes = new Uint8Array(8)
    const read = this.buffer.peek(this.readOffset, bytes, 8)
    if (read !== 8) {
      throw new Error('Unexpected end of buffer while reading uint64')
    }
    this.readOffset += 8
    let value = 0n
    for (let i = 0; i < 8; ++i) {
      value |= BigInt(bytes[i]) << BigInt(i * 8)
    }
    return value
  }

  private readUVarInt(): number | bigint {
    const result = this.buffer.peekUVarInt(this.readOffset)
    if (result.bytesRead === 0) {
      throw new Error('Unexpected end of buffer while reading uvarint')
    }
    this.readOffset += result.bytesRead
    return result.value
  }

  private readSVarInt(): number | bigint {
    const result = this.buffer.peekSVarInt(this.readOffset)
    if (result.bytesRead === 0) {
      throw new Error('Unexpected end of buffer while reading svarint')
    }
    this.readOffset += result.bytesRead
    return result.value
  }

  private readBytes(length: number): Uint8Array {
    if (length < 0) {
      throw new Error('Length cannot be negative')
    }
    const bytes = new Uint8Array(length)
    const read = this.buffer.peek(this.readOffset, bytes, length)
    if (read !== length) {
      throw new Error('Unexpected end of buffer while reading bytes')
    }
    this.readOffset += length
    return bytes
  }
}

