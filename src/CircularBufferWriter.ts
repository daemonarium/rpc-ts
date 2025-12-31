import { CircularBuffer } from './CircularBuffer.js'
import { CodecRegistry, type TypedValue } from './codec.js'

type WriteLater = () => void

export class CircularBufferWriter {
  private readonly textEncoder = new TextEncoder()
  private readonly writtenPointers: unknown[] = []
  private readonly pendingPointers: Array<{ value: unknown, writeLater: WriteLater }> = []
  private readonly scratch = new ArrayBuffer(8)
  private readonly scratchView = new DataView(this.scratch)

  constructor(
    private readonly buffer: CircularBuffer,
    private readonly codecs: CodecRegistry
  ) {}

  beginFrame(): void {}

  endFrame(): void {}

  saveOffset(): void {}

  writeU64(value: bigint | number): void {
    this.writeUVarInt(this.toUnsigned(value))
  }

  writeI64(value: bigint | number): void {
    this.writeSVarInt(BigInt(value))
  }

  writeF64(value: number): void {
    this.scratchView.setFloat64(0, value, true)
    let bits = this.scratchView.getBigUint64(0, true)
    const signMask = 0x8000000000000000n
    if ((bits & signMask) !== 0n) {
      bits ^= signMask
    } else {
      bits = (~bits) & 0xFFFFFFFFFFFFFFFFn
    }
    this.writeLittleEndianUint64(bits)
  }

  writeBool(value: boolean): void {
    const bytes = new Uint8Array([value ? 1 : 0])
    this.buffer.write(bytes, 1)
  }

  writeString(value: string): void {
    const encoded = this.textEncoder.encode(value)
    this.writeUVarInt(BigInt(encoded.length))
    this.buffer.write(encoded, encoded.length)
  }

  writeBinary(value: ArrayBufferView | ArrayBuffer): void {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    this.writeUVarInt(BigInt(bytes.length))
    this.buffer.write(bytes, bytes.length)
  }

  writeLength(length: number): void {
    if (length < 0) {
      throw new Error('Length cannot be negative')
    }
    this.writeUVarInt(BigInt(length))
  }

  writeTyped(value: TypedValue): void {
    if (!value || typeof value._type !== 'string') {
      throw new Error('Typed value must provide _type string')
    }
    const index = this.codecs.getIndexOrThrow(value._type)
    this.writeUVarInt(BigInt(index))
    const codec = this.codecs.getByIndex(index)
    codec.serialize(this as any, value)
  }

  writePointer(value: unknown, writeLater: WriteLater): void {
    if (value === null) {
      this.writeSVarInt(0n)
      return
    }
    const existingIndex = this.writtenPointers.indexOf(value)
    if (existingIndex !== -1) {
      const delta = existingIndex - this.writtenPointers.length
      this.writeSVarInt(BigInt(delta))
      return
    }
    const pendingIndex = this.pendingPointers.findIndex(entry => entry.value === value)
    if (pendingIndex !== -1) {
      const delta = pendingIndex + 1
      this.writeSVarInt(BigInt(delta))
      return
    }
    const delta = this.pendingPointers.length + 1
    this.writeSVarInt(BigInt(delta))
    this.pendingPointers.push({ value, writeLater })
  }

  writeRest(): void {
    while (this.pendingPointers.length > 0) {
      const entry = this.pendingPointers.shift()
      if (!entry) continue
      entry.writeLater()
      this.writtenPointers.push(entry.value)
    }
  }

  private writeLittleEndianUint64(value: bigint): void {
    const bytes = new Uint8Array(8)
    for (let i = 0; i < 8; ++i) {
      bytes[i] = Number((value >> BigInt(i * 8)) & 0xFFn)
    }
    this.buffer.write(bytes, 8)
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
    this.buffer.writeUVarInt(value)
  }

  private writeSVarInt(value: bigint): void {
    this.buffer.writeSVarInt(value)
  }
}

