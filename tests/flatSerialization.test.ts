import { expect } from 'chai'
import {
  CodecRegistry,
  TypeDescription,
  TypeKind,
  TypeRegistry,
  LocalCircularBuffer,
  serializeValueByType,
  deserializeValueByType,
  registerDynamicCodecs,
  serializeTypedJson,
  deserializeTypedJson,
  FlatWriter,
  FlatReader,
  FlatLocalCircularBufferWriter,
  FlatLocalCircularBufferReader,
  offsetWidth,
  packFormat,
  unpackWidth,
  storeLeU32,
  loadLeU32,
  storeLeI32,
  loadLeI32,
  storeLeF32,
  storeLeF64,
  loadLeF64,
  storeLeI8,
  loadLeI8,
  appendOffsetTable,
  appendOffsetTrailer,
  type JsonValue,
} from '../src/index.js'

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function roundtripByType(
  type: TypeDescription,
  registry: TypeRegistry,
  value: JsonValue,
  codecs = new CodecRegistry()
): JsonValue {
  const writer = new FlatWriter(codecs)
  serializeValueByType(writer, registry, type, value)
  writer.writeRest()
  const reader = new FlatReader(writer.toUint8Array(), codecs)
  let result: JsonValue
  deserializeValueByType(reader, registry, type, (v) => { result = v })
  reader.readRest()
  return result!
}

describe('flatEncoding helpers', () => {
  it('offsetWidth / packFormat / unpackWidth', () => {
    expect(offsetWidth(0)).to.equal(1)
    expect(offsetWidth(255)).to.equal(1)
    expect(offsetWidth(256)).to.equal(2)
    expect(offsetWidth(65535)).to.equal(2)
    expect(offsetWidth(65536)).to.equal(4)
    expect(unpackWidth(packFormat(1))).to.equal(1)
    expect(unpackWidth(packFormat(2))).to.equal(2)
    expect(unpackWidth(packFormat(4))).to.equal(4)
  })

  it('store/load LE roundtrip for u32/i32/f64 including specials', () => {
    const buf = new Uint8Array(8)
    storeLeU32(buf, 0, 0x12345678)
    expect(loadLeU32(buf, 0)).to.equal(0x12345678)

    storeLeI32(buf, 0, -1)
    expect(loadLeI32(buf, 0)).to.equal(-1)

    storeLeF64(buf, 0, Infinity)
    expect(loadLeF64(buf, 0)).to.equal(Infinity)
    storeLeF64(buf, 0, -Infinity)
    expect(loadLeF64(buf, 0)).to.equal(-Infinity)
    storeLeF64(buf, 0, NaN)
    expect(Number.isNaN(loadLeF64(buf, 0))).to.equal(true)

    storeLeI8(buf, 0, -1)
    expect(loadLeI8(buf, 0)).to.equal(-1)
  })

  it('appendOffsetTable / Trailer layout', () => {
    const table: number[] = []
    appendOffsetTable(table, [0, 3, 7])
    expect(table[0]).to.equal(packFormat(1))
    expect(table.slice(1)).to.deep.equal([0, 3, 7])

    const trailer: number[] = []
    appendOffsetTrailer(trailer, [0, 4])
    expect(trailer[0]).to.equal(packFormat(1))
    expect(trailer.slice(1, 3)).to.deep.equal([0, 4])
    expect(trailer[trailer.length - 1]).to.equal(trailer[0])
  })
})

describe('flat scalar LE golden', () => {
  const codecs = new CodecRegistry()

  it('u32 / i8 / f32 match IEEE LE hex', () => {
    const w = new FlatWriter(codecs)
    w.writeU32(0x12345678)
    expect(bytesToHex(w.toUint8Array())).to.equal('78563412')

    const w2 = new FlatWriter(codecs)
    w2.writeI8(-1)
    expect(bytesToHex(w2.toUint8Array())).to.equal('ff')

    const w3 = new FlatWriter(codecs)
    w3.writeF32(1.0)
    expect(bytesToHex(w3.toUint8Array())).to.equal('0000803f')

    const buf = new Uint8Array(4)
    storeLeF32(buf, 0, 1.0)
    expect(bytesToHex(buf)).to.equal('0000803f')
  })

  it('scalar read roundtrip', () => {
    const w = new FlatWriter(codecs)
    w.writeU32(42)
    w.writeI8(-5)
    w.writeF64(Math.PI)
    w.writeBool(true)
    const r = new FlatReader(w.toUint8Array(), codecs)
    expect(r.readU32()).to.equal(42)
    expect(r.readI8()).to.equal(-5)
    expect(r.readF64()).to.equal(Math.PI)
    expect(r.readBool()).to.equal(true)
  })
})

describe('flat string/binary', () => {
  const codecs = new CodecRegistry()

  it('u32 LE length + bytes roundtrip', () => {
    const w = new FlatWriter(codecs)
    w.writeString('hi')
    const bytes = w.toUint8Array()
    expect(bytesToHex(bytes.subarray(0, 4))).to.equal('02000000')
    expect(String.fromCharCode(bytes[4], bytes[5])).to.equal('hi')

    const r = new FlatReader(bytes, codecs)
    expect(r.readString()).to.equal('hi')

    const w2 = new FlatWriter(codecs)
    w2.writeBinary(new Uint8Array([1, 2, 3]))
    const r2 = new FlatReader(w2.toUint8Array(), codecs)
    expect(Array.from(r2.readBinary())).to.deep.equal([1, 2, 3])
  })
})

