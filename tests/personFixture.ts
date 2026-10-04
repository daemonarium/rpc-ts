/**
 * Person/Skill fixture ported from cpp-rpc/src/test/person_fixture.hpp.
 * Rng must stay bit-identical with the C++ XorShift.
 */

import {
  CodecRegistry,
  TypeDescription,
  TypeKind,
  TypeRegistry,
  Writer,
  Reader,
  FlatWriter,
  FlatReader,
  serializeValueByType,
  deserializeValueByType,
  registerDynamicCodecs,
  type JsonValue,
  type IWriter,
  type IReader,
} from '../src/index.js'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'
const MASK64 = 0xffffffffffffffffn

export class Rng {
  private s: bigint

  constructor(seed: bigint | number) {
    const n = BigInt(seed) & MASK64
    this.s = n === 0n ? 0x9e3779b97f4a7c15n : n
  }

  nextU64(): bigint {
    let s = this.s
    s ^= s >> 12n
    s = (s ^ ((s << 25n) & MASK64)) & MASK64
    s = (s ^ (s >> 27n)) & MASK64
    this.s = s
    return (s * 0x2545F4914F6CDD1Dn) & MASK64
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n) >>> 0
  }

  nextI32(lo: number, hi: number): number {
    if (hi <= lo) return lo
    return lo + (this.nextU32() % (hi - lo + 1))
  }

  nextBool(): boolean {
    return (this.nextU32() & 1) !== 0
  }

  nextString(minLen: number, maxLen: number): string {
    const n = this.nextI32(minLen, maxLen)
    let out = ''
    for (let i = 0; i < n; ++i) {
      out += ALPHABET[this.nextU32() % ALPHABET.length]
    }
    return out
  }
}

export type Skill = { name: string, level: number }

export type Person = {
  _type?: string
  name: string
  age: number
  skill: Skill
  scores: number[]
  tags: string[]
  friends: Array<Person | null>
  attrs: Record<string, number>
  skills: Record<string, Skill>
  by_id: Map<number, string>
}

export function makeSkill(rng: Rng, salt: number): Skill {
  const name = rng.nextBool() && (salt % 5 === 0) ? '' : ('sk_' + rng.nextString(1, 10))
  const level = rng.nextI32(-5, 100)
  return { name, level }
}

export function makePersonValue(seed: bigint | number): Person {
  const seedN = typeof seed === 'bigint' ? seed : BigInt(seed)
  const rng = new Rng(seedN)
  const p: Person = {
    name: (seedN % 11n === 0n) ? '' : ('p_' + rng.nextString(0, 16)),
    age: rng.nextI32(-1, 120),
    skill: makeSkill(rng, Number(seedN & 0xffffffffn)),
    scores: [],
    tags: [],
    friends: [],
    attrs: {},
    skills: {},
    by_id: new Map(),
  }
  const nScores = rng.nextI32(0, 8)
  for (let i = 0; i < nScores; ++i) p.scores.push(rng.nextI32(-100, 100))
  const nTags = rng.nextI32(0, 6)
  for (let i = 0; i < nTags; ++i) p.tags.push(rng.nextString(0, 12))
  const nAttrs = rng.nextI32(0, 6)
  for (let i = 0; i < nAttrs; ++i) {
    p.attrs['a' + i + '_' + rng.nextString(1, 5)] = rng.nextI32(-50, 50)
  }
  const nSkills = rng.nextI32(0, 4)
  for (let i = 0; i < nSkills; ++i) {
    p.skills['s' + rng.nextString(1, 6)] = makeSkill(rng, Number((seedN + BigInt(i)) & 0xffffffffn))
  }
  const nIds = rng.nextI32(0, 5)
  for (let i = 0; i < nIds; ++i) {
    p.by_id.set(rng.nextI32(-20, 20), rng.nextString(0, 10))
  }
  return p
}

export function makePersonGraph(seed: bigint | number): Person {
  const rng = new Rng(seed)
  const n = rng.nextI32(2, 6)
  const nodes: Person[] = []
  for (let i = 0; i < n; ++i) {
    nodes.push({
      _type: 'Person',
      name: 'g' + i + '_' + rng.nextString(0, 8),
      age: rng.nextI32(0, 80),
      skill: { name: '', level: 0 },
      scores: [],
      tags: [],
      friends: [],
      attrs: {},
      skills: {},
      by_id: new Map(),
    })
  }
  for (let i = 0; i < n; ++i) {
    const edges = rng.nextI32(1, 3)
    for (let e = 0; e < edges; ++e) {
      nodes[i].friends.push(nodes[rng.nextI32(0, n - 1)])
    }
    if (rng.nextBool()) nodes[i].friends.push(null)
  }
  nodes[0].friends.push(nodes[0])
  return nodes[0]
}

