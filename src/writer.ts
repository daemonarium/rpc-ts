import { CodecRegistry, type TypedValue } from './codec.js'
import type { IWriter, WriteLater } from './writerTypes.js'

export class Writer implements IWriter {
  private buffer: Uint8Array
  private view: DataView
  private length = 0
  private readonly textEncoder = new TextEncoder()
  private readonly writtenPointers: unknown[] = []
  private readonly pendingPointers: Array<{ value: unknown, writeLater: WriteLater }> = []
  private readonly scratch = new ArrayBuffer(8)
  private readonly scratchView = new DataView(this.scratch)

  constructor(private readonly codecs: CodecRegistry, initialCapacity = 1024) {
    this.buffer = new Uint8Array(initialCapacity)
    this.view = new DataView(this.buffer.buffer)
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
    this.writeUVarInt(this.toUnsigned(value))
  }

  writeI64(value: bigint | number): void {
    this.writeSVarInt(BigInt(value))
  }

  writeU32(value: number): void {
    if (value < 0 || value > 0xFFFFFFFF) throw new Error('u32 out of range')
    this.writeUVarInt(value >>> 0)
  }

  writeI32(value: number): void {
    if (value < -0x80000000 || value > 0x7FFFFFFF) throw new Error('i32 out of range')
    this.writeSVarInt(BigInt(value))
  }

  writeU16(value: number): void {
    if (value < 0 || value > 0xFFFF) throw new Error('u16 out of range')
    this.writeUVarInt(value & 0xFFFF)
  }

  writeI16(value: number): void {
    if (value < -0x8000 || value > 0x7FFF) throw new Error('i16 out of range')
    this.writeSVarInt(BigInt(value))
  }

  writeU8(value: number): void {
    this.writeByte(value & 0xFF)
  }

  writeI8(value: number): void {
    this.writeByte((value ^ 0x80) & 0xFF)
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
    this.writeByte((bits >> 24) & 0xFF)
    this.writeByte((bits >> 16) & 0xFF)
    this.writeByte((bits >> 8) & 0xFF)
    this.writeByte(bits & 0xFF)
  }

