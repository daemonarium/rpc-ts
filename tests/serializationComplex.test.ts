import { readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { expect } from 'chai'
import {
  buildPersonTypes,
  makePersonValue,
  makePersonGraph,
  emptyPerson,
  encodePersonValueCompressed,
  encodePersonValueFlat,
  decodePersonValueCompressed,
  decodePersonValueFlat,
  encodePersonGraphCompressed,
  encodePersonGraphFlat,
  decodePersonGraphCompressed,
  decodePersonGraphFlat,
  personFieldsEqual,
  personGraphEqual,
  bytesToHex,
  hexToBytes,
  parseSeed,
} from './personFixture.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

type ComplexRow = { kind: string, format: string, seed: string, hex: string }

describe('cross-lang complex Person goldens', () => {
  let rows: ComplexRow[]
  const types = buildPersonTypes()

  before(async () => {
    const content = await readFile(join(__dirname, 'serialization_complex_reference.tsv'), 'utf-8')
    rows = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [kind, format, seed, hex] = line.split('\t')
        return { kind: kind!, format: format!, seed: seed!, hex: hex! }
      })
  })

  it('encode matches C++ hex for every row', () => {
    for (const row of rows) {
      const seed = parseSeed(row.seed)
      let encoded: Uint8Array
      if (row.kind === 'person_empty') {
        const p = emptyPerson()
        encoded = row.format === 'flat'
          ? encodePersonValueFlat(types, p)
          : encodePersonValueCompressed(types, p)
      } else if (row.kind === 'person_value') {
        const p = makePersonValue(seed)
        encoded = row.format === 'flat'
          ? encodePersonValueFlat(types, p)
          : encodePersonValueCompressed(types, p)
      } else if (row.kind === 'person_graph_null') {
        encoded = row.format === 'flat'
          ? encodePersonGraphFlat(types, null)
          : encodePersonGraphCompressed(types, null)
      } else if (row.kind === 'person_graph') {
        const root = makePersonGraph(seed)
        encoded = row.format === 'flat'
          ? encodePersonGraphFlat(types, root)
          : encodePersonGraphCompressed(types, root)
      } else {
        throw new Error(`unknown kind ${row.kind}`)
      }
      expect(bytesToHex(encoded), `${row.kind}/${row.format}/${row.seed}`).to.equal(row.hex)
    }
  })

  it('decode C++ hex matches fixture value/graph', () => {
    for (const row of rows) {
      const seed = parseSeed(row.seed)
      const bytes = hexToBytes(row.hex)
      if (row.kind === 'person_empty' || row.kind === 'person_value') {
        const expected = row.kind === 'person_empty' ? emptyPerson() : makePersonValue(seed)
        const decoded = row.format === 'flat'
          ? decodePersonValueFlat(types, bytes)
          : decodePersonValueCompressed(types, bytes)
        expect(personFieldsEqual(decoded, expected), `${row.kind}/${row.format}/${row.seed}`).to.equal(true)
        expect(decoded.friends).to.deep.equal([])
      } else if (row.kind === 'person_graph_null') {
        const decoded = row.format === 'flat'
          ? decodePersonGraphFlat(types, bytes)
          : decodePersonGraphCompressed(types, bytes)
        expect(decoded).to.equal(null)
      } else if (row.kind === 'person_graph') {
        const expected = makePersonGraph(seed)
        const decoded = row.format === 'flat'
          ? decodePersonGraphFlat(types, bytes)
          : decodePersonGraphCompressed(types, bytes)
        expect(decoded, `${row.kind}/${row.format}/${row.seed}`).to.not.equal(null)
        expect(personGraphEqual(decoded, expected), `${row.kind}/${row.format}/${row.seed}`).to.equal(true)
      }
    }
  })
})
