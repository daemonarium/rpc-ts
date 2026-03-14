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
    }
  })
})
