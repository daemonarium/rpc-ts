import { expect } from 'chai'
import {
  Writer,
  Reader,
  LocalCircularBuffer,
  LocalCircularBufferWriter,
  LocalCircularBufferReader,
  CodecRegistry,
  TypeDescription,
  TypeKind,
  TypeRegistry,
  serializeValueByType,
  deserializeValueByType,
  type JsonValue,
} from '../src/index.js'

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function writeMapManual(writer: Writer | LocalCircularBufferWriter, entries: Array<[string, number]>): void {
  writer.writeLength(entries.length)
  for (const [k, v] of entries) {
    writer.writeString(k)
    writer.writeI32(v)
  }
}

describe('IWriter/IReader contract (phase 0)', () => {
  const codecs = new CodecRegistry()

  it('writeMap/readMap roundtrip on Writer matches interleaved layout', () => {
    const entries: Array<[string, number]> = [['a', 1], ['b', 2]]

    const viaMap = new Writer(codecs, 64)
    viaMap.writeMap(
      entries,
      (w, k) => w.writeString(k as string),
      (w, v) => w.writeI32(v as number)
    )
    const mapBytes = new Uint8Array(viaMap.toArrayBuffer())

    const viaManual = new Writer(codecs, 64)
    writeMapManual(viaManual, entries)
    const manualBytes = new Uint8Array(viaManual.toArrayBuffer())

    expect(bytesToHex(mapBytes)).to.equal(bytesToHex(manualBytes))

    const reader = new Reader(mapBytes, codecs)
    const out = reader.readMap(
      (r, assign) => assign(r.readString()),
      (r, assign) => assign(r.readI32())
    )
    expect(out).to.deep.equal(entries)
  })

  it('writeMap/readMap roundtrip on LocalCircularBufferWriter/Reader', () => {
    const entries: Array<[string, number]> = [['x', 10], ['y', -3]]
    const buffer = new LocalCircularBuffer(256)
    const writer = new LocalCircularBufferWriter(buffer, codecs, 0)
    writer.writeMap(
      entries,
      (w, k) => w.writeString(k as string),
      (w, v) => w.writeI32(v as number)
    )
    buffer.commitWrite(writer.offset)

    const reader = new LocalCircularBufferReader(buffer, codecs)
    const out = reader.readMap(
      (r, assign) => assign(r.readString()),
      (r, assign) => assign(r.readI32())
    )
    expect(out).to.deep.equal(entries)
  })

  it('empty map encodes only length 0', () => {
    const viaMap = new Writer(codecs, 16)
    viaMap.writeMap([], () => {}, () => {})
    const mapBytes = new Uint8Array(viaMap.toArrayBuffer())

    const viaManual = new Writer(codecs, 16)
    viaManual.writeLength(0)
    const manualBytes = new Uint8Array(viaManual.toArrayBuffer())

    expect(bytesToHex(mapBytes)).to.equal(bytesToHex(manualBytes))

    const reader = new Reader(mapBytes, codecs)
    expect(reader.readMap(() => {}, () => {})).to.deep.equal([])
  })

  it('valueSerialization Map roundtrip via writeMap/readMap', () => {
    const registry = new TypeRegistry()
    const stringType = registry.getTypeByName('string')!
    const i32Type = registry.getTypeByName('sint32')!
    const mapStringI32 = TypeDescription.create({
      name: 'map_string_i32',
      kind: TypeKind.Map,
      key: stringType,
      item: i32Type,
    })
    const mapI32String = TypeDescription.create({
      name: 'map_i32_string',
      kind: TypeKind.Map,
      key: i32Type,
      item: stringType,
    })

    // string-key → plain object on deserialize
    {
      const writer = new Writer(codecs, 64)
      serializeValueByType(writer, registry, mapStringI32, { a: 1, b: 2 })
      writer.writeRest()
      const reader = new Reader(writer.toArrayBuffer(), codecs)
      let result: JsonValue
      deserializeValueByType(reader, registry, mapStringI32, (v) => { result = v })
      reader.readRest()
      expect(result!).to.deep.equal({ a: 1, b: 2 })
    }

    // non-string key → Map
    {
      const writer = new Writer(codecs, 64)
      const input = new Map<number, string>([[1, 'one'], [2, 'two']])
      serializeValueByType(writer, registry, mapI32String, input)
      writer.writeRest()
      const reader = new Reader(writer.toArrayBuffer(), codecs)
      let result: JsonValue
      deserializeValueByType(reader, registry, mapI32String, (v) => { result = v })
      reader.readRest()
      expect(result).to.be.instanceOf(Map)
      expect(Array.from((result as Map<JsonValue, JsonValue>).entries())).to.deep.equal([[1, 'one'], [2, 'two']])
    }
  })

  it('byte-stability: writeMap equals manual interleaved encoding', () => {
    const entries: Array<[string, number]> = [['hello', 42], ['world', -7]]
    const viaMap = new Writer(codecs, 64)
    viaMap.writeMap(
      entries,
      (w, k) => w.writeString(k as string),
      (w, v) => w.writeI32(v as number)
    )
    const viaManual = new Writer(codecs, 64)
    writeMapManual(viaManual, entries)
    expect(bytesToHex(new Uint8Array(viaMap.toArrayBuffer())))
      .to.equal(bytesToHex(new Uint8Array(viaManual.toArrayBuffer())))
  })

  it('reader.saveOffset is a no-op and frames still nest', () => {
    const writer = new Writer(codecs, 32)
    writer.beginFrame()
    writer.writeU32(7)
    writer.endFrame()
    writer.saveOffset()
    const reader = new Reader(writer.toArrayBuffer(), codecs)
    reader.enterFrame()
    expect(reader.readU32()).to.equal(7)
    reader.exitFrame()
    expect(() => reader.saveOffset()).to.not.throw()
  })
})
