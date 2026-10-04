import { CodecRegistry } from './codec.js'
import type { IReader, ReadLater } from './writerTypes.js'
import {
  loadLeU8, loadLeI8, loadLeU16, loadLeI16, loadLeU32, loadLeI32,
  loadLeU64, loadLeI64, loadLeF32, loadLeF64,
  unpackWidth,
} from './flatEncoding.js'

export interface FlatPeekSource {
  size(): number
  peek(offset: number, dest: Uint8Array): number
}

interface Frame {
  checkpointCount: number
}

type AssignAfterRead = (value: unknown) => void

/**
 * Shared flat reader logic (IReader). Medium-specific I/O via FlatPeekSource + cursor.
 */
export class FlatReaderBase implements IReader {
  private readonly textDecoder = new TextDecoder()
  private readonly frames: Frame[] = []
  private readonly readPointers: unknown[] = []
  private readonly pendingPointers: Array<{ assignments: AssignAfterRead[], readLater: ReadLater }> = []
  protected cursor = 0

  constructor(
    protected readonly source: FlatPeekSource,
    protected readonly codecs: CodecRegistry
  ) {}

  isIndexed(): boolean {
    return false
  }

  deferredPointerUsesTypeIndex(): boolean {
    return true
  }

  enterFrame(): void {
    this.frames.push({ checkpointCount: 0 })
  }

  exitFrame(): void {
    if (this.frames.length === 0) {
      throw new Error('flat reader::exitFrame without enterFrame')
    }
    const frame = this.frames.pop()!
    const k = frame.checkpointCount
    if (k === 0) return
    const format = this.readU8()
    const width = unpackWidth(format)
    this.skip(k * width)
    const formatEnd = this.readU8()
    if (formatEnd !== format) {
      throw new Error('flat trailer format mismatch')
    }
  }

  saveOffset(): void {
    if (this.frames.length === 0) return
    this.frames[this.frames.length - 1].checkpointCount++
  }

  getCursor(): number {
    return this.cursor
  }

  setCursor(offset: number): void {
    this.cursor = offset
  }

  skip(n: number): void {
    if (this.cursor + n > this.source.size()) {
      throw new Error('flat reader skip out of range')
    }
    this.cursor += n
  }

  readRaw(dest: Uint8Array): void {
    if (this.cursor + dest.length > this.source.size()) {
      throw new Error('flat reader underflow')
    }
    const n = this.source.peek(this.cursor, dest)
    if (n !== dest.length) {
      throw new Error('flat reader peek failed')
    }
    this.cursor += dest.length
  }

  readU64(): number | bigint {
    const buf = new Uint8Array(8)
    this.readRaw(buf)
    const v = loadLeU64(buf, 0)
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v
  }

