import { expect } from 'chai'
import {
  CodecRegistry,
  TypeDescription,
  TypeKind,
  TypeRegistry,
  KeyWriter,
  KeyReader,
  Writer,
  serializeValueByType,
  deserializeValueByType,
  type JsonValue,
} from '../src/index.js'

function memcmpOrder(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; ++i) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  if (a.length < b.length) return -1
  if (a.length > b.length) return 1
  return 0
}

function keyBytes(
  type: TypeDescription,
  registry: TypeRegistry,
  value: JsonValue,
  codecs = new CodecRegistry()
): Uint8Array {
  const w = new KeyWriter(codecs)
  serializeValueByType(w, registry, type, value)
  return w.finish()
}

function keyRoundtrip(
  type: TypeDescription,
  registry: TypeRegistry,
  value: JsonValue,
  codecs = new CodecRegistry()
): JsonValue {
  const blob = keyBytes(type, registry, value, codecs)
  const r = new KeyReader(blob, codecs)
  let result: JsonValue
  deserializeValueByType(r, registry, type, (v) => { result = v })
  return result!
}

describe('key roundtrip scalars', () => {
  const registry = new TypeRegistry()
  const codecs = new CodecRegistry()

  const cases: Array<{ name: string, value: JsonValue }> = [
    { name: 'uint64', value: 42 },
    { name: 'sint64', value: -7 },
    { name: 'uint32', value: 1000 },
    { name: 'sint32', value: -1000 },
    { name: 'uint16', value: 40000 },
    { name: 'sint16', value: -20000 },
    { name: 'uint8', value: 255 },
    { name: 'sint8', value: -128 },
    { name: 'bool', value: true },
    { name: 'bool', value: false },
    { name: 'float32', value: 3.5 },
    { name: 'float64', value: 2.25 },
  ]

  for (const c of cases) {
    it(`${c.name}=${c.value}`, () => {
      const type = registry.getTypeByName(c.name)!
      expect(keyRoundtrip(type, registry, c.value, codecs)).to.equal(c.value)
    })
  }
})

describe('key roundtrip string binary', () => {
  const registry = new TypeRegistry()
  const codecs = new CodecRegistry()

  it('empty and hello string', () => {
    const str = registry.getTypeByName('string')!
    expect(keyRoundtrip(str, registry, '', codecs)).to.equal('')
    expect(keyRoundtrip(str, registry, 'hello', codecs)).to.equal('hello')
  })

  it('binary', () => {
    const bin = registry.getTypeByName('binary')!
    const value = new Uint8Array([1, 2, 3, 4])
    const out = keyRoundtrip(bin, registry, value, codecs) as Uint8Array
    expect(Array.from(out)).to.deep.equal([1, 2, 3, 4])
  })
})

describe('key roundtrip vector and udt', () => {
  const registry = new TypeRegistry()
  const codecs = new CodecRegistry()

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
  const skill = TypeDescription.create({
    name: 'Skill',
    kind: TypeKind.Object,
    members: [
      { name: 'name', type: registry.getTypeByName('string')!, annotations: [] },
      { name: 'level', type: registry.getTypeByName('sint32')!, annotations: [] },
    ],
  })
  registry.registerType(skill)
  const person = TypeDescription.create({
    name: 'Person',
    kind: TypeKind.Object,
    members: [
      { name: 'name', type: registry.getTypeByName('string')!, annotations: [] },
      { name: 'age', type: registry.getTypeByName('sint32')!, annotations: [] },
      { name: 'skill', type: skill, annotations: [] },
      { name: 'scores', type: i32Arr, annotations: [] },
      { name: 'tags', type: strArr, annotations: [] },
    ],
  })
  registry.registerType(person)

  it('sint32[] and string[]', () => {
    expect(keyRoundtrip(i32Arr, registry, [1, 2, 3], codecs)).to.deep.equal([1, 2, 3])
    expect(keyRoundtrip(strArr, registry, ['a', 'bb', ''], codecs)).to.deep.equal(['a', 'bb', ''])
  })

  it('nested Person UDT', () => {
    const value = {
      name: 'Ada',
      age: 36,
      skill: { name: 'math', level: 10 },
      scores: [1, 2],
      tags: ['x', 'yz'],
    }
    const out = keyRoundtrip(person, registry, value, codecs) as Record<string, unknown>
    expect(out.name).to.equal('Ada')
    expect(out.age).to.equal(36)
    expect((out.skill as Record<string, unknown>).name).to.equal('math')
    expect((out.skill as Record<string, unknown>).level).to.equal(10)
    expect(out.scores).to.deep.equal([1, 2])
    expect(out.tags).to.deep.equal(['x', 'yz'])
  })
})