export function emptyPerson(): Person {
  return {
    name: '',
    age: 0,
    skill: { name: '', level: 0 },
    scores: [],
    tags: [],
    friends: [],
    attrs: {},
    skills: {},
    by_id: new Map(),
  }
}

/** Sort maps like C++ std::map for compressed interleaved encode. */
export function normalizePersonMaps(p: Person): Person {
  const attrs: Record<string, number> = {}
  for (const k of Object.keys(p.attrs).sort()) attrs[k] = p.attrs[k]
  const skills: Record<string, Skill> = {}
  for (const k of Object.keys(p.skills).sort()) skills[k] = p.skills[k]
  const by_id = new Map([...p.by_id.entries()].sort((a, b) => a[0] - b[0]))
  return { ...p, attrs, skills, by_id }
}

export type PersonTypes = {
  registry: TypeRegistry
  skillType: TypeDescription
  personType: TypeDescription
  scoresType: TypeDescription
  tagsType: TypeDescription
  attrsType: TypeDescription
  skillsMapType: TypeDescription
  byIdType: TypeDescription
  codecs: CodecRegistry
}

export function buildPersonTypes(): PersonTypes {
  const registry = new TypeRegistry()
  const skillType = TypeDescription.create({
    name: 'Skill',
    kind: TypeKind.Object,
    members: [
      { name: 'name', type: registry.getTypeByName('string')!, annotations: [] },
      { name: 'level', type: registry.getTypeByName('sint32')!, annotations: [] },
    ],
  })
  registry.registerType(skillType)

  const scoresType = TypeDescription.create({
    name: 'sint32[]',
    kind: TypeKind.Array,
    item: registry.getTypeByName('sint32')!,
  })
  const tagsType = TypeDescription.create({
    name: 'string[]',
    kind: TypeKind.Array,
    item: registry.getTypeByName('string')!,
  })
  const pointerType = registry.getTypeByName('pointer')!
  const friendsType = TypeDescription.create({
    name: 'Person*[]',
    kind: TypeKind.Array,
    item: pointerType,
  })
  const attrsType = TypeDescription.create({
    name: 'map_string_sint32',
    kind: TypeKind.Map,
    key: registry.getTypeByName('string')!,
    item: registry.getTypeByName('sint32')!,
  })
  const skillsMapType = TypeDescription.create({
    name: 'map_string_Skill',
    kind: TypeKind.Map,
    key: registry.getTypeByName('string')!,
    item: skillType,
  })
  const byIdType = TypeDescription.create({
    name: 'map_sint32_string',
    kind: TypeKind.Map,
    key: registry.getTypeByName('sint32')!,
    item: registry.getTypeByName('string')!,
  })

  const personMembers = [
    { name: 'name', type: registry.getTypeByName('string')!, annotations: [] },
    { name: 'age', type: registry.getTypeByName('sint32')!, annotations: [] },
    { name: 'skill', type: skillType, annotations: [] },
    { name: 'scores', type: scoresType, annotations: [] },
    { name: 'tags', type: tagsType, annotations: [] },
    { name: 'friends', type: friendsType, annotations: [] },
    { name: 'attrs', type: attrsType, annotations: [] },
    { name: 'skills', type: skillsMapType, annotations: [] },
    { name: 'by_id', type: byIdType, annotations: [] },
  ]

  const personType = TypeDescription.create({
    name: 'PersonValue',
    kind: TypeKind.Object,
    members: personMembers,
  })
  registry.registerType(personType)

  const personDynamicType = TypeDescription.create({
    name: 'Person',
    kind: TypeKind.DynamicObject,
    members: personMembers,
  })
  registry.registerType(personDynamicType)

  const codecs = new CodecRegistry()
  registerDynamicCodecs(codecs, registry)
  return {
    registry, skillType, personType, scoresType, tagsType,
    attrsType, skillsMapType, byIdType, codecs,
  }
}

