import { expect } from 'chai'
import {
  TypeKind,
  TypeDescription,
  TypeRegistry,
  serializeTypeRegistry,
  deserializeTypeRegistry,
  isMemberObservable,
  isMemberStreamable,
  isMemberObservableOrStreamable,
  type TypeMember,
  type TypedValue,
} from '../src/index.js'

function observableAnnotation(): TypedValue {
  return { _type: 'observable_annotation' }
}

function streamableAnnotation(): TypedValue {
  return { _type: 'streamable_annotation' }
}

function readAnnotation(): TypedValue {
  return { _type: 'read_annotation' }
}

function findMember(registry: TypeRegistry, typeName: string, memberName: string): TypeMember {
  const type = registry.getTypes().find((t) => t.name === typeName)
  expect(type, `missing type ${typeName}`).to.exist
  const member = (type!.members ?? []).find((m) => m.name === memberName)
  expect(member, `missing member ${typeName}.${memberName}`).to.exist
  return member!
}

function buildAnnotatedApi(): TypeRegistry {
  const registry = new TypeRegistry()
  const void_ = registry.getTypeByName('void')!
  const string_ = registry.getTypeByName('string')!
  const uint8 = registry.getTypeByName('uint8')!

  const watch = TypeDescription.create({
    name: 'Api.watch',
    kind: TypeKind.Function,
    members: [{ name: 'id', type: uint8, annotations: [] }],
    item: void_,
  })
  const scan = TypeDescription.create({
    name: 'Api.scan',
    kind: TypeKind.Function,
    members: [{ name: 'id', type: uint8, annotations: [] }],
    item: void_,
  })
  const ping = TypeDescription.create({
    name: 'Api.ping',
    kind: TypeKind.Function,
    members: [{ name: 'msg', type: string_, annotations: [] }],
    item: string_,
  })
  const api = TypeDescription.create({
    name: 'Api',
    kind: TypeKind.Object,
    members: [
      { name: 'watch', type: watch, annotations: [observableAnnotation()] },
      { name: 'scan', type: scan, annotations: [streamableAnnotation()] },
      { name: 'ping', type: ping, annotations: [readAnnotation()] },
    ],
  })
  registry.registerType(api)
  registry.registerType(watch)
  registry.registerType(scan)
  registry.registerType(ping)
  return registry
}

describe('annotation serialization', () => {
  it('round-trips observable and streamable member annotations', () => {
    const restored = deserializeTypeRegistry(serializeTypeRegistry(buildAnnotatedApi()))
    const watch = findMember(restored, 'Api', 'watch')
    const scan = findMember(restored, 'Api', 'scan')
    const ping = findMember(restored, 'Api', 'ping')

    expect(isMemberObservable(watch)).to.equal(true)
    expect(isMemberStreamable(watch)).to.equal(false)
    expect(isMemberObservableOrStreamable(watch)).to.equal(true)

    expect(isMemberStreamable(scan)).to.equal(true)
    expect(isMemberObservable(scan)).to.equal(false)
    expect(isMemberObservableOrStreamable(scan)).to.equal(true)

    expect(isMemberObservable(ping)).to.equal(false)
    expect(isMemberStreamable(ping)).to.equal(false)
    expect(isMemberObservableOrStreamable(ping)).to.equal(false)
    expect(ping.annotations.map((a) => a._type)).to.deep.equal(['read_annotation'])
    expect(watch.annotations.map((a) => a._type)).to.deep.equal(['observable_annotation'])
    expect(scan.annotations.map((a) => a._type)).to.deep.equal(['streamable_annotation'])
  })

  it('double round-trip keeps annotation type names', () => {
    const once = deserializeTypeRegistry(serializeTypeRegistry(buildAnnotatedApi()))
    const twice = deserializeTypeRegistry(serializeTypeRegistry(once))
    expect(findMember(twice, 'Api', 'watch').annotations.map((a) => a._type))
      .to.deep.equal(['observable_annotation'])
    expect(findMember(twice, 'Api', 'scan').annotations.map((a) => a._type))
      .to.deep.equal(['streamable_annotation'])
  })
})
