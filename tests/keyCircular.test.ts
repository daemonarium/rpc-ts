import { expect } from 'chai'
import {
  CodecRegistry,
  TypeDescription,
  TypeKind,
  TypeRegistry,
  LocalCircularBuffer,
  KeyWriter,
  KeyLocalCircularBufferWriter,
  KeyLocalCircularBufferReader,
  serializeValueByType,
  deserializeValueByType,
  type JsonValue,
} from '../src/index.js'

function forceReadNearEnd(cb: LocalCircularBuffer, pad: number): void {
  const junk = new Uint8Array(pad)
  junk.fill(0xCD)
  let written = 0
  while (written < pad) {
    const n = cb.write(junk.subarray(written), pad - written)
    if (n === 0) break
    written += n
  }
  cb.skipRead(written)
}

function placeBlob(blob: Uint8Array, wrap: boolean): LocalCircularBuffer {
  let need = blob.length + (wrap ? 64 : 8)
  if (need < 64) need = 64
  const cb = new LocalCircularBuffer(need)
  if (wrap) {
    let beforeWrap = Math.floor(blob.length / 2)
    if (beforeWrap === 0) beforeWrap = 1
    if (beforeWrap >= blob.length) beforeWrap = blob.length - 1
    const usable = cb.writableBytes() + 1
    forceReadNearEnd(cb, usable - beforeWrap)
  }
  if (cb.writableBytes() < blob.length) {
    cb.grow(cb.capacity() + blob.length)
  }
  const w = cb.write(blob, blob.length)
  expect(w).to.equal(blob.length)
  return cb
}

describe('key circular', () => {
  const registry = new TypeRegistry()
  const codecs = new CodecRegistry()

  const strArr = TypeDescription.create({
    name: 'string[]',
    kind: TypeKind.Array,
    item: registry.getTypeByName('string')!,
  })
  const person = TypeDescription.create({
    name: 'Person',
    kind: TypeKind.Object,
    members: [
      { name: 'name', type: registry.getTypeByName('string')!, annotations: [] },
      { name: 'age', type: registry.getTypeByName('sint32')!, annotations: [] },
      { name: 'tags', type: strArr, annotations: [] },
    ],
  })
  registry.registerType(person)

  it('roundtrip contiguous', () => {
    const cb = new LocalCircularBuffer(256)
    const w = new KeyLocalCircularBufferWriter(cb, codecs)
    serializeValueByType(w, registry, person, {
      name: 'Circ',
      age: 9,
      tags: ['a', 'b'],
    })
    w.finish()
    const len = cb.readableBytes()
    const r = new KeyLocalCircularBufferReader(cb, len, codecs)
    let out: JsonValue
    deserializeValueByType(r, registry, person, (v) => { out = v })
    const o = out! as Record<string, unknown>
    expect(o.name).to.equal('Circ')
    expect(o.age).to.equal(9)
    expect(o.tags).to.deep.equal(['a', 'b'])
  })

  it('roundtrip wrap', () => {
    const value = {
      name: 'Wrap',
      age: 3,
      tags: ['long-tag-value', 'x'],
    }
    const enc = new KeyWriter(codecs)
    serializeValueByType(enc, registry, person, value)
    const blob = enc.finish()
    const cb = placeBlob(blob, true)
    const r = new KeyLocalCircularBufferReader(cb, blob.length, codecs)
    let out: JsonValue
    deserializeValueByType(r, registry, person, (v) => { out = v })
    const o = out! as Record<string, unknown>
    expect(o.name).to.equal('Wrap')
    expect(o.age).to.equal(3)
    expect(o.tags).to.deep.equal(value.tags)
  })

  it('seam smoke across wrap positions', () => {
    const vs = ['hello', 'world']
    const enc = new KeyWriter(codecs)
    serializeValueByType(enc, registry, strArr, vs)
    const blob = enc.finish()
    for (let before = 1; before < blob.length; before += 5) {
      const need = blob.length + 64
      const cb = new LocalCircularBuffer(need)
      const usable = cb.writableBytes() + 1
      let bw = before
      if (bw >= blob.length) bw = blob.length - 1
      forceReadNearEnd(cb, usable - bw)
      if (cb.writableBytes() < blob.length) continue
      cb.write(blob, blob.length)
      const r = new KeyLocalCircularBufferReader(cb, blob.length, codecs)
      let out: JsonValue
      deserializeValueByType(r, registry, strArr, (v) => { out = v })
      expect(out).to.deep.equal(vs)
    }
  })

  it('unsupported map/pointer throw on circular writer', () => {
    const cb = new LocalCircularBuffer(64)
    const mapType = TypeDescription.create({
      name: 'string->sint32',
      kind: TypeKind.Map,
      key: registry.getTypeByName('string')!,
      value: registry.getTypeByName('sint32')!,
    })
    expect(() => {
      const w = new KeyLocalCircularBufferWriter(cb, codecs)
      serializeValueByType(w, registry, mapType, [['k', 1]])
    }).to.throw(/map not supported/)

    const ptr = TypeDescription.create({
      name: 'string*',
      kind: TypeKind.Pointer,
      pointee: registry.getTypeByName('string')!,
    })
    expect(() => {
      const w = new KeyLocalCircularBufferWriter(cb, codecs)
      serializeValueByType(w, registry, ptr, { _type: 'string' } as never)
    }).to.throw(/pointer not supported/)
  })
})