  readI64(): number | bigint {
    const buf = new Uint8Array(8)
    this.readRaw(buf)
    const v = loadLeI64(buf, 0)
    if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(v)
    }
    return v
  }

  readU32(): number {
    const buf = new Uint8Array(4)
    this.readRaw(buf)
    return loadLeU32(buf, 0)
  }

  readI32(): number {
    const buf = new Uint8Array(4)
    this.readRaw(buf)
    return loadLeI32(buf, 0)
  }

  readU16(): number {
    const buf = new Uint8Array(2)
    this.readRaw(buf)
    return loadLeU16(buf, 0)
  }

  readI16(): number {
    const buf = new Uint8Array(2)
    this.readRaw(buf)
    return loadLeI16(buf, 0)
  }

  readU8(): number {
    const buf = new Uint8Array(1)
    this.readRaw(buf)
    return loadLeU8(buf, 0)
  }

  readI8(): number {
    const buf = new Uint8Array(1)
    this.readRaw(buf)
    return loadLeI8(buf, 0)
  }

  readF32(): number {
    const buf = new Uint8Array(4)
    this.readRaw(buf)
    return loadLeF32(buf, 0)
  }

  readF64(): number {
    const buf = new Uint8Array(8)
    this.readRaw(buf)
    return loadLeF64(buf, 0)
  }

  readBool(): boolean {
    return this.readU8() !== 0
  }

  readString(): string {
    const length = this.readU32()
    if (length === 0) return ''
    const buf = new Uint8Array(length)
    this.readRaw(buf)
    return this.textDecoder.decode(buf)
  }

  readBinary(): Uint8Array {
    const length = this.readU32()
    const buf = new Uint8Array(length)
    if (length > 0) this.readRaw(buf)
    return buf
  }

  readLength(): number {
    return this.readU32()
  }

  readTyped<T>(output: (value: T) => void): void {
    const index = this.readU32()
    const codec = this.codecs.typed.getByIndex(index)
    codec.deserialize(this, output)
  }

  readException(): { typeName: string, value: unknown } {
    const index = this.readU32()
    const codec = this.codecs.exceptions.getByIndex(index)
    if (!codec) {
      throw new Error(`Exception type not registered for deserialization (index ${index})`)
    }
    let value: unknown
    codec.deserialize(this, (v) => {
      value = v
    })
    return { typeName: codec.name, value }
  }

  readMap(
    readKey: (r: IReader, assign: (key: unknown) => void) => void,
    readVal: (r: IReader, assign: (val: unknown) => void) => void
  ): Array<[unknown, unknown]> {
    this.frames.push({ checkpointCount: 0 })
    const n = this.readLength()
    if (n === 0) {
      this.frames.pop()
      return []
    }
    const formatK = this.readU8()
    const wk = unpackWidth(formatK)
    this.skip((n + 1) * wk)

    const out: Array<[unknown, unknown]> = []
    for (let i = 0; i < n; ++i) {
      let key: unknown
      readKey(this, k => { key = k })
      out.push([key, undefined])
    }
    for (let i = 0; i < n; ++i) {
      readVal(this, v => { out[i][1] = v })
    }

    const formatV = this.readU8()
    const wv = unpackWidth(formatV)
    this.skip(n * wv)
    const formatVEnd = this.readU8()
    if (formatVEnd !== formatV) {
      throw new Error('flat map value trailer format mismatch')
    }
    this.frames.pop()
    return out
  }

  readPointer<T>(assign: (value: T) => void, readLater: ReadLater): void {
    const delta = this.readI32()
    if (delta === 0) {
      assign(null as T)
      return
    }
    if (delta < 0) {
      const index = this.readPointers.length + delta
      if (index < 0 || index >= this.readPointers.length) {
        throw new Error('Pointer delta out of range')
      }
      assign(this.readPointers[index] as T)
      return
    }
    const offset = delta - 1
    if (offset < this.pendingPointers.length) {
      this.pendingPointers[offset].assignments.push(value => assign(value as T))
      return
    }
    if (offset > this.pendingPointers.length) {
      throw new Error('Pointer delta too large, input is corrupted')
    }
    this.pendingPointers.push({
      assignments: [value => assign(value as T)],
      readLater
    })
  }

  readRest(): void {
    while (this.pendingPointers.length > 0) {
      const entry = this.pendingPointers[0]
      if (!entry) continue
      // Consume per-frame encoded_size prefix (value unused for sequential materialize).
      this.readU32()
      entry.readLater((value) => {
        this.pendingPointers.shift()
        this.readPointers.push(value)
        for (const assign of entry.assignments) {
          assign(value)
        }
      })
    }
  }

  /** Pre-register a pointer as already read (flat shared-root framing). */
  markReadPointer(value: unknown): void {
    if (value === null || value === undefined) return
    this.readPointers.push(value)
  }
}

export class Uint8ArrayFlatSource implements FlatPeekSource {
  private readonly bytes: Uint8Array

  constructor(source: ArrayBufferLike | ArrayBufferView | Uint8Array) {
    if (source instanceof Uint8Array) {
      this.bytes = source
    } else if (ArrayBuffer.isView(source)) {
      this.bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    } else {
      this.bytes = new Uint8Array(source)
    }
  }

  size(): number {
    return this.bytes.length
  }

  peek(offset: number, dest: Uint8Array): number {
    if (offset > this.bytes.length) return 0
    const available = this.bytes.length - offset
    const toCopy = Math.min(dest.length, available)
    if (toCopy > 0) dest.set(this.bytes.subarray(offset, offset + toCopy))
    return toCopy
  }
}
