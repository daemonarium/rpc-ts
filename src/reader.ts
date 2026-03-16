import { CodecRegistry } from './codec.js'
import { TypeKind } from './typeDescription.js'

type AssignAfterRead = (value: unknown) => void
type ReadLater = (output: (value: unknown) => void) => void

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

  readU64(): number | bigint {
    return this.readUVarInt()
  }

  readI64(): number | bigint {
    return this.readSVarInt()
  }

  readU32(): number {
    const v = this.readUVarInt()
    const n = typeof v === 'bigint' ? Number(v) : v
    if (n < 0 || n > 0xFFFFFFFF) throw new Error('u32 out of range')
    return n >>> 0
  }

  readI32(): number {
    const v = this.readSVarInt()
    const n = typeof v === 'bigint' ? Number(v) : v
    if (n < -0x80000000 || n > 0x7FFFFFFF) throw new Error('i32 out of range')
    return n | 0
  }

  readU16(): number {
    const v = this.readUVarInt()
    const n = typeof v === 'bigint' ? Number(v) : v
    if (n < 0 || n > 0xFFFF) throw new Error('u16 out of range')
    return n & 0xFFFF
  }

  readI16(): number {
    const v = this.readSVarInt()
    const n = typeof v === 'bigint' ? Number(v) : v
    if (n < -0x8000 || n > 0x7FFF) throw new Error('i16 out of range')
    return n << 16 >> 16
  }

  readU8(): number {
    return this.readByte()
  }

  readI8(): number {
    return (this.readByte() ^ 0x80) << 24 >> 24
  }

  readF32(): number {
    const b0 = this.readByte()
    const b1 = this.readByte()
    const b2 = this.readByte()
    const b3 = this.readByte()
    let v = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3
    if ((v & 0x80000000) !== 0) {
      v ^= 0x80000000
    } else {
      v = (~v) >>> 0
    }
    this.scratchView.setUint32(0, v, true)
    return this.scratchView.getFloat32(0, true)
  }

  readF64(): number {
    const bits = this.readBigEndianUint64()
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

  readTyped<T>(output: (value: T) => void): void {
    const index = this.readU32()
    const codec = this.codecs.getByIndex(index)
    codec.deserialize(this, output)
  }

  readPointer<T>(assign: (value: T) => void, readLater: (output: (value: T) => void) => void): void {
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
    let value = 0n
    for (let i = 0; i < 8; ++i) {
      value |= BigInt(this.readByte()) << BigInt(i * 8)
    }
    return value
  }

  private readBigEndianUint64(): bigint {
    let value = 0n
    for (let i = 0; i < 8; ++i) {
      value = (value << 8n) | BigInt(this.readByte())
    }
    return value
  }

  private readUVarInt(): number | bigint {
    const first = this.readByte()
    if ((first & 0x80) === 0) {
      return first
    }
    if ((first & 0x40) === 0) {
      const second = this.readByte()
      const value = ((first & 0x3F) << 8) | second
      return value
    }
    if ((first & 0x20) === 0) {
      const second = this.readByte()
      const third = this.readByte()
      const value = ((first & 0x1F) << 16) | (second << 8) | third
      return value
    }
    if ((first & 0x10) === 0) {
      const b1 = this.readByte()
      const b2 = this.readByte()
      const b3 = this.readByte()
      const value = ((first & 0x0F) << 24) | (b1 << 16) | (b2 << 8) | b3
      return value
    }
    if ((first & 0x08) === 0) {
      const b = this.readMultiple(4)
      const valueBig = (BigInt(first & 0x07) << 32n)
        | (BigInt(b[0]) << 24n)
        | (BigInt(b[1]) << 16n)
        | (BigInt(b[2]) << 8n)
        | BigInt(b[3])
      if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(valueBig)
      }
      return valueBig
    }
    if ((first & 0x04) === 0) {
      const b = this.readMultiple(5)
      const valueBig = (BigInt(first & 0x03) << 40n)
        | (BigInt(b[0]) << 32n)
        | (BigInt(b[1]) << 24n)
        | (BigInt(b[2]) << 16n)
        | (BigInt(b[3]) << 8n)
        | BigInt(b[4])
      if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(valueBig)
      }
      return valueBig
    }
    if ((first & 0x02) === 0) {
      const b = this.readMultiple(6)
      const valueBig = (BigInt(first & 0x01) << 48n)
        | (BigInt(b[0]) << 40n)
        | (BigInt(b[1]) << 32n)
        | (BigInt(b[2]) << 24n)
        | (BigInt(b[3]) << 16n)
        | (BigInt(b[4]) << 8n)
        | BigInt(b[5])
      if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(valueBig)
      }
      return valueBig
    }
    if ((first & 0x01) === 0) {
      const b = this.readMultiple(7)
      const valueBig = (BigInt(b[0]) << 48n)
        | (BigInt(b[1]) << 40n)
        | (BigInt(b[2]) << 32n)
        | (BigInt(b[3]) << 24n)
        | (BigInt(b[4]) << 16n)
        | (BigInt(b[5]) << 8n)
        | BigInt(b[6])
      if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(valueBig)
      }
      return valueBig
    }
    const b = this.readMultiple(8)
    const valueBig = (BigInt(b[0]) << 56n)
      | (BigInt(b[1]) << 48n)
      | (BigInt(b[2]) << 40n)
      | (BigInt(b[3]) << 32n)
      | (BigInt(b[4]) << 24n)
      | (BigInt(b[5]) << 16n)
      | (BigInt(b[6]) << 8n)
      | BigInt(b[7])
    if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(valueBig)
    }
    return valueBig
  }

  private readSVarInt(): number | bigint {
    const first = this.readByte()
    const negative = (first & 0x80) === 0
    if (negative) {
      if ((first & 0x40) !== 0) {
        return -((~first) & 0x3F)
      }
      if ((first & 0xE0) === 0x20) {
        const second = this.readByte()
        const encoded = ((first & 0x1F) << 8) | second
        return -(0x1FFF - encoded)
      }
      if ((first & 0xF0) === 0x10) {
        const b = this.readMultiple(2)
        const encoded = ((first & 0x0F) << 16) | (b[0] << 8) | b[1]
        return -(0xFFFFF - encoded)
      }
      if ((first & 0xF8) === 0x08) {
        const b = this.readMultiple(3)
        const encoded = ((first & 0x07) << 24) | (b[0] << 16) | (b[1] << 8) | b[2]
        return -(0x7FFFFFF - encoded)
      }
      if ((first & 0xFC) === 0x04) {
        const b = this.readMultiple(4)
        const encoded = (BigInt(first & 0x03) << 32n)
          | (BigInt(b[0]) << 24n)
          | (BigInt(b[1]) << 16n)
          | (BigInt(b[2]) << 8n)
          | BigInt(b[3])
        const valueBig = -(0x3FFFFFFFFn - encoded)
        if (valueBig >= BigInt(Number.MIN_SAFE_INTEGER) && valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
          return Number(valueBig)
        }
        return valueBig
      }
      if ((first & 0xFE) === 0x02) {
        const b = this.readMultiple(5)
        const encoded = (BigInt(first & 0x01) << 40n)
          | (BigInt(b[0]) << 32n)
          | (BigInt(b[1]) << 24n)
          | (BigInt(b[2]) << 16n)
          | (BigInt(b[3]) << 8n)
          | BigInt(b[4])
        const valueBig = -(0x1FFFFFFFFFFn - encoded)
        if (valueBig >= BigInt(Number.MIN_SAFE_INTEGER) && valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
          return Number(valueBig)
        }
        return valueBig
      }
      if (first === 0x01) {
        const b = this.readMultiple(6)
        const encoded = (BigInt(b[0]) << 40n)
          | (BigInt(b[1]) << 32n)
          | (BigInt(b[2]) << 24n)
          | (BigInt(b[3]) << 16n)
          | (BigInt(b[4]) << 8n)
          | BigInt(b[5])
        const valueBig = -(0xFFFFFFFFFFFFn - encoded)
        if (valueBig >= BigInt(Number.MIN_SAFE_INTEGER) && valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
          return Number(valueBig)
        }
        return valueBig
      }
      const b = this.readMultiple(8)
      const encoded = (BigInt(b[0]) << 56n)
        | (BigInt(b[1]) << 48n)
        | (BigInt(b[2]) << 40n)
        | (BigInt(b[3]) << 32n)
        | (BigInt(b[4]) << 24n)
        | (BigInt(b[5]) << 16n)
        | (BigInt(b[6]) << 8n)
        | BigInt(b[7])
      const valueBig = -(0xFFFFFFFFFFFFFFFFn - encoded)
      if (valueBig >= BigInt(Number.MIN_SAFE_INTEGER) && valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(valueBig)
      }
      return valueBig
    } else {
      if ((first & 0x40) === 0) {
        return first & 0x3F
      }
      if ((first & 0x20) === 0) {
        const second = this.readByte()
        const encoded = ((first & 0x1F) << 8) | second
        return encoded
      }
      if ((first & 0x10) === 0) {
        const b = this.readMultiple(2)
        const encoded = ((first & 0x0F) << 16) | (b[0] << 8) | b[1]
        return encoded
      }
      if ((first & 0x08) === 0) {
        const b = this.readMultiple(3)
        const encoded = ((first & 0x07) << 24) | (b[0] << 16) | (b[1] << 8) | b[2]
        return encoded
      }
      if ((first & 0x04) === 0) {
        const b = this.readMultiple(4)
        const encoded = (BigInt(first & 0x03) << 32n)
          | (BigInt(b[0]) << 24n)
          | (BigInt(b[1]) << 16n)
          | (BigInt(b[2]) << 8n)
          | BigInt(b[3])
        if (encoded >= BigInt(Number.MIN_SAFE_INTEGER) && encoded <= BigInt(Number.MAX_SAFE_INTEGER)) {
          return Number(encoded)
        }
        return encoded
      }
      if ((first & 0x02) === 0) {
        const b = this.readMultiple(5)
        const encoded = (BigInt(first & 0x01) << 40n)
          | (BigInt(b[0]) << 32n)
          | (BigInt(b[1]) << 24n)
          | (BigInt(b[2]) << 16n)
          | (BigInt(b[3]) << 8n)
          | BigInt(b[4])
        if (encoded >= BigInt(Number.MIN_SAFE_INTEGER) && encoded <= BigInt(Number.MAX_SAFE_INTEGER)) {
          return Number(encoded)
        }
        return encoded
      }
      if ((first & 0x01) === 0) {
        const b = this.readMultiple(6)
        const encoded = (BigInt(b[0]) << 40n)
          | (BigInt(b[1]) << 32n)
          | (BigInt(b[2]) << 24n)
          | (BigInt(b[3]) << 16n)
          | (BigInt(b[4]) << 8n)
          | BigInt(b[5])
        if (encoded >= BigInt(Number.MIN_SAFE_INTEGER) && encoded <= BigInt(Number.MAX_SAFE_INTEGER)) {
          return Number(encoded)
        }
        return encoded
      }
      const b = this.readMultiple(8)
      const encoded = (BigInt(b[0]) << 56n)
        | (BigInt(b[1]) << 48n)
        | (BigInt(b[2]) << 40n)
        | (BigInt(b[3]) << 32n)
        | (BigInt(b[4]) << 24n)
        | (BigInt(b[5]) << 16n)
        | (BigInt(b[6]) << 8n)
        | BigInt(b[7])
      if (encoded >= BigInt(Number.MIN_SAFE_INTEGER) && encoded <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(encoded)
      }
      return encoded
    }
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

