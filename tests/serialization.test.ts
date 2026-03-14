import { readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { expect } from 'chai'

import {
  LocalCircularBuffer,
  CircularBufferReader,
  LocalCircularBufferWriter,
  CodecRegistry,
} from '../src/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

type RowType = 'u64' | 'i64' | 'f64'

function parseExpectedValue(type: RowType, valueStr: string): number | bigint {
  if (type === 'f64') {
    if (valueStr === 'inf') return Infinity
    if (valueStr === '-inf') return -Infinity
    if (valueStr === 'nan') return NaN
    return Number(valueStr)
  }
  return BigInt(valueStr)
}

function valuesEqual(type: RowType, expected: number | bigint, actual: number | bigint): boolean {
  if (type === 'f64') {
    const e = expected as number
    const a = actual as number
    if (Number.isNaN(e)) return Number.isNaN(a)
    return e === a
  }
  return BigInt(expected) === BigInt(actual)
}

describe('serialization reference (C++ TSV)', () => {
  let rows: Array<{ type: RowType; valueStr: string; hex: string }>

  before(async () => {
    const path = join(__dirname, 'serialization_reference.tsv')
    const content = await readFile(path, 'utf-8')
    rows = content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [type, valueStr, hex] = line.split('\t')
        return { type: type as RowType, valueStr: valueStr!, hex: hex! }
      })
  })

  it('deserializes each reference row to the expected value', () => {
    const codecs = new CodecRegistry()
    for (const { type, valueStr, hex } of rows) {
      const buffer = new LocalCircularBuffer(64)
      const bytes = hexToBytes(hex)
      buffer.write(bytes, bytes.length)

      const reader = new CircularBufferReader(buffer, codecs)
      let actual: number | bigint
      if (type === 'u64') {
        actual = reader.readU64()
      } else if (type === 'i64') {
        actual = reader.readI64()
      } else {
        actual = reader.readF64()
      }

      const expected = parseExpectedValue(type, valueStr)
      expect(valuesEqual(type, expected, actual), `type=${type} valueStr=${valueStr}`).to.be.true
    }
  })

  it('serializes each reference value to the expected hex', () => {
    const codecs = new CodecRegistry()
    for (const { type, valueStr, hex } of rows) {
      const expected = parseExpectedValue(type, valueStr)
      const buffer = new LocalCircularBuffer(64)
      const writer = new LocalCircularBufferWriter(buffer, codecs, 0)

      if (type === 'u64') {
        writer.writeU64(expected as bigint)
      } else if (type === 'i64') {
        writer.writeI64(expected as bigint)
      } else {
        writer.writeF64(expected as number)
      }

      buffer.commitWrite(writer.offset)
      const dest = new Uint8Array(writer.offset)
      buffer.peek(0, dest, writer.offset)
      const actualHex = bytesToHex(dest)
      expect(actualHex).to.equal(hex.toLowerCase())
    }
  })
})

