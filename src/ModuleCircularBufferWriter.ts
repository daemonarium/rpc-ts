import { CircularBuffer } from './CircularBuffer.js'

export class ModuleCircularBufferWriter {
  private readonly textEncoder = new TextEncoder()
  private readonly scratch = new ArrayBuffer(8)
  private readonly scratchView = new DataView(this.scratch)  

  constructor(
    private readonly buffer: CircularBuffer,
    public offset: number = 0
  ) {
  }

  getOffset(): number {
    return this.offset
  }

  writeU64(value: bigint | number): void {
    this.writeUVarInt(this.toUnsigned(value))
  }

  writeI64(value: bigint | number): void {
    this.writeSVarInt(BigInt(value))
  }

  writeU32(value: number): void {
    this.offset += this.buffer.pokeUVarInt32(this.offset, value)
  }

  writeI32(value: number): void {
    this.offset += this.buffer.pokeSVarInt32(this.offset, value)
  }

  writeU16(value: number): void {
    this.offset += this.buffer.pokeUVarInt16(this.offset, value)
  }

  writeI16(value: number): void {
    this.offset += this.buffer.pokeSVarInt16(this.offset, value)
  }

  writeU8(value: number): void {
    const bytes = new Uint8Array([value & 0xFF])
    this.offset += this.buffer.poke(this.offset, bytes, 1)
  }

  writeI8(value: number): void {
    const bytes = new Uint8Array([(value ^ 0x80) & 0xFF])
    this.offset += this.buffer.poke(this.offset, bytes, 1)
  }

  writeF32(value: number): void {
    this.scratchView.setFloat32(0, value, true)
    let bits = this.scratchView.getUint32(0, true)
    if ((bits & 0x80000000) !== 0) {
      bits = (~bits) >>> 0
    } else {
      bits ^= 0x80000000
    }
    if (value === 0) bits = 0x80000000
    const bytes = new Uint8Array(4)
    bytes[0] = (bits >> 24) & 0xFF
    bytes[1] = (bits >> 16) & 0xFF
    bytes[2] = (bits >> 8) & 0xFF
    bytes[3] = bits & 0xFF
    this.offset += this.buffer.poke(this.offset, bytes, 4)
  }

  writeF64(value: number): void {
    // Same encoding as C++ circular_buffer_writer: transform then write big-endian.
    this.scratchView.setFloat64(0, value, true)
    let bits = this.scratchView.getBigUint64(0, true)
    const signMask = 0x8000000000000000n
    if ((bits & signMask) !== 0n) {
      bits = (~bits) & 0xFFFFFFFFFFFFFFFFn
    } else {
      bits ^= signMask
    }
    if (value === 0) bits = 0x8000000000000000n
    this.writeBigEndianUint64(bits)
  }

  writeBool(value: boolean): void {
    const bytes = new Uint8Array([value ? 1 : 0])
    this.offset += this.buffer.poke(this.offset, bytes, 1)
  }

  writeString(value: string): void {
    const encoded = this.textEncoder.encode(value)
    this.writeU32(encoded.length)
    this.offset += this.buffer.poke(this.offset, encoded, encoded.length)
  }

  writeBinary(value: ArrayBufferView | ArrayBuffer): void {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    this.writeU32(bytes.length)
    this.offset += this.buffer.poke(this.offset, bytes, bytes.length)
  }

  writeRest(): void {}

  private writeLittleEndianUint64(value: bigint): void {
    const bytes = new Uint8Array(8)
    for (let i = 0; i < 8; ++i) {
      bytes[i] = Number((value >> BigInt(i * 8)) & 0xFFn)
    }
    this.offset += this.buffer.poke(this.offset, bytes, 8)
  }

  private writeBigEndianUint64(value: bigint): void {
    const bytes = new Uint8Array(8)
    for (let i = 0; i < 8; ++i) {
      bytes[i] = Number((value >> BigInt((7 - i) * 8)) & 0xFFn)
    }
    this.offset += this.buffer.poke(this.offset, bytes, 8)
  }

  private toUnsigned(value: bigint | number): bigint {
    const result = BigInt(value)
    if (result < 0n) {
      throw new Error('Unsigned value cannot be negative')
    }
    return result
  }

  private writeUVarInt(value: bigint | number): void {
    if (typeof value === 'number') {
      value = BigInt(value)
    }
    if (value < 0n) {
      throw new Error('UVarInt cannot be negative')
    }
    this.offset += this.buffer.pokeUVarInt(this.offset, value)
  }

  private writeSVarInt(value: bigint): void {
    this.offset += this.buffer.pokeSVarInt(this.offset, value)
  }
}