describe('flat UDT trailer', () => {
  it('Person string+i32 ends with trailer when K>0 and roundtrips', () => {
    const registry = new TypeRegistry()
    const person = TypeDescription.create({
      name: 'Person',
      kind: TypeKind.Object,
      members: [
        { name: 'name', type: registry.getTypeByName('string')!, annotations: [] },
        { name: 'age', type: registry.getTypeByName('sint32')!, annotations: [] },
      ],
    })
    registry.registerType(person)

    const codecs = new CodecRegistry()
    const writer = new FlatWriter(codecs)
    serializeValueByType(writer, registry, person, { name: 'Ada', age: 36 })
    writer.writeRest()
    const bytes = writer.toUint8Array()

    // Trailer: [format][cp…][format] at end (K>=1 from string checkpoint)
    const format = bytes[bytes.length - 1]
    expect(format).to.equal(packFormat(1))
    expect(bytes[bytes.length - 3]).to.equal(format)

    const reader = new FlatReader(bytes, codecs)
    let result: JsonValue
    deserializeValueByType(reader, registry, person, (v) => { result = v })
    reader.readRest()
    expect(result).to.deep.equal({ _type: 'Person', name: 'Ada', age: 36 })
  })
})

describe('flat arrays fixed vs variable', () => {
  it('sint32[] has no inner trailer (K=0); string[] has checkpoints', () => {
    const registry = new TypeRegistry()
    const i32Arr = TypeDescription.create({
      name: 'sint32[]',
      kind: TypeKind.Array,
      item: registry.getTypeByName('sint32')!,
    })
    const strArr = TypeDescription.create({
      name: 'string[]',
      kind: TypeKind.Array,
      item: registry.getTypeByName('string')!,
    })

    const codecs = new CodecRegistry()
    const wFixed = new FlatWriter(codecs)
    serializeValueByType(wFixed, registry, i32Arr, [1, 2, 3])
    const fixedBytes = wFixed.toUint8Array()
    // length 3 + three i32 = 4+12=16, no trailer
    expect(fixedBytes.length).to.equal(16)

    const wVar = new FlatWriter(codecs)
    serializeValueByType(wVar, registry, strArr, ['a', 'bb'])
    const varBytes = wVar.toUint8Array()
    // must be larger than just lengths+chars and end with matching format bytes
    expect(varBytes.length).to.be.greaterThan(4 + 5 + 6)
    expect(varBytes[varBytes.length - 1]).to.equal(varBytes[varBytes.length - 1 - 2 - 1])

    expect(roundtripByType(i32Arr, registry, [10, -1], codecs)).to.deep.equal([10, -1])
    expect(roundtripByType(strArr, registry, ['x', 'yz'], codecs)).to.deep.equal(['x', 'yz'])
  })
})

describe('flat map SoA', () => {
  const codecs = new CodecRegistry()

  it('empty map is only length 0', () => {
    const w = new FlatWriter(codecs)
    w.writeMap([], () => {}, () => {})
    expect(bytesToHex(w.toUint8Array())).to.equal('00000000')
    const r = new FlatReader(w.toUint8Array(), codecs)
    expect(r.readMap(() => {}, () => {})).to.deep.equal([])
  })

  it('string→i32 emits memcmp key order not insertion order', () => {
    // Insertion: zebra, apple. memcmp: apple before zebra
    const entries: Array<[string, number]> = [['zebra', 2], ['apple', 1]]
    const w = new FlatWriter(codecs)
    w.writeMap(
      entries,
      (wr, k) => wr.writeString(k as string),
      (wr, v) => wr.writeI32(v as number)
    )
    const r = new FlatReader(w.toUint8Array(), codecs)
    const out = r.readMap(
      (rd, assign) => assign(rd.readString()),
      (rd, assign) => assign(rd.readI32())
    )
    expect(out).to.deep.equal([['apple', 1], ['zebra', 2]])
  })

  it('valueSerialization map roundtrip to plain object', () => {
    const registry = new TypeRegistry()
    const mapType = TypeDescription.create({
      name: 'map_string_i32',
      kind: TypeKind.Map,
      key: registry.getTypeByName('string')!,
      item: registry.getTypeByName('sint32')!,
    })
    expect(roundtripByType(mapType, registry, { b: 2, a: 1 }, codecs)).to.deep.equal({ a: 1, b: 2 })
  })
})