function personJson(p: Person, asDynamic: boolean): JsonValue {
  const n = normalizePersonMaps(p)
  const obj: Record<string, JsonValue> = {
    name: n.name,
    age: n.age,
    skill: { name: n.skill.name, level: n.skill.level },
    scores: n.scores,
    tags: n.tags,
    friends: n.friends as unknown as JsonValue,
    attrs: n.attrs,
    skills: n.skills as unknown as JsonValue,
    by_id: n.by_id as unknown as JsonValue,
  }
  if (asDynamic) obj._type = 'Person'
  return obj
}

export function encodePersonValueCompressed(types: PersonTypes, person: Person): Uint8Array {
  const w = new Writer(types.codecs)
  serializeValueByType(w, types.registry, types.personType, personJson(person, false))
  w.writeRest()
  return new Uint8Array(w.toArrayBuffer())
}

export function encodePersonValueFlat(types: PersonTypes, person: Person): Uint8Array {
  const w = new FlatWriter(types.codecs)
  serializeValueByType(w, types.registry, types.personType, personJson(person, false))
  w.writeRest()
  return w.toUint8Array()
}

export function decodePersonValueCompressed(types: PersonTypes, bytes: Uint8Array): Person {
  const r = new Reader(bytes, types.codecs)
  let out: JsonValue
  deserializeValueByType(r, types.registry, types.personType, (v) => { out = v })
  r.readRest()
  return out as unknown as Person
}

export function decodePersonValueFlat(types: PersonTypes, bytes: Uint8Array): Person {
  const r = new FlatReader(bytes, types.codecs)
  let out: JsonValue
  deserializeValueByType(r, types.registry, types.personType, (v) => { out = v })
  r.readRest()
  return out as unknown as Person
}

function collectPersons(root: Person, seen = new Set<Person>()): Person[] {
  if (seen.has(root)) return []
  seen.add(root)
  const out = [root]
  for (const f of root.friends) {
    if (f) out.push(...collectPersons(f, seen))
  }
  return out
}

export function encodePersonGraphCompressed(types: PersonTypes, root: Person | null): Uint8Array {
  const w = new Writer(types.codecs)
  if (root === null) {
    w.writePointer(null, () => {})
  } else {
    for (const f of collectPersons(root)) f._type = 'Person'
    w.writePointer(root, () => w.writeTyped(root as any))
  }
  w.writeRest()
  return new Uint8Array(w.toArrayBuffer())
}

/**
 * Flat shared-root framing (matches C++ encode_flat_shared).
 * Each deferred friend body is [u32 type index][Person frame].
 */
export function encodePersonGraphFlat(types: PersonTypes, root: Person | null): Uint8Array {
  const w = new FlatWriter(types.codecs)
  if (root === null) {
    w.writeU32(0)
    return w.toUint8Array()
  }
  w.markWrittenPointer(root)
  const sizeField = w.size
  w.writeU32(0)
  const frameStart = w.size
  serializePersonFlatBody(w, types, root)
  w.pokeU32(sizeField, (w.size - frameStart + 1) >>> 0)
  w.writeRest()
  w.writeU32(0)
  return w.toUint8Array()
}

function serializePersonFlatBody(w: IWriter, types: PersonTypes, person: Person): void {
  const n = normalizePersonMaps(person)
  w.beginFrame()
  serializeValueByType(w, types.registry, types.registry.getTypeByName('string')!, n.name)
  serializeValueByType(w, types.registry, types.registry.getTypeByName('sint32')!, n.age)
  serializeValueByType(w, types.registry, types.skillType, n.skill as unknown as JsonValue)
  serializeValueByType(w, types.registry, types.scoresType, n.scores)
  serializeValueByType(w, types.registry, types.tagsType, n.tags)

  w.beginFrame()
  w.writeLength(n.friends.length)
  for (const friend of n.friends) {
    w.writePointer(friend, () => {
      if (!friend) return
      // Same index C++ register_serialize_typed_function<Person> emits (Person is the only dynamic type).
      w.writeU32(types.codecs.typed.getIndexOrThrow('Person'))
      serializePersonFlatBody(w, types, friend)
    })
  }
  w.endFrame()
  w.saveOffset()

  serializeValueByType(w, types.registry, types.attrsType, n.attrs)
  serializeValueByType(w, types.registry, types.skillsMapType, n.skills as unknown as JsonValue)
  serializeValueByType(w, types.registry, types.byIdType, n.by_id as unknown as JsonValue)
  w.endFrame()
  w.saveOffset()
}

