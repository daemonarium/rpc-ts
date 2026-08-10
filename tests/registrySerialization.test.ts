import { expect } from 'chai'
import {
  TypeKind,
  TypeDescription,
  TypeRegistry,
  serializeTypeRegistry,
  deserializeTypeRegistry,
  ensureRpcTypesInRegistry,
  CodecRegistry,
  Writer,
  Reader,
  registerDynamicCodecs,
  serializeTypedJson,
  deserializeTypedJson,
  SerializationFormat,
  packSerializationFormatEnvelope,
  tryUnpackSerializationFormatEnvelope,
} from '../src/index.js'

function memberLinks(registry: TypeRegistry, typeName: string): string[] {
  const obj = registry.getTypes().find((t) => t.name === typeName)
  expect(obj, `missing type ${typeName}`).to.exist
  return (obj!.members ?? []).map((m) => `${m.name}->${m.type.name}`)
}

function buildKvWasmOrder(): TypeRegistry {
  const registry = new TypeRegistry()
  ensureRpcTypesInRegistry(registry)
  const string_ = registry.getTypeByName('string')!
  const void_ = registry.getTypeByName('void')!
  const put = TypeDescription.create({
    name: 'DbgKv.put',
    kind: TypeKind.Function,
    members: [
      { name: 'key', type: string_, annotations: [] },
      { name: 'value', type: string_, annotations: [] },
    ],
    item: void_,
  })
  const get = TypeDescription.create({
    name: 'DbgKv.get',
    kind: TypeKind.Function,
    members: [{ name: 'key', type: string_, annotations: [] }],
    item: string_,
  })
  const keys = TypeDescription.create({
    name: 'DbgKv.keys',
    kind: TypeKind.Function,
    members: [],
    item: string_,
  })
  // WASM type_description::create order: Object first, then Function types
  const api = TypeDescription.create({
    name: 'DbgKv',
    kind: TypeKind.Object,
    members: [
      { name: 'DbgKv.put', type: put, annotations: [] },
      { name: 'DbgKv.get', type: get, annotations: [] },
      { name: 'DbgKv.keys', type: keys, annotations: [] },
    ],
  })
  registry.registerType(api)
  registry.registerType(put)
  registry.registerType(get)
  registry.registerType(keys)
  const memberAnnotation = TypeDescription.create({
    name: 'member_annotation',
    kind: TypeKind.DynamicObject,
    members: [],
  })
  const readAnnotation = TypeDescription.create({
    name: 'read_annotation',
    kind: TypeKind.DynamicObject,
    members: [],
    bases: [memberAnnotation],
  })
  registry.registerType(readAnnotation)
  registry.registerType(memberAnnotation)
  return registry
}

function buildKvHostOrder(): TypeRegistry {
  const registry = new TypeRegistry()
  ensureRpcTypesInRegistry(registry)
  const string_ = registry.getTypeByName('string')!
  const void_ = registry.getTypeByName('void')!
  const put = TypeDescription.create({
    name: 'DbgKv.put',
    kind: TypeKind.Function,
    members: [
      { name: 'key', type: string_, annotations: [] },
      { name: 'value', type: string_, annotations: [] },
    ],
    item: void_,
  })
  const get = TypeDescription.create({
    name: 'DbgKv.get',
    kind: TypeKind.Function,
    members: [{ name: 'key', type: string_, annotations: [] }],
    item: string_,
  })
  const keys = TypeDescription.create({
    name: 'DbgKv.keys',
    kind: TypeKind.Function,
    members: [],
    item: string_,
  })
  // Host registerApi order: Function types first, then Object
  registry.registerType(put)
  registry.registerType(get)
  registry.registerType(keys)
  const api = TypeDescription.create({
    name: 'DbgKv',
    kind: TypeKind.Object,
    members: [
      { name: 'put', type: put, annotations: [] },
      { name: 'get', type: get, annotations: [] },
      { name: 'keys', type: keys, annotations: [] },
    ],
  })
  registry.registerType(api)
  return registry
}

const WASM_LINKS = [
  'DbgKv.put->DbgKv.put',
  'DbgKv.get->DbgKv.get',
  'DbgKv.keys->DbgKv.keys',
]

const HOST_LINKS = [
  'put->DbgKv.put',
  'get->DbgKv.get',
  'keys->DbgKv.keys',
]