describe('key sort order', () => {
  const registry = new TypeRegistry()
  const codecs = new CodecRegistry()
  const str = registry.getTypeByName('string')!

  const rec = TypeDescription.create({
    name: 'Rec',
    kind: TypeKind.Object,
    members: [
      { name: 'a', type: str, annotations: [] },
      { name: 'b', type: str, annotations: [] },
    ],
  })
  registry.registerType(rec)

  it('length does not disturb data order (aa < b)', () => {
    const left = { a: 'aa', b: 'z' }
    const right = { a: 'b', b: 'aaaaaaaa' }
    expect(memcmpOrder(keyBytes(rec, registry, left, codecs), keyBytes(rec, registry, right, codecs))).to.be.lessThan(0)

    // Compressed length-prefix: "b"(len1) sorts before "aa"(len2)
    const cwL = new Writer(codecs)
    serializeValueByType(cwL, registry, str, 'aa')
    const cwR = new Writer(codecs)
    serializeValueByType(cwR, registry, str, 'b')
    const cl = new Uint8Array(cwL.toArrayBuffer())
    const cr = new Uint8Array(cwR.toArrayBuffer())
    expect(memcmpOrder(cl, cr)).to.be.greaterThan(0)

    expect(memcmpOrder(keyBytes(str, registry, 'aa', codecs), keyBytes(str, registry, 'b', codecs))).to.be.lessThan(0)
  })

  it('tie on equal concatenated data, different meta', () => {
    const strArr = TypeDescription.create({
      name: 'string[]_sort',
      kind: TypeKind.Array,
      item: str,
    })
    const a = keyBytes(strArr, registry, ['a', 'bc'], codecs)
    const b = keyBytes(strArr, registry, ['ab', 'c'], codecs)
    expect(Buffer.from(a).equals(Buffer.from(b))).to.equal(false)
    const o = memcmpOrder(a, b)
    expect(o).to.not.equal(0)
    expect(memcmpOrder(a, b)).to.equal(o)
  })
})

describe('key unsupported', () => {
  const registry = new TypeRegistry()
  const codecs = new CodecRegistry()

  it('map throws', () => {
    const mapType = TypeDescription.create({
      name: 'string->sint32',
      kind: TypeKind.Map,
      key: registry.getTypeByName('string')!,
      value: registry.getTypeByName('sint32')!,
    })
    const w = new KeyWriter(codecs)
    expect(() => serializeValueByType(w, registry, mapType, [['a', 1]])).to.throw(/map not supported/)
  })

  it('pointer throws', () => {
    const ptr = TypeDescription.create({
      name: 'Person*',
      kind: TypeKind.Pointer,
      pointee: registry.getTypeByName('string')!,
    })
    const w = new KeyWriter(codecs)
    expect(() => serializeValueByType(w, registry, ptr, { _type: 'string', value: 'x' } as never)).to.throw(/pointer not supported/)
  })

  it('writeTyped throws', () => {
    const w = new KeyWriter(codecs)
    expect(() => w.writeTyped({ _type: 'X' })).to.throw(/writeTyped not supported/)
  })
})

describe('key blob layout', () => {
  const codecs = new CodecRegistry()

  it('empty meta still has trailing size 0', () => {
    const registry = new TypeRegistry()
    const blob = keyBytes(registry.getTypeByName('sint32')!, registry, 5, codecs)
    expect(blob.length).to.be.greaterThanOrEqual(1)
    expect(blob[blob.length - 1]).to.equal(0)
  })

  it('meta overflow throws on finish', () => {
    const w = new KeyWriter(codecs)
    for (let i = 0; i < 256; ++i) {
      w.writeLength(0)
    }
    expect(() => w.finish()).to.throw(/meta too large/)
  })

  it('parse rejects tiny / bad meta_size', () => {
    expect(() => new KeyReader(new Uint8Array(0), codecs)).to.throw(/blob too small/)
    expect(() => new KeyReader(new Uint8Array([5]), codecs)).to.throw(/meta_size out of range/)
  })
})