  writeF64(value: number): void {
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

  private writeLittleEndianUint64(value: bigint): void {
    this.ensureCapacity(8)
    for (let i = 0; i < 8; ++i) {
      const byte = Number((value >> BigInt(i * 8)) & 0xFFn)
      this.writeByte(byte)
    }
  }

  private writeBigEndianUint64(value: bigint): void {
    this.ensureCapacity(8)
    for (let i = 7; i >= 0; --i) {
      this.writeByte(Number((value >> BigInt(i * 8)) & 0xFFn))
    }
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
    if (value < 0x80n) {
      this.writeByte(Number(value))
    } else if (value < 0x4000n) {
      const bytes = [
        Number(0x80n | (value >> 8n)),
        Number(value & 0xFFn)
      ]
      this.writeBytes(bytes)
    } else if (value < 0x200000n) {
      const bytes = [
        Number(0xC0n | (value >> 16n)),
        Number((value >> 8n) & 0xFFn),
        Number(value & 0xFFn)
      ]
      this.writeBytes(bytes)
    } else if (value < 0x10000000n) {
      const bytes = [
        Number(0xE0n | (value >> 24n)),
        Number((value >> 16n) & 0xFFn),
        Number((value >> 8n) & 0xFFn),
        Number(value & 0xFFn)
      ]
      this.writeBytes(bytes)
    } else if (value < 0x800000000n) {
      const bytes = [
        Number(0xF0n | (value >> 32n)),
        Number((value >> 24n) & 0xFFn),
        Number((value >> 16n) & 0xFFn),
        Number((value >> 8n) & 0xFFn),
        Number(value & 0xFFn)
      ]
      this.writeBytes(bytes)
    } else if (value < 0x40000000000n) {
      const bytes = [
        Number(0xF8n | (value >> 40n)),
        Number((value >> 32n) & 0xFFn),
        Number((value >> 24n) & 0xFFn),
        Number((value >> 16n) & 0xFFn),
        Number((value >> 8n) & 0xFFn),
        Number(value & 0xFFn)
      ]
      this.writeBytes(bytes)
    } else if (value < 0x2000000000000n) {
      const bytes = [
        Number(0xFCn | (value >> 48n)),
        Number((value >> 40n) & 0xFFn),
        Number((value >> 32n) & 0xFFn),
        Number((value >> 24n) & 0xFFn),
        Number((value >> 16n) & 0xFFn),
        Number((value >> 8n) & 0xFFn),
        Number(value & 0xFFn)
      ]
      this.writeBytes(bytes)
    } else if (value < 0x100000000000000n) {
      const bytes = [
        0xFE,
        Number((value >> 48n) & 0xFFn),
        Number((value >> 40n) & 0xFFn),
        Number((value >> 32n) & 0xFFn),
        Number((value >> 24n) & 0xFFn),
        Number((value >> 16n) & 0xFFn),
        Number((value >> 8n) & 0xFFn),
        Number(value & 0xFFn)
      ]
      this.writeBytes(bytes)
    } else {
      const bytes = [
        0xFF,
        Number((value >> 56n) & 0xFFn),
        Number((value >> 48n) & 0xFFn),
        Number((value >> 40n) & 0xFFn),
        Number((value >> 32n) & 0xFFn),
        Number((value >> 24n) & 0xFFn),
        Number((value >> 16n) & 0xFFn),
        Number((value >> 8n) & 0xFFn),
        Number(value & 0xFFn)
      ]
      this.writeBytes(bytes)
    }
  }

  private writeSVarInt(value: bigint): void {
    const negative = value < 0n
    const unsignedValue = negative ? -value : value
    if (negative) {
      if (unsignedValue < 0x40n) {
        this.writeByte(Number(0x40n | ((~unsignedValue) & 0x3Fn)))
      } else if (unsignedValue < 0x2000n) {
        this.writeBytes([
          Number(0x20n | (((~unsignedValue) >> 8n) & 0x1Fn)),
          Number((~unsignedValue) & 0xFFn)
        ])
      } else if (unsignedValue < 0x100000n) {
        this.writeBytes([
          Number(0x10n | (((~unsignedValue) >> 16n) & 0x0Fn)),
          Number(((~unsignedValue) >> 8n) & 0xFFn),
          Number((~unsignedValue) & 0xFFn)
        ])
      } else if (unsignedValue < 0x8000000n) {
        this.writeBytes([
          Number(0x08n | (((~unsignedValue) >> 24n) & 0x07n)),
          Number(((~unsignedValue) >> 16n) & 0xFFn),
          Number(((~unsignedValue) >> 8n) & 0xFFn),
          Number((~unsignedValue) & 0xFFn)
        ])
      } else if (unsignedValue < 0x400000000n) {
        this.writeBytes([
          Number(0x04n | (((~unsignedValue) >> 32n) & 0x03n)),
          Number(((~unsignedValue) >> 24n) & 0xFFn),
          Number(((~unsignedValue) >> 16n) & 0xFFn),
          Number(((~unsignedValue) >> 8n) & 0xFFn),
          Number((~unsignedValue) & 0xFFn)
        ])
      } else if (unsignedValue < 0x20000000000n) {
        this.writeBytes([
          Number(0x02n | (((~unsignedValue) >> 40n) & 0x01n)),
          Number(((~unsignedValue) >> 32n) & 0xFFn),
          Number(((~unsignedValue) >> 24n) & 0xFFn),
          Number(((~unsignedValue) >> 16n) & 0xFFn),
          Number(((~unsignedValue) >> 8n) & 0xFFn),
          Number((~unsignedValue) & 0xFFn)
        ])
      } else if (unsignedValue < 0x1000000000000n) {
        this.writeBytes([
          0x01,
          Number(((~unsignedValue) >> 40n) & 0xFFn),
          Number(((~unsignedValue) >> 32n) & 0xFFn),
          Number(((~unsignedValue) >> 24n) & 0xFFn),
          Number(((~unsignedValue) >> 16n) & 0xFFn),
          Number(((~unsignedValue) >> 8n) & 0xFFn),
          Number((~unsignedValue) & 0xFFn)
        ])
      } else {
        this.writeBytes([
          0x00,
          Number(((~unsignedValue) >> 56n) & 0xFFn),
          Number(((~unsignedValue) >> 48n) & 0xFFn),
          Number(((~unsignedValue) >> 40n) & 0xFFn),
          Number(((~unsignedValue) >> 32n) & 0xFFn),
          Number(((~unsignedValue) >> 24n) & 0xFFn),
          Number(((~unsignedValue) >> 16n) & 0xFFn),
          Number(((~unsignedValue) >> 8n) & 0xFFn),
          Number((~unsignedValue) & 0xFFn)
        ])
      }
    } else {
      if (unsignedValue < 0x40n) {
        this.writeByte(Number(0x80n | unsignedValue))
      } else if (unsignedValue < 0x2000n) {
        this.writeBytes([
          Number(0xC0n | (unsignedValue >> 8n)),
          Number(unsignedValue & 0xFFn)
        ])
      } else if (unsignedValue < 0x100000n) {
        this.writeBytes([
          Number(0xE0n | (unsignedValue >> 16n)),
          Number((unsignedValue >> 8n) & 0xFFn),
          Number(unsignedValue & 0xFFn)
        ])
      } else if (unsignedValue < 0x8000000n) {
        this.writeBytes([
          Number(0xF0n | (unsignedValue >> 24n)),
          Number((unsignedValue >> 16n) & 0xFFn),
          Number((unsignedValue >> 8n) & 0xFFn),
          Number(unsignedValue & 0xFFn)
        ])
      } else if (unsignedValue < 0x400000000n) {
        this.writeBytes([
          Number(0xF8n | (unsignedValue >> 32n)),
          Number((unsignedValue >> 24n) & 0xFFn),
          Number((unsignedValue >> 16n) & 0xFFn),
          Number((unsignedValue >> 8n) & 0xFFn),
          Number(unsignedValue & 0xFFn)
        ])
      } else if (unsignedValue < 0x20000000000n) {
        this.writeBytes([
          Number(0xFCn | (unsignedValue >> 40n)),
          Number((unsignedValue >> 32n) & 0xFFn),
          Number((unsignedValue >> 24n) & 0xFFn),
          Number((unsignedValue >> 16n) & 0xFFn),
          Number((unsignedValue >> 8n) & 0xFFn),
          Number(unsignedValue & 0xFFn)
        ])
      } else if (unsignedValue < 0x1000000000000n) {
        this.writeBytes([
          0xFE,
          Number((unsignedValue >> 40n) & 0xFFn),
          Number((unsignedValue >> 32n) & 0xFFn),
          Number((unsignedValue >> 24n) & 0xFFn),
          Number((unsignedValue >> 16n) & 0xFFn),
          Number((unsignedValue >> 8n) & 0xFFn),
          Number(unsignedValue & 0xFFn)
        ])
      } else {
        this.writeBytes([
          0xFF,
          Number((unsignedValue >> 56n) & 0xFFn),
          Number((unsignedValue >> 48n) & 0xFFn),
          Number((unsignedValue >> 40n) & 0xFFn),
          Number((unsignedValue >> 32n) & 0xFFn),
          Number((unsignedValue >> 24n) & 0xFFn),
          Number((unsignedValue >> 16n) & 0xFFn),
          Number((unsignedValue >> 8n) & 0xFFn),
          Number(unsignedValue & 0xFFn)
        ])
      }
    }
  }

  private writeByte(value: number): void {
    this.ensureCapacity(1)
    this.buffer[this.length++] = value & 0xFF
  }

  private writeBytes(bytes: Uint8Array | number[]): void {
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
    next.set(this.buffer)
    this.buffer = next
    this.view = new DataView(this.buffer.buffer)
  }
}

