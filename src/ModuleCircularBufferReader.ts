import { CircularBuffer } from './CircularBuffer.js'

/**
 * Transport-only reader for module-backed circular buffers.
 * This class intentionally does not implement typed object deserialization.
 */
export class ModuleCircularBufferReader {
  private readonly textDecoder = new TextDecoder()
  private readonly scratch = new ArrayBuffer(8)
  private readonly scratchView = new DataView(this.scratch)
  private readOffset = 0

  constructor(
    private readonly buffer: CircularBuffer
  ) {}

  getReadOffset(): number {
    return this.readOffset
  }

  setReadOffset(offset: number): void {
    this.readOffset = offset
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

  readU8(): number {
    const bytes = new Uint8Array(1)
    const read = this.buffer.peek(this.readOffset, bytes, 1)
    if (read !== 1) {
      throw new Error('Unexpected end of buffer while reading u8')
    }
    this.readOffset += 1
    return bytes[0]
  }

  readBool(): boolean {
    return this.readU8() !== 0
  }

  readString(): string {
    const length = this.readU32()
    const bytes = this.readBytes(length)
    return this.textDecoder.decode(bytes)
  }

  readF64(): number {
    const bytes = this.readBytes(8)
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

  readRest(): void {}

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