describe('serialization sort order', () => {
  const codecs = new CodecRegistry()

  function u64ToBytes(value: bigint | number): Uint8Array {
    const buffer = new LocalCircularBuffer(32)
    const writer = new LocalCircularBufferWriter(buffer, codecs, 0)
    writer.writeU64(typeof value === 'number' ? BigInt(value) : value)
    buffer.commitWrite(writer.offset)
    const dest = new Uint8Array(writer.offset)
    buffer.peek(0, dest, writer.offset)
    return dest
  }

  function i64ToBytes(value: bigint | number): Uint8Array {
    const buffer = new LocalCircularBuffer(32)
    const writer = new LocalCircularBufferWriter(buffer, codecs, 0)
    writer.writeI64(typeof value === 'number' ? BigInt(value) : value)
    buffer.commitWrite(writer.offset)
    const dest = new Uint8Array(writer.offset)
    buffer.peek(0, dest, writer.offset)
    return dest
  }

  function f64ToBytes(value: number): Uint8Array {
    const buffer = new LocalCircularBuffer(16)
    const writer = new LocalCircularBufferWriter(buffer, codecs, 0)
    writer.writeF64(value)
    buffer.commitWrite(8)
    const dest = new Uint8Array(8)
    buffer.peek(0, dest, 8)
    return dest
  }

  function compareBytes(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
    }
    if (a.length < b.length) return -1
    if (a.length > b.length) return 1
    return 0
  }

  function threeWayCmp(a: number, b: number): number {
    if (a < b) return -1
    if (a > b) return 1
    return 0
  }

  it('preserves sort order for u64 (uvarint)', () => {
    const uvals: bigint[] = [
      0n, 1n, 2n, 3n, 126n, 127n, 128n, 129n, 255n, 256n,
      0x3FFEn, 0x3FFFn, 0x4000n, 0x4001n,
      0x1FFFFEn, 0x1FFFFFn, 0x200000n, 0x200001n,
      0x10000000n - 1n, 0x10000000n, 0x10000001n,
      100n, 1000n, 1000000n, 1000000000n,
      0xFFFFFFFFn, 0x100000000n, 0x100000001n,
      0xFFFFFFFFFFFFFFFFn
    ]
    for (let i = 0; i < uvals.length; i++) {
      for (let j = 0; j < uvals.length; j++) {
        const a = uvals[i]
        const b = uvals[j]
        const cmpVal = a < b ? -1 : a > b ? 1 : 0
        const cmpBytes = compareBytes(u64ToBytes(a), u64ToBytes(b))
        expect(cmpBytes, `u64 ${a} vs ${b}`).to.equal(cmpVal)
      }
    }
  })

  it('preserves sort order for i64 (svarint)', () => {
    const svals: bigint[] = [
      0n, 1n, -1n, 2n, -2n, 62n, 63n, -63n, -64n, 64n, 65n,
      127n, -127n, 128n, -128n, 129n, -129n,
      0x1FFFn, 0x2000n, -0x2000n, -0x2001n,
      0x7FFFFFFFn, -0x80000000n,
      1000000n, -1000000n,
      0x7FFFFFFFFFFFFFFFn, -0x8000000000000000n
    ]
    for (let i = 0; i < svals.length; i++) {
      for (let j = 0; j < svals.length; j++) {
        const a = svals[i]
        const b = svals[j]
        const cmpVal = a < b ? -1 : a > b ? 1 : 0
        const cmpBytes = compareBytes(i64ToBytes(a), i64ToBytes(b))
        expect(cmpBytes, `i64 ${a} vs ${b}`).to.equal(cmpVal)
      }
    }
  })

  it('preserves sort order for f64 (float64)', () => {
    const fvals = [
      -Infinity,
      -1e308, -1e100, -1e10, -1000, -1.5, -1, -0.5, -1e-10, -1e-308,
      -0, 0,
      1e-308, 1e-10, 0.5, 1, 1.5, 1000, 1e10, 1e100, 1e308,
      Infinity
    ]
    for (let i = 0; i < fvals.length; i++) {
      for (let j = 0; j < fvals.length; j++) {
        const a = fvals[i]
        const b = fvals[j]
        const cmpVal = threeWayCmp(a, b)
        const cmpBytes = compareBytes(f64ToBytes(a), f64ToBytes(b))
        expect(cmpBytes, `f64 ${a} vs ${b}`).to.equal(cmpVal)
      }
    }
  })

  it('NaN serializes to same bytes', () => {
    const nan = NaN
    expect(compareBytes(f64ToBytes(nan), f64ToBytes(nan))).to.equal(0)
  })
})