describe('TypeRegistry serialize/deserialize', () => {
  it('round-trips WASM order (Object before Function types)', () => {
    const fresh = buildKvWasmOrder()
    expect(memberLinks(fresh, 'DbgKv')).to.deep.equal(WASM_LINKS)

    const restored = deserializeTypeRegistry(serializeTypeRegistry(fresh))
    expect(memberLinks(restored, 'DbgKv')).to.deep.equal(WASM_LINKS)

    restored.assignMethodIds()
    expect(restored.getMethods().map((m) => ({ id: m.methodId, name: m.memberName }))).to.deep.equal([
      { id: 0, name: 'DbgKv.put' },
      { id: 1, name: 'DbgKv.get' },
      { id: 2, name: 'DbgKv.keys' },
    ])
  })

  it('round-trips host order (Function types before Object)', () => {
    const fresh = buildKvHostOrder()
    expect(memberLinks(fresh, 'DbgKv')).to.deep.equal(HOST_LINKS)

    const restored = deserializeTypeRegistry(serializeTypeRegistry(fresh))
    expect(memberLinks(restored, 'DbgKv')).to.deep.equal(HOST_LINKS)

    restored.assignMethodIds()
    expect(restored.getMethods().map((m) => ({ id: m.methodId, name: m.memberName }))).to.deep.equal([
      { id: 0, name: 'put' },
      { id: 1, name: 'get' },
      { id: 2, name: 'keys' },
    ])
  })

  it('double round-trip does not shift member type pointers', () => {
    const once = deserializeTypeRegistry(serializeTypeRegistry(buildKvWasmOrder()))
    expect(memberLinks(once, 'DbgKv')).to.deep.equal(WASM_LINKS)

    const twice = deserializeTypeRegistry(serializeTypeRegistry(once))
    expect(memberLinks(twice, 'DbgKv')).to.deep.equal(WASM_LINKS)
  })

  it('forward-ref during writeRest resolves to the pending child, not parent', () => {
    // Minimal pointer graph: queue parent then child; while writing parent body,
    // emit a forward pointer to child. Reader must restore the same identity.
    type Node = { _type: string, label: string, ref: Node | null }
    const child: Node = { _type: 'node', label: 'child', ref: null }
    const parent: Node = { _type: 'node', label: 'parent', ref: child }

    const meta = new TypeRegistry()
    const nodeType = TypeDescription.create({
      name: 'node',
      kind: TypeKind.DynamicObject,
      members: [
        { name: 'label', type: meta.getTypeByName('string')!, annotations: [] },
        { name: 'ref', type: meta.getTypeByName('pointer')!, annotations: [] },
      ],
    })
    const rootType = TypeDescription.create({
      name: 'root',
      kind: TypeKind.Object,
      members: [
        { name: 'nodes', type: TypeDescription.create({
          name: 'vector<node>',
          kind: TypeKind.Array,
          item: meta.getTypeByName('pointer')!,
        }), annotations: [] },
      ],
    })
    meta.registerType(rootType)
    meta.registerType(nodeType)

    const codecs = new CodecRegistry()
    registerDynamicCodecs(codecs, meta)
    const writer = new Writer(codecs)
    serializeTypedJson(writer, meta, {
      _type: 'root',
      nodes: [parent, child],
    } as any)
    writer.writeRest()
    const bytes = new Uint8Array(writer.toArrayBuffer())

    const reader = new Reader(bytes, codecs)
    const restored = deserializeTypedJson(reader, meta, 'root') as {
      nodes: Array<{ label: string, ref: { label: string } | null }>
    }
    reader.readRest()

    expect(restored.nodes).to.have.length(2)
    expect(restored.nodes[0]!.label).to.equal('parent')
    expect(restored.nodes[0]!.ref).to.equal(restored.nodes[1])
    expect(restored.nodes[0]!.ref!.label).to.equal('child')
  })
})

describe('TypeRegistry dataFormat envelope', () => {
  it('roundtrips Compressed Flat and Key', () => {
    for (const format of [
      SerializationFormat.Compressed,
      SerializationFormat.Flat,
      SerializationFormat.Key,
    ]) {
      const registry = buildKvWasmOrder()
      registry.dataFormat = format
      const bytes = serializeTypeRegistry(registry)
      expect(bytes[0]).to.equal(packSerializationFormatEnvelope(format))
      const restored = deserializeTypeRegistry(bytes)
      expect(restored.dataFormat).to.equal(format)
      expect(memberLinks(restored, 'DbgKv')).to.deep.equal(memberLinks(registry, 'DbgKv'))
    }
  })

  it('legacy blob without envelope deserializes as Compressed', () => {
    const registry = buildKvWasmOrder()
    const withEnvelope = serializeTypeRegistry(registry)
    const legacy = withEnvelope.subarray(1)
    expect(legacy[0] & 0x80).to.equal(0)
    const restored = deserializeTypeRegistry(legacy)
    expect(restored.dataFormat).to.equal(SerializationFormat.Compressed)
  })

  it('rejects reserved bits and unknown format nibble', () => {
    expect(() => tryUnpackSerializationFormatEnvelope(0x90)).to.throw(/reserved/)
    expect(() => tryUnpackSerializationFormatEnvelope(0x83)).to.throw(/unknown format/)
  })
})