describe('flat pointer graph', () => {
  it('null pointer and A→B→A cycle preserve identity', () => {
    type Node = { _type: string, label: string, next: Node | null }
    const registry = new TypeRegistry()
    const nodeType = TypeDescription.create({
      name: 'node',
      kind: TypeKind.DynamicObject,
      members: [
        { name: 'label', type: registry.getTypeByName('string')!, annotations: [] },
      ],
    })
    // Flat deferred pointers omit type index; pointee comes from schema (type.item).
    const nodePtr = TypeDescription.create({
      name: 'node*',
      kind: TypeKind.Pointer,
      item: nodeType,
    })
    nodeType.members.push({ name: 'next', type: nodePtr, annotations: [] })
    const rootType = TypeDescription.create({
      name: 'root',
      kind: TypeKind.Object,
      members: [
        { name: 'head', type: nodePtr, annotations: [] },
        { name: 'nullRef', type: nodePtr, annotations: [] },
      ],
    })
    registry.registerType(rootType)
    registry.registerType(nodeType)
    registry.registerType(nodePtr)

    const codecs = new CodecRegistry()
    registerDynamicCodecs(codecs, registry)

    const a: Node = { _type: 'node', label: 'A', next: null }
    const b: Node = { _type: 'node', label: 'B', next: a }
    a.next = b

    const writer = new FlatWriter(codecs)
    serializeTypedJson(writer, registry, {
      _type: 'root',
      head: a,
      nullRef: null,
    } as any)
    writer.writeRest()
    const bytes = writer.toUint8Array()

    const reader = new FlatReader(bytes, codecs)
    const restored = deserializeTypedJson(reader, registry, 'root') as {
      head: Node
      nullRef: null
    }
    reader.readRest()

    expect(restored.nullRef).to.equal(null)
    expect(restored.head.label).to.equal('A')
    expect(restored.head.next!.label).to.equal('B')
    expect(restored.head.next!.next).to.equal(restored.head)
  })
})

describe('flat writeTyped', () => {
  it('emits u32 LE type index then body', () => {
    const registry = new TypeRegistry()
    const box = TypeDescription.create({
      name: 'box',
      kind: TypeKind.DynamicObject,
      members: [
        { name: 'n', type: registry.getTypeByName('sint32')!, annotations: [] },
      ],
    })
    registry.registerType(box)
    const codecs = new CodecRegistry()
    registerDynamicCodecs(codecs, registry)

    const w = new FlatWriter(codecs)
    w.writeTyped({ _type: 'box', n: 7 })
    w.writeRest()
    const bytes = w.toUint8Array()
    const index = codecs.typed.getIndexOrThrow('box')
    expect(loadLeU32(bytes, 0)).to.equal(index)

    const r = new FlatReader(bytes, codecs)
    let out: { n: number } | undefined
    r.readTyped((v) => { out = v as { n: number } })
    r.readRest()
    expect(out!.n).to.equal(7)
  })
})

describe('flat circular + cross medium parity', () => {
  function buildPerson() {
    const registry = new TypeRegistry()
    const person = TypeDescription.create({
      name: 'Person',
      kind: TypeKind.Object,
      members: [
        { name: 'name', type: registry.getTypeByName('string')!, annotations: [] },
        { name: 'age', type: registry.getTypeByName('sint32')!, annotations: [] },
      ],
    })
    registry.registerType(person)
    return { registry, person }
  }

  it('Person/map roundtrip via FlatLocalCircularBuffer* with grow', () => {
    const { registry, person } = buildPerson()
    const mapType = TypeDescription.create({
      name: 'map_string_i32',
      kind: TypeKind.Map,
      key: registry.getTypeByName('string')!,
      item: registry.getTypeByName('sint32')!,
    })
    const codecs = new CodecRegistry()

    // Tiny initial capacity forces grow
    const buffer = new LocalCircularBuffer(32)
    const writer = new FlatLocalCircularBufferWriter(buffer, codecs, 0)
    serializeValueByType(writer, registry, person, { name: 'Eve', age: 21 })
    serializeValueByType(writer, registry, mapType, { z: 9, a: 1 })
    writer.writeRest()
    buffer.commitWrite(writer.offset)

    const reader = new FlatLocalCircularBufferReader(buffer, codecs)
    let p: JsonValue
    deserializeValueByType(reader, registry, person, (v) => { p = v })
    let m: JsonValue
    deserializeValueByType(reader, registry, mapType, (v) => { m = v })
    reader.readRest()
    expect(p).to.deep.equal({ _type: 'Person', name: 'Eve', age: 21 })
    expect(m).to.deep.equal({ a: 1, z: 9 })
  })

  it('ArrayBuffer and circular emit identical bytes for same value', () => {
    const { registry, person } = buildPerson()
    const codecs = new CodecRegistry()
    const value = { name: 'Bob', age: 40 }

    const abWriter = new FlatWriter(codecs)
    serializeValueByType(abWriter, registry, person, value)
    abWriter.writeRest()
    const abBytes = abWriter.toUint8Array()

    const buffer = new LocalCircularBuffer(64)
    const circWriter = new FlatLocalCircularBufferWriter(buffer, codecs, 0)
    serializeValueByType(circWriter, registry, person, value)
    circWriter.writeRest()
    buffer.commitWrite(circWriter.offset)

    const circBytes = new Uint8Array(circWriter.offset)
    expect(buffer.peek(0, circBytes, circBytes.length)).to.equal(circBytes.length)
    expect(bytesToHex(circBytes)).to.equal(bytesToHex(abBytes))
  })
})