describe('circular buffer roundtrip', () => {
  const codecs = new CodecRegistry()
  const defaultBufSize = 8192

  function roundtrip(
    bufSize: number,
    write: (w: LocalCircularBufferWriter) => void,
    read: (r: CircularBufferReader) => unknown
  ): unknown {
    const buffer = new LocalCircularBuffer(bufSize)
    const writer = new LocalCircularBufferWriter(buffer, codecs, 0)
    write(writer)
    buffer.commitWrite(writer.offset)
    const reader = new CircularBufferReader(buffer, codecs)
    const result = read(reader)
    reader.readRest()
    return result
  }

  it('roundtrips u64 (small and large)', () => {
    const u = (v: unknown) => BigInt(v as number | bigint)
    expect(u(roundtrip(defaultBufSize, (w) => w.writeU64(0n), (r) => r.readU64()))).to.equal(0n)
    expect(u(roundtrip(defaultBufSize, (w) => w.writeU64(1n), (r) => r.readU64()))).to.equal(1n)
    expect(u(roundtrip(defaultBufSize, (w) => w.writeU64(42n), (r) => r.readU64()))).to.equal(42n)
    expect(u(roundtrip(defaultBufSize, (w) => w.writeU64(127n), (r) => r.readU64()))).to.equal(127n)
    expect(u(roundtrip(defaultBufSize, (w) => w.writeU64(128n), (r) => r.readU64()))).to.equal(128n)
    expect(u(roundtrip(defaultBufSize, (w) => w.writeU64(0xFFFFFFFFFFFFFFFFn), (r) => r.readU64()))).to.equal(0xFFFFFFFFFFFFFFFFn)
  })

  it('roundtrips i64', () => {
    const i = (v: unknown) => BigInt(v as number | bigint)
    expect(i(roundtrip(defaultBufSize, (w) => w.writeI64(0n), (r) => r.readI64()))).to.equal(0n)
    expect(i(roundtrip(defaultBufSize, (w) => w.writeI64(1n), (r) => r.readI64()))).to.equal(1n)
    expect(i(roundtrip(defaultBufSize, (w) => w.writeI64(-1n), (r) => r.readI64()))).to.equal(-1n)
    expect(i(roundtrip(defaultBufSize, (w) => w.writeI64(63n), (r) => r.readI64()))).to.equal(63n)
    expect(i(roundtrip(defaultBufSize, (w) => w.writeI64(-64n), (r) => r.readI64()))).to.equal(-64n)
    expect(i(roundtrip(defaultBufSize, (w) => w.writeI64(1000000n), (r) => r.readI64()))).to.equal(1000000n)
    expect(i(roundtrip(defaultBufSize, (w) => w.writeI64(-1000000n), (r) => r.readI64()))).to.equal(-1000000n)
  })

  it('roundtrips f64 (including inf, -inf, NaN)', () => {
    expect(roundtrip(defaultBufSize, (w) => w.writeF64(0), (r) => r.readF64())).to.equal(0)
    expect(roundtrip(defaultBufSize, (w) => w.writeF64(1.5), (r) => r.readF64())).to.equal(1.5)
    expect(roundtrip(defaultBufSize, (w) => w.writeF64(-1.5), (r) => r.readF64())).to.equal(-1.5)
    expect(roundtrip(defaultBufSize, (w) => w.writeF64(3.14159265358979), (r) => r.readF64())).to.equal(3.14159265358979)
    expect(roundtrip(defaultBufSize, (w) => w.writeF64(-Infinity), (r) => r.readF64())).to.equal(-Infinity)
    expect(roundtrip(defaultBufSize, (w) => w.writeF64(Infinity), (r) => r.readF64())).to.equal(Infinity)
    expect(Number.isNaN(roundtrip(defaultBufSize, (w) => w.writeF64(NaN), (r) => r.readF64()) as number)).to.be.true
  })

  it('roundtrips bool', () => {
    expect(roundtrip(defaultBufSize, (w) => w.writeBool(true), (r) => r.readBool())).to.equal(true)
    expect(roundtrip(defaultBufSize, (w) => w.writeBool(false), (r) => r.readBool())).to.equal(false)
  })

  it('roundtrips string', () => {
    expect(roundtrip(defaultBufSize, (w) => w.writeString(''), (r) => r.readString())).to.equal('')
    expect(roundtrip(defaultBufSize, (w) => w.writeString('hello'), (r) => r.readString())).to.equal('hello')
    const longStr = 'x'.repeat(200)
    expect(roundtrip(defaultBufSize, (w) => w.writeString(longStr), (r) => r.readString())).to.equal(longStr)
  })

  it('roundtrips binary', () => {
    const empty = new Uint8Array(0)
    expect(roundtrip(defaultBufSize, (w) => w.writeBinary(empty), (r) => r.readBinary())).to.deep.equal(empty)
    const data = new Uint8Array(4096)
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff
    expect(roundtrip(defaultBufSize, (w) => w.writeBinary(data), (r) => r.readBinary())).to.deep.equal(data)
  })

  it('multiple values in sequence', () => {
    const buffer = new LocalCircularBuffer(8192)
    const writer = new LocalCircularBufferWriter(buffer, codecs, 0)
    writer.writeU64(42n)
    writer.writeString('hello')
    writer.writeBool(true)
    writer.writeI64(-7n)
    buffer.commitWrite(writer.offset)

    const reader = new CircularBufferReader(buffer, codecs)
    const u = BigInt(reader.readU64())
    const s = reader.readString()
    const b = reader.readBool()
    const i = BigInt(reader.readI64())
    reader.readRest()

    expect(u).to.equal(42n)
    expect(s).to.equal('hello')
    expect(b).to.equal(true)
    expect(i).to.equal(-7n)
  })

  it('small buffer (growth)', () => {
    const bufSize = 128
    const count = 100
    const buffer = new LocalCircularBuffer(bufSize)
    const writer = new LocalCircularBufferWriter(buffer, codecs, 0)
    for (let i = 0; i < count; i++) {
      writer.writeU64(BigInt(i * 1000))
    }
    buffer.commitWrite(writer.offset)

    const reader = new CircularBufferReader(buffer, codecs)
    const read: bigint[] = []
    for (let i = 0; i < count; i++) {
      read.push(BigInt(reader.readU64()))
    }
    reader.readRest()

    for (let i = 0; i < count; i++) {
      expect(read[i]).to.equal(BigInt(i * 1000))
    }
  })
})