export function decodePersonGraphFlat(types: PersonTypes, bytes: Uint8Array): Person | null {
  const r = new FlatReader(bytes, types.codecs)
  const rootEncoded = r.readU32()
  if (rootEncoded === 0) return null
  const out = emptyPerson()
  out._type = 'Person'
  r.markReadPointer(out)
  deserializePersonFlatBody(r, types, out)
  r.readRest()
  const sentinel = r.readU32()
  if (sentinel !== 0) throw new Error('flat shared decode: missing sentinel')
  return out
}

function deserializePersonFlatBody(r: IReader, types: PersonTypes, out: Person): void {
  r.enterFrame()
  deserializeValueByType(r, types.registry, types.registry.getTypeByName('string')!, (v) => { out.name = v as string })
  deserializeValueByType(r, types.registry, types.registry.getTypeByName('sint32')!, (v) => { out.age = v as number })
  deserializeValueByType(r, types.registry, types.skillType, (v) => { out.skill = v as Skill })
  deserializeValueByType(r, types.registry, types.scoresType, (v) => { out.scores = v as number[] })
  deserializeValueByType(r, types.registry, types.tagsType, (v) => { out.tags = v as string[] })

  r.enterFrame()
  const n = r.readLength()
  out.friends = new Array(n)
  for (let i = 0; i < n; ++i) {
    const idx = i
    r.readPointer((value) => { out.friends[idx] = value as Person | null }, (output) => {
      const index = r.readU32()
      const personIndex = types.codecs.typed.getIndexOrThrow('Person')
      if (index !== personIndex) {
        throw new Error(`flat person graph: unexpected type index ${index}`)
      }
      const child = emptyPerson()
      child._type = 'Person'
      deserializePersonFlatBody(r, types, child)
      output(child)
    })
  }
  r.exitFrame()
  r.saveOffset()

  deserializeValueByType(r, types.registry, types.attrsType, (v) => { out.attrs = v as Record<string, number> })
  deserializeValueByType(r, types.registry, types.skillsMapType, (v) => { out.skills = v as Record<string, Skill> })
  deserializeValueByType(r, types.registry, types.byIdType, (v) => { out.by_id = v as Map<number, string> })
  r.exitFrame()
  r.saveOffset()
}

export function decodePersonGraphCompressed(types: PersonTypes, bytes: Uint8Array): Person | null {
  const r = new Reader(bytes, types.codecs)
  let out: Person | null = null
  r.readPointer((value) => { out = value as Person | null }, (assign) => {
    r.readTyped((value) => {
      assign(value)
    })
  })
  r.readRest()
  return out
}

export function personFieldsEqual(a: Person, b: Person): boolean {
  if (a.name !== b.name || a.age !== b.age) return false
  if (a.skill.name !== b.skill.name || a.skill.level !== b.skill.level) return false
  if (JSON.stringify(a.scores) !== JSON.stringify(b.scores)) return false
  if (JSON.stringify(a.tags) !== JSON.stringify(b.tags)) return false
  const attrEntries = (p: Person) =>
    Object.keys(p.attrs).sort().map((k) => [k, p.attrs[k]])
  if (JSON.stringify(attrEntries(a)) !== JSON.stringify(attrEntries(b))) return false
  const skillEntries = (p: Person) =>
    Object.keys(p.skills).sort().map((k) => [k, p.skills[k].name, p.skills[k].level])
  if (JSON.stringify(skillEntries(a)) !== JSON.stringify(skillEntries(b))) return false
  const aIds = a.by_id instanceof Map ? a.by_id : new Map(Object.entries(a.by_id as any).map(([k, v]) => [Number(k), v as string]))
  const bIds = b.by_id instanceof Map ? b.by_id : new Map(Object.entries(b.by_id as any).map(([k, v]) => [Number(k), v as string]))
  if (aIds.size !== bIds.size) return false
  for (const [k, v] of aIds) {
    if (bIds.get(k) !== v) return false
  }
  return true
}

export function personGraphEqual(a: Person | null, b: Person | null, seen = new Map<object, object>()): boolean {
  if (a === null || b === null) return a === b
  const prev = seen.get(a)
  if (prev !== undefined) return prev === b
  seen.set(a, b)
  if (!personFieldsEqual(a, b)) return false
  if (a.friends.length !== b.friends.length) return false
  for (let i = 0; i < a.friends.length; ++i) {
    if (!personGraphEqual(a.friends[i], b.friends[i], seen)) return false
  }
  return true
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export function parseSeed(s: string): bigint {
  return BigInt(s)
}
