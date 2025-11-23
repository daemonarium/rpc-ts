import { CodecRegistry, type TypedValue } from './codec.js'

type WriteLater = () => void

export class Writer {
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
    this.writeByte(value ? 1 : 0)
  }

  writeString(value: string): void {
    const encoded = this.textEncoder.encode(value)
    this.writeUVarInt(BigInt(encoded.length))
    this.writeBytes(encoded)
  }

  writeBinary(value: ArrayBufferView | ArrayBuffer): void {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    this.writeUVarInt(BigInt(bytes.length))
    this.writeBytes(bytes)
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
    codec.serialize(this, value)
  }

  writePointer(value: unknown, writeLater: WriteLater): void {
    const existingIndex = this.writtenPointers.indexOf(value)
    if (existingIndex !== -1) {
      const delta = existingIndex - this.writtenPointers.length
      this.writeSVarInt(BigInt(delta))
      return
    }
    const pendingIndex = this.pendingPointers.findIndex(entry => entry.value === value)
    if (pendingIndex !== -1) {
      const index = this.writtenPointers.length + pendingIndex
      const delta = index - this.writtenPointers.length
      this.writeSVarInt(BigInt(delta))
      return
    }
    const index = this.writtenPointers.length + this.pendingPointers.length
    const delta = index - this.writtenPointers.length
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
    this.ensureCapacity(8)
    for (let i = 0; i < 8; ++i) {
      const byte = Number((value >> BigInt(i * 8)) & 0xFFn)
      this.writeByte(byte)
    }
  }

  private toUnsigned(value: bigint | number): bigint {
    const result = BigInt(value)
    if (result < 0n) {
      throw new Error('Unsigned value cannot be negative')
    }
    return result
  }

  private writeUVarInt(value: bigint): void {
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
    if (unsignedValue < 0x40n) {
      const byte = negative
        ? Number((~unsignedValue) & 0x3Fn)
        : Number(0x80n | unsignedValue)
      this.writeByte(byte)
    } else if (unsignedValue < 0x2000n) {
      if (negative) {
        const high = Number(0x40n | (((~unsignedValue) >> 8n) & 0x1Fn))
        const low = Number((~unsignedValue) & 0xFFn)
        this.writeBytes([high, low])
      } else {
        const high = Number(0xC0n | (unsignedValue >> 8n))
        const low = Number(unsignedValue & 0xFFn)
        this.writeBytes([high, low])
      }
    } else if (unsignedValue < 0x100000n) {
      if (negative) {
        const bytes = [
          Number(0x60n | (((~unsignedValue) >> 16n) & 0x0Fn)),
          Number(((~unsignedValue) >> 8n) & 0xFFn),
          Number((~unsignedValue) & 0xFFn)
        ]
        this.writeBytes(bytes)
      } else {
        const bytes = [
          Number(0xE0n | (unsignedValue >> 16n)),
          Number((unsignedValue >> 8n) & 0xFFn),
          Number(unsignedValue & 0xFFn)
        ]
        this.writeBytes(bytes)
      }
    } else if (unsignedValue < 0x8000000n) {
      if (negative) {
        const bytes = [
          Number(0x70n | (((~unsignedValue) >> 24n) & 0x07n)),
          Number(((~unsignedValue) >> 16n) & 0xFFn),
          Number(((~unsignedValue) >> 8n) & 0xFFn),
          Number((~unsignedValue) & 0xFFn)
        ]
        this.writeBytes(bytes)
      } else {
        const bytes = [
          Number(0xF0n | (unsignedValue >> 24n)),
          Number((unsignedValue >> 16n) & 0xFFn),
          Number((unsignedValue >> 8n) & 0xFFn),
          Number(unsignedValue & 0xFFn)
        ]
        this.writeBytes(bytes)
      }
    } else if (unsignedValue < 0x400000000n) {
      if (negative) {
        const bytes = [
          Number(0x78n | (((~unsignedValue) >> 32n) & 0x03n)),
          Number(((~unsignedValue) >> 24n) & 0xFFn),
          Number(((~unsignedValue) >> 16n) & 0xFFn),
          Number(((~unsignedValue) >> 8n) & 0xFFn),
          Number((~unsignedValue) & 0xFFn)
        ]
        this.writeBytes(bytes)
      } else {
        const bytes = [
          Number(0xF8n | (unsignedValue >> 32n)),
          Number((unsignedValue >> 24n) & 0xFFn),
          Number((unsignedValue >> 16n) & 0xFFn),
          Number((unsignedValue >> 8n) & 0xFFn),
          Number(unsignedValue & 0xFFn)
        ]
        this.writeBytes(bytes)
      }
    } else if (unsignedValue < 0x20000000000n) {
      if (negative) {
        const bytes = [
          Number(0x7Cn | (((~unsignedValue) >> 40n) & 0x01n)),
          Number(((~unsignedValue) >> 32n) & 0xFFn),
          Number(((~unsignedValue) >> 24n) & 0xFFn),
          Number(((~unsignedValue) >> 16n) & 0xFFn),
          Number(((~unsignedValue) >> 8n) & 0xFFn),
          Number((~unsignedValue) & 0xFFn)
        ]
        this.writeBytes(bytes)
      } else {
        const bytes = [
          Number(0xFCn | (unsignedValue >> 40n)),
          Number((unsignedValue >> 32n) & 0xFFn),
          Number((unsignedValue >> 24n) & 0xFFn),
          Number((unsignedValue >> 16n) & 0xFFn),
          Number((unsignedValue >> 8n) & 0xFFn),
          Number(unsignedValue & 0xFFn)
        ]
        this.writeBytes(bytes)
      }
    } else if (unsignedValue < 0x1000000000000n) {
      if (negative) {
        const bytes = [
          0x7E,
          Number(((~unsignedValue) >> 40n) & 0xFFn),
          Number(((~unsignedValue) >> 32n) & 0xFFn),
          Number(((~unsignedValue) >> 24n) & 0xFFn),
          Number(((~unsignedValue) >> 16n) & 0xFFn),
          Number(((~unsignedValue) >> 8n) & 0xFFn),
          Number((~unsignedValue) & 0xFFn)
        ]
        this.writeBytes(bytes)
      } else {
        const bytes = [
          0xFE,
          Number((unsignedValue >> 40n) & 0xFFn),
          Number((unsignedValue >> 32n) & 0xFFn),
          Number((unsignedValue >> 24n) & 0xFFn),
          Number((unsignedValue >> 16n) & 0xFFn),
          Number((unsignedValue >> 8n) & 0xFFn),
          Number(unsignedValue & 0xFFn)
        ]
        this.writeBytes(bytes)
      }
    } else {
      if (negative) {
        const bytes = [
          0x7F,
          Number(((~unsignedValue) >> 56n) & 0xFFn),
          Number(((~unsignedValue) >> 48n) & 0xFFn),
          Number(((~unsignedValue) >> 40n) & 0xFFn),
          Number(((~unsignedValue) >> 32n) & 0xFFn),
          Number(((~unsignedValue) >> 24n) & 0xFFn),
          Number(((~unsignedValue) >> 16n) & 0xFFn),
          Number(((~unsignedValue) >> 8n) & 0xFFn),
          Number((~unsignedValue) & 0xFFn)
        ]
        this.writeBytes(bytes)
      } else {
        const bytes = [
          0xFF,
          Number((unsignedValue >> 56n) & 0xFFn),
          Number((unsignedValue >> 48n) & 0xFFn),
          Number((unsignedValue >> 40n) & 0xFFn),
          Number((unsignedValue >> 32n) & 0xFFn),
          Number((unsignedValue >> 24n) & 0xFFn),
          Number((unsignedValue >> 16n) & 0xFFn),
          Number((unsignedValue >> 8n) & 0xFFn),
          Number(unsignedValue & 0xFFn)
        ]
        this.writeBytes(bytes)
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