describe('LocalCircularBuffer chunked I/O', () => {
  const payloadSize = 4096
  // Buffer large enough to hold payload so chunked write/read exercise wrap via read drain
  const initialBufferSize = payloadSize

  it('pumps data with chunked write and read', () => {
    const data = new Uint8Array(payloadSize)
    for (let i = 0; i < payloadSize; i++) data[i] = i & 0xff

    const buffer = new LocalCircularBuffer(initialBufferSize)
    const received = new Uint8Array(payloadSize)
    const writeChunks = [1, 7, 31, 256]
    const readChunks = [3, 17, 64, 512]
    let writeOffset = 0
    let readOffset = 0
    let wi = 0
    let ri = 0

    while (readOffset < payloadSize) {
      if (writeOffset < payloadSize) {
        const chunk = Math.min(payloadSize - writeOffset, writeChunks[wi % writeChunks.length])
        const src = data.subarray(writeOffset, writeOffset + chunk)
        const n = buffer.write(src, chunk)
        writeOffset += n
        if (n > 0) wi++
      }
      if (readOffset < payloadSize) {
        const chunk = Math.min(payloadSize - readOffset, readChunks[ri % readChunks.length])
        const n = buffer.read(received.subarray(readOffset, readOffset + chunk), chunk)
        readOffset += n
        if (n > 0) ri++
      }
    }

    expect(writeOffset).to.equal(payloadSize)
    expect(readOffset).to.equal(payloadSize)
    expect(Array.from(received)).to.deep.equal(Array.from(data))
  })
})
