import { CodecRegistry } from './codec.js'
import { TypeKind } from './typeDescription.js'

type AssignAfterRead = (value: unknown) => void
type ReadLater = () => unknown

export class Reader {
  private readonly bytes: Uint8Array
  private offset = 0
  private readonly view: DataView
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
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
  }

  isIndexed(): boolean {
    return false
  }

  enterFrame(): void {}

  exitFrame(): void {}

  enterIndexedFrame(_id: number): void {
    throw new Error('Indexed frames are not supported in stream reader')
  }

  readU64(): bigint {
    return this.readUVarInt()
  }

  readI64(): bigint {
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
    return this.readByte() !== 0
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

  readTyped<T>(): T {
    const index = Number(this.readUVarInt())
    const codec = this.codecs.getByIndex(index)
    return codec.deserialize(this) as T
  }

  readPointer<T>(assign: (value: T) => void, readLater: () => T): void {
    const delta = Number(this.readSVarInt())
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
    const offset = delta - 1; // decrement delta, because 0 is null
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
      const value = entry.readLater()
      this.pendingPointers.shift()
      this.readPointers.push(value)
      for (const assign of entry.assignments) {
        assign(value)
      }      
    }
  }

  private readLittleEndianUint64(): bigint {
    let value = 0n
    for (let i = 0; i < 8; ++i) {
      value |= BigInt(this.readByte()) << BigInt(i * 8)
    }
    return value
  }

  private readUVarInt(): bigint {
    const first = this.readByte()
    if ((first & 0x80) === 0) {
      return BigInt(first)
    }
    if ((first & 0x40) === 0) {
      const second = this.readByte()
      return (BigInt(first & 0x3F) << 8n) | BigInt(second)
    }
    if ((first & 0x20) === 0) {
      const second = this.readByte()
      const third = this.readByte()
      return (BigInt(first & 0x1F) << 16n)
        | (BigInt(second) << 8n)
        | BigInt(third)
    }
    if ((first & 0x10) === 0) {
      const b1 = this.readByte()
      const b2 = this.readByte()
      const b3 = this.readByte()
      return (BigInt(first & 0x0F) << 24n)
        | (BigInt(b1) << 16n)
        | (BigInt(b2) << 8n)
        | BigInt(b3)
    }
    if ((first & 0x08) === 0) {
      const b = this.readMultiple(4)
      return (BigInt(first & 0x07) << 32n)
        | (BigInt(b[0]) << 24n)
        | (BigInt(b[1]) << 16n)
        | (BigInt(b[2]) << 8n)
        | BigInt(b[3])
    }
    if ((first & 0x04) === 0) {
      const b = this.readMultiple(5)
      return (BigInt(first & 0x03) << 40n)
        | (BigInt(b[0]) << 32n)
        | (BigInt(b[1]) << 24n)
        | (BigInt(b[2]) << 16n)
        | (BigInt(b[3]) << 8n)
        | BigInt(b[4])
    }
    if ((first & 0x02) === 0) {
      const b = this.readMultiple(6)
      return (BigInt(first & 0x01) << 48n)
        | (BigInt(b[0]) << 40n)
        | (BigInt(b[1]) << 32n)
        | (BigInt(b[2]) << 24n)
        | (BigInt(b[3]) << 16n)
        | (BigInt(b[4]) << 8n)
        | BigInt(b[5])
    }
    if ((first & 0x01) === 0) {
      const b = this.readMultiple(7)
      return (BigInt(b[0]) << 48n)
        | (BigInt(b[1]) << 40n)
        | (BigInt(b[2]) << 32n)
        | (BigInt(b[3]) << 24n)
        | (BigInt(b[4]) << 16n)
        | (BigInt(b[5]) << 8n)
        | BigInt(b[6])
    }
    const b = this.readMultiple(8)
    return (BigInt(b[0]) << 56n)
      | (BigInt(b[1]) << 48n)
      | (BigInt(b[2]) << 40n)
      | (BigInt(b[3]) << 32n)
      | (BigInt(b[4]) << 24n)
      | (BigInt(b[5]) << 16n)
      | (BigInt(b[6]) << 8n)
      | BigInt(b[7])
  }

  private readSVarInt(): bigint {
    const first = this.readByte()
    const negative = (first & 0x80) === 0
    if ((first & 0x40) === 0) {
      const raw = BigInt(first & 0x3F)
      const mask = 0x3Fn
      return negative ? -(((~raw) & mask)) : raw
    }
    if ((first & 0x20) === 0) {
      const second = this.readByte()
      const raw = (BigInt(first & 0x1F) << 8n) | BigInt(second)
      const mask = 0x3FFFn
      return negative ? -(((~raw) & mask)) : raw
    }
    if ((first & 0x10) === 0) {
      const second = this.readByte()
      const third = this.readByte()
      const raw = (BigInt(first & 0x0F) << 16n)
        | (BigInt(second) << 8n)
        | BigInt(third)
      const mask = 0x1FFFFn
      return negative ? -(((~raw) & mask)) : raw
    }
    if ((first & 0x08) === 0) {
      const b = this.readMultiple(3)
      const raw = (BigInt(first & 0x07) << 24n)
        | (BigInt(b[0]) << 16n)
        | (BigInt(b[1]) << 8n)
        | BigInt(b[2])
      const mask = 0xFFFFFFn
      return negative ? -(((~raw) & mask)) : raw
    }
    if ((first & 0x04) === 0) {
      const b = this.readMultiple(4)
      const raw = (BigInt(first & 0x03) << 32n)
        | (BigInt(b[0]) << 24n)
        | (BigInt(b[1]) << 16n)
        | (BigInt(b[2]) << 8n)
        | BigInt(b[3])
      const mask = BigInt('0x7FFFFFFF')
      return negative ? -(((~raw) & mask)) : raw
    }
    if ((first & 0x02) === 0) {
      const b = this.readMultiple(5)
      const raw = (BigInt(first & 0x01) << 40n)
        | (BigInt(b[0]) << 32n)
        | (BigInt(b[1]) << 24n)
        | (BigInt(b[2]) << 16n)
        | (BigInt(b[3]) << 8n)
        | BigInt(b[4])
      const mask = BigInt('0x7FFFFFFFFF')
      return negative ? -(((~raw) & mask)) : raw
    }
    if ((first & 0x01) === 0) {
      const b = this.readMultiple(6)
      const raw = (BigInt(b[0]) << 40n)
        | (BigInt(b[1]) << 32n)
        | (BigInt(b[2]) << 24n)
        | (BigInt(b[3]) << 16n)
        | (BigInt(b[4]) << 8n)
        | BigInt(b[5])
      const mask = BigInt('0x7FFFFFFFFFFFFF')
      return negative ? -(((~raw) & mask)) : raw
    }
    const b = this.readMultiple(8)
    const raw = (BigInt(b[0]) << 56n)
      | (BigInt(b[1]) << 48n)
      | (BigInt(b[2]) << 40n)
      | (BigInt(b[3]) << 32n)
      | (BigInt(b[4]) << 24n)
      | (BigInt(b[5]) << 16n)
      | (BigInt(b[6]) << 8n)
      | BigInt(b[7])
    const mask = BigInt('0x7FFFFFFFFFFFFFFF')
    return negative ? -(((~raw) & mask)) : raw
  }

  private readByte(): number {
    if (this.offset >= this.bytes.length) {
      throw new Error('Unexpected end of buffer')
    }
    return this.bytes[this.offset++]
  }

  private readMultiple(count: number): number[] {
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

