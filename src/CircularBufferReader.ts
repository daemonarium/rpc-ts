import { CircularBuffer } from './CircularBuffer.js'
import { CodecRegistry } from './codec.js'

type AssignAfterRead = (value: unknown) => void
type ReadLater = (output: (value: unknown) => void) => void

export class CircularBufferReader {
  private readonly textDecoder = new TextDecoder()
  private readonly readPointers: unknown[] = []
  private readonly pendingPointers: Array<{ assignments: AssignAfterRead[], readLater: ReadLater }> = []
  private readonly scratch = new ArrayBuffer(8)
  private readonly scratchView = new DataView(this.scratch)

  constructor(
    private readonly buffer: CircularBuffer,
    private readonly codecs: CodecRegistry
  ) {}

  isIndexed(): boolean {
    return false
  }

  enterFrame(): void {}

  exitFrame(): void {}

  enterIndexedFrame(_id: number): void {
    throw new Error('Indexed frames are not supported in circular buffer reader')
  }

  readU64(): number | bigint {
    return this.readUVarInt()
  }

  readI64(): number | bigint {
    return this.readSVarInt()
  }

  readF64(): number {
    const bits = this.readLittleEndianUint64()
    let value = bits
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
    const read = this.buffer.read(bytes, 1)
    if (read !== 1) {
      throw new Error('Unexpected end of buffer while reading bool')
    }
    return bytes[0] !== 0
  }

  readString(): string {
    const length = Number(this.readUVarInt())
    const bytes = this.readBytes(length)
    return this.textDecoder.decode(bytes)
  }

  readBinary(): Uint8Array {
    const length = Number(this.readUVarInt())
    return this.readBytes(length)
  }

  readLength(): number {
    const length = this.readUVarInt()
    if (length > Number.MAX_SAFE_INTEGER) {
      throw new Error('Length exceeds MAX_SAFE_INTEGER')
    }
    return Number(length)
  }

  readTyped<T>(output: (value: T) => void): void {
    const index = Number(this.readUVarInt())
    const codec = this.codecs.getByIndex(index)
    codec.deserialize(this as any, output)
  }

  readPointer<T>(assign: (value: T) => void, readLater: (output: (value: T) => void) => void): void {
    const delta = Number(this.readSVarInt())
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
    const read = this.buffer.read(bytes, 8)
    if (read !== 8) {
      throw new Error('Unexpected end of buffer while reading uint64')
    }
    let value = 0n
    for (let i = 0; i < 8; ++i) {
      value |= BigInt(bytes[i]) << BigInt(i * 8)
    }
    return value
  }

  private readUVarInt(): number | bigint {
    const result = this.buffer.readUVarInt()
    return result.value
  }

  private readSVarInt(): number | bigint {
    const result = this.buffer.readSVarInt()
    return result.value
  }

  private readBytes(length: number): Uint8Array {
    if (length < 0) {
      throw new Error('Length cannot be negative')
    }
    const bytes = new Uint8Array(length)
    const read = this.buffer.read(bytes, length)
    if (read !== length) {
      throw new Error('Unexpected end of buffer while reading bytes')
    }
    return bytes
  }
}

