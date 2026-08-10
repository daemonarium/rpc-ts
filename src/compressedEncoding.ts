/**
 * Shared compressed-format scalar encodings (uvarint/svarint, sortable floats, i8^0x80).
 * Used by Writer/Reader and KeyWriter/KeyReader.
 */

export interface ByteSink {
  writeByte(value: number): void
  writeBytes(bytes: Uint8Array | number[]): void
}

export interface ByteCursor {
  readByte(): number
  readMultiple(count: number): number[]
}

/** Growable byte buffer implementing ByteSink. */
export class GrowableByteBuffer implements ByteSink {
  private buffer: Uint8Array
  private length = 0

  constructor(initialCapacity = 64) {
    this.buffer = new Uint8Array(initialCapacity)
  }

  get size(): number {
    return this.length
  }

  writeByte(value: number): void {
    this.ensureCapacity(1)
    this.buffer[this.length++] = value & 0xFF
  }

  writeBytes(bytes: Uint8Array | number[]): void {
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

  toUint8Array(): Uint8Array {
    return this.buffer.subarray(0, this.length)
  }

  private ensureCapacity(extra: number): void {
    const required = this.length + extra
    if (required <= this.buffer.length) return
    let capacity = this.buffer.length * 2
    while (capacity < required) {
      capacity *= 2
    }
    const next = new Uint8Array(capacity)
    next.set(this.buffer.subarray(0, this.length))
    this.buffer = next
  }
}

export function toUnsigned(value: bigint | number): bigint {
  const result = BigInt(value)
  if (result < 0n) {
    throw new Error('Unsigned value cannot be negative')
  }
  return result
}

export function encodeUVarInt(sink: ByteSink, value: bigint | number): void {
  if (typeof value === 'number') {
    value = BigInt(value)
  }
  if (value < 0n) {
    throw new Error('UVarInt cannot be negative')
  }
  if (value < 0x80n) {
    sink.writeByte(Number(value))
  } else if (value < 0x4000n) {
    sink.writeBytes([
      Number(0x80n | (value >> 8n)),
      Number(value & 0xFFn)
    ])
  } else if (value < 0x200000n) {
    sink.writeBytes([
      Number(0xC0n | (value >> 16n)),
      Number((value >> 8n) & 0xFFn),
      Number(value & 0xFFn)
    ])
  } else if (value < 0x10000000n) {
    sink.writeBytes([
      Number(0xE0n | (value >> 24n)),
      Number((value >> 16n) & 0xFFn),
      Number((value >> 8n) & 0xFFn),
      Number(value & 0xFFn)
    ])
  } else if (value < 0x800000000n) {
    sink.writeBytes([
      Number(0xF0n | (value >> 32n)),
      Number((value >> 24n) & 0xFFn),
      Number((value >> 16n) & 0xFFn),
      Number((value >> 8n) & 0xFFn),
      Number(value & 0xFFn)
    ])
  } else if (value < 0x40000000000n) {
    sink.writeBytes([
      Number(0xF8n | (value >> 40n)),
      Number((value >> 32n) & 0xFFn),
      Number((value >> 24n) & 0xFFn),
      Number((value >> 16n) & 0xFFn),
      Number((value >> 8n) & 0xFFn),
      Number(value & 0xFFn)
    ])
  } else if (value < 0x2000000000000n) {
    sink.writeBytes([
      Number(0xFCn | (value >> 48n)),
      Number((value >> 40n) & 0xFFn),
      Number((value >> 32n) & 0xFFn),
      Number((value >> 24n) & 0xFFn),
      Number((value >> 16n) & 0xFFn),
      Number((value >> 8n) & 0xFFn),
      Number(value & 0xFFn)
    ])
  } else if (value < 0x100000000000000n) {
    sink.writeBytes([
      0xFE,
      Number((value >> 48n) & 0xFFn),
      Number((value >> 40n) & 0xFFn),
      Number((value >> 32n) & 0xFFn),
      Number((value >> 24n) & 0xFFn),
      Number((value >> 16n) & 0xFFn),
      Number((value >> 8n) & 0xFFn),
      Number(value & 0xFFn)
    ])
  } else {
    sink.writeBytes([
      0xFF,
      Number((value >> 56n) & 0xFFn),
      Number((value >> 48n) & 0xFFn),
      Number((value >> 40n) & 0xFFn),
      Number((value >> 32n) & 0xFFn),
      Number((value >> 24n) & 0xFFn),
      Number((value >> 16n) & 0xFFn),
      Number((value >> 8n) & 0xFFn),
      Number(value & 0xFFn)
    ])
  }
}

export function encodeSVarInt(sink: ByteSink, value: bigint): void {
  const negative = value < 0n
  const unsignedValue = negative ? -value : value
  if (negative) {
    if (unsignedValue < 0x40n) {
      sink.writeByte(Number(0x40n | ((~unsignedValue) & 0x3Fn)))
    } else if (unsignedValue < 0x2000n) {
      sink.writeBytes([
        Number(0x20n | (((~unsignedValue) >> 8n) & 0x1Fn)),
        Number((~unsignedValue) & 0xFFn)
      ])
    } else if (unsignedValue < 0x100000n) {
      sink.writeBytes([
        Number(0x10n | (((~unsignedValue) >> 16n) & 0x0Fn)),
        Number(((~unsignedValue) >> 8n) & 0xFFn),
        Number((~unsignedValue) & 0xFFn)
      ])
    } else if (unsignedValue < 0x8000000n) {
      sink.writeBytes([
        Number(0x08n | (((~unsignedValue) >> 24n) & 0x07n)),
        Number(((~unsignedValue) >> 16n) & 0xFFn),
        Number(((~unsignedValue) >> 8n) & 0xFFn),
        Number((~unsignedValue) & 0xFFn)
      ])
    } else if (unsignedValue < 0x400000000n) {
      sink.writeBytes([
        Number(0x04n | (((~unsignedValue) >> 32n) & 0x03n)),
        Number(((~unsignedValue) >> 24n) & 0xFFn),
        Number(((~unsignedValue) >> 16n) & 0xFFn),
        Number(((~unsignedValue) >> 8n) & 0xFFn),
        Number((~unsignedValue) & 0xFFn)
      ])
    } else if (unsignedValue < 0x20000000000n) {
      sink.writeBytes([
        Number(0x02n | (((~unsignedValue) >> 40n) & 0x01n)),
        Number(((~unsignedValue) >> 32n) & 0xFFn),
        Number(((~unsignedValue) >> 24n) & 0xFFn),
        Number(((~unsignedValue) >> 16n) & 0xFFn),
        Number(((~unsignedValue) >> 8n) & 0xFFn),
        Number((~unsignedValue) & 0xFFn)
      ])
    } else if (unsignedValue < 0x1000000000000n) {
      sink.writeBytes([
        0x01,
        Number(((~unsignedValue) >> 40n) & 0xFFn),
        Number(((~unsignedValue) >> 32n) & 0xFFn),
        Number(((~unsignedValue) >> 24n) & 0xFFn),
        Number(((~unsignedValue) >> 16n) & 0xFFn),
        Number(((~unsignedValue) >> 8n) & 0xFFn),
        Number((~unsignedValue) & 0xFFn)
      ])
    } else {
      sink.writeBytes([
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
      sink.writeByte(Number(0x80n | unsignedValue))
    } else if (unsignedValue < 0x2000n) {
      sink.writeBytes([
        Number(0xC0n | (unsignedValue >> 8n)),
        Number(unsignedValue & 0xFFn)
      ])
    } else if (unsignedValue < 0x100000n) {
      sink.writeBytes([
        Number(0xE0n | (unsignedValue >> 16n)),
        Number((unsignedValue >> 8n) & 0xFFn),
        Number(unsignedValue & 0xFFn)
      ])
    } else if (unsignedValue < 0x8000000n) {
      sink.writeBytes([
        Number(0xF0n | (unsignedValue >> 24n)),
        Number((unsignedValue >> 16n) & 0xFFn),
        Number((unsignedValue >> 8n) & 0xFFn),
        Number(unsignedValue & 0xFFn)
      ])
    } else if (unsignedValue < 0x400000000n) {
      sink.writeBytes([
        Number(0xF8n | (unsignedValue >> 32n)),
        Number((unsignedValue >> 24n) & 0xFFn),
        Number((unsignedValue >> 16n) & 0xFFn),
        Number((unsignedValue >> 8n) & 0xFFn),
        Number(unsignedValue & 0xFFn)
      ])
    } else if (unsignedValue < 0x20000000000n) {
      sink.writeBytes([
        Number(0xFCn | (unsignedValue >> 40n)),
        Number((unsignedValue >> 32n) & 0xFFn),
        Number((unsignedValue >> 24n) & 0xFFn),
        Number((unsignedValue >> 16n) & 0xFFn),
        Number((unsignedValue >> 8n) & 0xFFn),
        Number(unsignedValue & 0xFFn)
      ])
    } else if (unsignedValue < 0x1000000000000n) {
      sink.writeBytes([
        0xFE,
        Number((unsignedValue >> 40n) & 0xFFn),
        Number((unsignedValue >> 32n) & 0xFFn),
        Number((unsignedValue >> 24n) & 0xFFn),
        Number((unsignedValue >> 16n) & 0xFFn),
        Number((unsignedValue >> 8n) & 0xFFn),
        Number(unsignedValue & 0xFFn)
      ])
    } else {
      sink.writeBytes([
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

export function encodeSortableF32(sink: ByteSink, value: number, scratchView: DataView): void {
  scratchView.setFloat32(0, value, true)
  let bits = scratchView.getUint32(0, true)
  if ((bits & 0x80000000) !== 0) {
    bits = (~bits) >>> 0
  } else {
    bits ^= 0x80000000
  }
  if (value === 0) bits = 0x80000000
  sink.writeByte((bits >> 24) & 0xFF)
  sink.writeByte((bits >> 16) & 0xFF)
  sink.writeByte((bits >> 8) & 0xFF)
  sink.writeByte(bits & 0xFF)
}

export function encodeSortableF64(sink: ByteSink, value: number, scratchView: DataView): void {
  scratchView.setFloat64(0, value, true)
  let bits = scratchView.getBigUint64(0, true)
  const signMask = 0x8000000000000000n
  if ((bits & signMask) !== 0n) {
    bits = (~bits) & 0xFFFFFFFFFFFFFFFFn
  } else {
    bits ^= signMask
  }
  if (value === 0) bits = 0x8000000000000000n
  for (let i = 7; i >= 0; --i) {
    sink.writeByte(Number((bits >> BigInt(i * 8)) & 0xFFn))
  }
}

export function encodeI8(sink: ByteSink, value: number): void {
  sink.writeByte((value ^ 0x80) & 0xFF)
}

export function decodeUVarInt(cursor: ByteCursor): number | bigint {
  const first = cursor.readByte()
  if ((first & 0x80) === 0) {
    return first
  }
  if ((first & 0x40) === 0) {
    const second = cursor.readByte()
    return ((first & 0x3F) << 8) | second
  }
  if ((first & 0x20) === 0) {
    const second = cursor.readByte()
    const third = cursor.readByte()
    return ((first & 0x1F) << 16) | (second << 8) | third
  }
  if ((first & 0x10) === 0) {
    const b1 = cursor.readByte()
    const b2 = cursor.readByte()
    const b3 = cursor.readByte()
    return ((first & 0x0F) << 24) | (b1 << 16) | (b2 << 8) | b3
  }
  if ((first & 0x08) === 0) {
    const b = cursor.readMultiple(4)
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
    const b = cursor.readMultiple(5)
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
    const b = cursor.readMultiple(6)
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
    const b = cursor.readMultiple(7)
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
  const b = cursor.readMultiple(8)
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

export function decodeSVarInt(cursor: ByteCursor): number | bigint {
  const first = cursor.readByte()
  const negative = (first & 0x80) === 0
  if (negative) {
    if ((first & 0x40) !== 0) {
      return -((~first) & 0x3F)
    }
    if ((first & 0xE0) === 0x20) {
      const second = cursor.readByte()
      const encoded = ((first & 0x1F) << 8) | second
      return -(0x1FFF - encoded)
    }
    if ((first & 0xF0) === 0x10) {
      const b = cursor.readMultiple(2)
      const encoded = ((first & 0x0F) << 16) | (b[0] << 8) | b[1]
      return -(0xFFFFF - encoded)
    }
    if ((first & 0xF8) === 0x08) {
      const b = cursor.readMultiple(3)
      const encoded = ((first & 0x07) << 24) | (b[0] << 16) | (b[1] << 8) | b[2]
      return -(0x7FFFFFF - encoded)
    }
    if ((first & 0xFC) === 0x04) {
      const b = cursor.readMultiple(4)
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
      const b = cursor.readMultiple(5)
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
      const b = cursor.readMultiple(6)
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
    const b = cursor.readMultiple(8)
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
      const second = cursor.readByte()
      return ((first & 0x1F) << 8) | second
    }
    if ((first & 0x10) === 0) {
      const b = cursor.readMultiple(2)
      return ((first & 0x0F) << 16) | (b[0] << 8) | b[1]
    }
    if ((first & 0x08) === 0) {
      const b = cursor.readMultiple(3)
      return ((first & 0x07) << 24) | (b[0] << 16) | (b[1] << 8) | b[2]
    }
    if ((first & 0x04) === 0) {
      const b = cursor.readMultiple(4)
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
      const b = cursor.readMultiple(5)
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
      const b = cursor.readMultiple(6)
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
    const b = cursor.readMultiple(8)
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

export function decodeSortableF32(cursor: ByteCursor, scratchView: DataView): number {
  const b0 = cursor.readByte()
  const b1 = cursor.readByte()
  const b2 = cursor.readByte()
  const b3 = cursor.readByte()
  let v = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3
  if ((v & 0x80000000) !== 0) {
    v ^= 0x80000000
  } else {
    v = (~v) >>> 0
  }
  scratchView.setUint32(0, v, true)
  return scratchView.getFloat32(0, true)
}

export function decodeSortableF64(cursor: ByteCursor, scratchView: DataView): number {
  let bits = 0n
  for (let i = 0; i < 8; ++i) {
    bits = (bits << 8n) | BigInt(cursor.readByte())
  }
  const signMask = 0x8000000000000000n
  if ((bits & signMask) !== 0n) {
    bits ^= signMask
  } else {
    bits = (~bits) & 0xFFFFFFFFFFFFFFFFn
  }
  scratchView.setBigUint64(0, bits, true)
  return scratchView.getFloat64(0, true)
}

export function decodeI8(cursor: ByteCursor): number {
  return (cursor.readByte() ^ 0x80) << 24 >> 24
}
