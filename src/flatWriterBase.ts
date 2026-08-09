import { CodecRegistry, type TypedValue } from './codec.js'
import type { IWriter, WriteLater, TypedWriteValue } from './writerTypes.js'
import {
  storeLeU8, storeLeI8, storeLeU16, storeLeI16, storeLeU32, storeLeI32,
  storeLeU64, storeLeI64, storeLeF32, storeLeF64,
  offsetWidth, packFormat, storeCp, appendOffsetTable, appendOffsetTrailer,
  memcmpBytes, leBytesU32, leBytesI32,
} from './flatEncoding.js'

export interface FlatSink {
  currentPos(): number
  writeRaw(data: Uint8Array): void
  pokeU32(absOffset: number, value: number): void
}

interface Frame {
  start: number
  cps: number[]
}

/**
 * Shared flat writer logic (IWriter). Medium-specific I/O via FlatSink.
 */
export class FlatWriterBase implements IWriter {
  private readonly textEncoder = new TextEncoder()
  private readonly frames: Frame[] = []
  private readonly writtenPointers: unknown[] = []
  private readonly pendingPointers: Array<{ value: unknown, writeLater: WriteLater }> = []

  constructor(
    protected readonly sink: FlatSink,
    protected readonly codecs: CodecRegistry
  ) {}

  beginFrame(): void {
    this.frames.push({ start: this.sink.currentPos(), cps: [] })
  }

  endFrame(): void {
    if (this.frames.length === 0) {
      throw new Error('flat writer::endFrame without beginFrame')
    }
    const frame = this.frames.pop()!
    if (frame.cps.length === 0) return
    let maxCp = 0
    for (const cp of frame.cps) if (cp > maxCp) maxCp = cp
    const width = offsetWidth(maxCp)
    const format = packFormat(width)
    this.sink.writeRaw(new Uint8Array([format]))
    const buf = new Uint8Array(4)
    for (const cp of frame.cps) {
      storeCp(buf, 0, cp, width)
      this.sink.writeRaw(buf.subarray(0, width))
    }
    this.sink.writeRaw(new Uint8Array([format]))
  }

  saveOffset(): void {
    if (this.frames.length === 0) return
    const frame = this.frames[this.frames.length - 1]
    frame.cps.push(this.sink.currentPos() - frame.start)
  }

  writeU64(value: bigint | number): void {
    const buf = new Uint8Array(8)
    storeLeU64(buf, 0, value)
    this.sink.writeRaw(buf)
  }

  writeI64(value: bigint | number): void {
    const buf = new Uint8Array(8)
    storeLeI64(buf, 0, value)
    this.sink.writeRaw(buf)
  }

  writeU32(value: number): void {
    this.sink.writeRaw(leBytesU32(value))
  }

  writeI32(value: number): void {
    this.sink.writeRaw(leBytesI32(value))
  }

  writeU16(value: number): void {
    const buf = new Uint8Array(2)
    storeLeU16(buf, 0, value)
    this.sink.writeRaw(buf)
  }

  writeI16(value: number): void {
    const buf = new Uint8Array(2)
    storeLeI16(buf, 0, value)
    this.sink.writeRaw(buf)
  }

  writeU8(value: number): void {
    const buf = new Uint8Array(1)
    storeLeU8(buf, 0, value)
    this.sink.writeRaw(buf)
  }

  writeI8(value: number): void {
    const buf = new Uint8Array(1)
    storeLeI8(buf, 0, value)
    this.sink.writeRaw(buf)
  }

  writeF32(value: number): void {
    const buf = new Uint8Array(4)
    storeLeF32(buf, 0, value)
    this.sink.writeRaw(buf)
  }

  writeF64(value: number): void {
    const buf = new Uint8Array(8)
    storeLeF64(buf, 0, value)
    this.sink.writeRaw(buf)
  }

  writeBool(value: boolean): void {
    this.writeU8(value ? 1 : 0)
  }

  writeString(value: string): void {
    const encoded = this.textEncoder.encode(value)
    this.writeU32(encoded.length)
    if (encoded.length > 0) this.sink.writeRaw(encoded)
  }

  writeBinary(value: ArrayBufferView | ArrayBuffer): void {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    this.writeU32(bytes.length)
    if (bytes.length > 0) this.sink.writeRaw(bytes)
  }

  writeLength(length: number): void {
    if (length < 0) throw new Error('Length cannot be negative')
    this.writeU32(length)
  }

  writeTyped(value: TypedWriteValue): void {
    if (!value || typeof value._type !== 'string') {
      throw new Error('Typed value must provide _type string')
    }
    const index = this.codecs.typed.getIndexOrThrow(value._type)
    this.writeU32(index)
    const codec = this.codecs.typed.getByIndex(index)
    codec.serialize(this, value)
  }

  writeException(typeName: string, value: unknown): void {
    let index: number
    let resolvedName = typeName
    let resolvedValue = value
    try {
      index = this.codecs.exceptions.getIndexOrThrow(typeName)
    } catch {
      index = this.codecs.exceptions.getIndexOrThrow('runtime_error')
      resolvedName = 'runtime_error'
      resolvedValue = {
        _type: 'runtime_error',
        what: value instanceof Error ? value.message : String(value)
      }
    }
    this.writeU32(index)
    const codec = this.codecs.exceptions.getByIndex(index)
    codec.serialize(this, resolvedValue)
    void resolvedName
  }

  writePointer(value: unknown, writeLater: WriteLater): void {
    if (value === null || value === undefined) {
      this.writeI32(0)
      return
    }
    const existingIndex = this.writtenPointers.indexOf(value)
    if (existingIndex !== -1) {
      const delta = existingIndex - this.writtenPointers.length
      this.writeI32(delta)
      return
    }
    const pendingIndex = this.pendingPointers.findIndex(entry => entry.value === value)
    if (pendingIndex !== -1) {
      this.writeI32(pendingIndex + 1)
      return
    }
    this.writeI32(this.pendingPointers.length + 1)
    this.pendingPointers.push({ value, writeLater })
  }

  writeRest(): void {
    while (this.pendingPointers.length > 0) {
      const entry = this.pendingPointers[0]
      if (!entry) continue
      const sizeField = this.sink.currentPos()
      this.writeU32(0)
      const frameStart = this.sink.currentPos()
      entry.writeLater()
      const realSize = this.sink.currentPos() - frameStart
      const encodedSize = (realSize + 1) >>> 0
      this.sink.pokeU32(sizeField, encodedSize)
      this.writtenPointers.push(entry.value)
      this.pendingPointers.shift()
    }
  }

  /** Pre-register a pointer as already written (flat shared-root framing). */
  markWrittenPointer(value: unknown): void {
    if (value === null || value === undefined) return
    this.writtenPointers.push(value)
  }

  writeMap(
    entries: ReadonlyArray<[unknown, unknown]>,
    writeKey: (w: IWriter, key: unknown) => void,
    writeVal: (w: IWriter, val: unknown) => void
  ): void {
    const n = entries.length
    this.writeU32(n)
    if (n === 0) return

    // Stage keys into a temporary flat writer buffer.
    const keyStaging = new Uint8ArrayFlatSink()
    const keyWriter = new FlatWriterBase(keyStaging, this.codecs)
    const keyRanges: Array<{ off: number, len: number, value: unknown }> = []
    for (const [key, value] of entries) {
      const off = keyStaging.currentPos()
      writeKey(keyWriter, key)
      const len = keyStaging.currentPos() - off
      keyRanges.push({ off, len, value })
    }
    keyWriter.writeRest()
    const keysBuf = keyStaging.toUint8Array()

    keyRanges.sort((a, b) => memcmpBytes(keysBuf, a.off, a.len, keysBuf, b.off, b.len))

    const sortedKeys: number[] = []
    const keyOffs: number[] = new Array(n + 1)
    for (let i = 0; i < n; ++i) {
      keyOffs[i] = sortedKeys.length
      const r = keyRanges[i]
      for (let j = 0; j < r.len; ++j) sortedKeys.push(keysBuf[r.off + j])
    }
    keyOffs[n] = sortedKeys.length

    const tableBytes: number[] = []
    appendOffsetTable(tableBytes, keyOffs)
    this.sink.writeRaw(Uint8Array.from(tableBytes))
    this.sink.writeRaw(Uint8Array.from(sortedKeys))

    const valStaging = new Uint8ArrayFlatSink()
    const valWriter = new FlatWriterBase(valStaging, this.codecs)
    const valOffs: number[] = new Array(n)
    for (let i = 0; i < n; ++i) {
      valOffs[i] = valStaging.currentPos()
      writeVal(valWriter, keyRanges[i].value)
    }
    valWriter.writeRest()
    const valuesBuf = valStaging.toUint8Array()
    this.sink.writeRaw(valuesBuf)

    const trailerBytes: number[] = []
    appendOffsetTrailer(trailerBytes, valOffs)
    if (trailerBytes.length > 0) this.sink.writeRaw(Uint8Array.from(trailerBytes))
  }
}

/** In-memory sink used for FlatWriter and map staging. */
export class Uint8ArrayFlatSink implements FlatSink {
  private buffer: Uint8Array
  private length = 0
  private view: DataView

  constructor(initialCapacity = 256) {
    this.buffer = new Uint8Array(initialCapacity)
    this.view = new DataView(this.buffer.buffer)
  }

  currentPos(): number {
    return this.length
  }

  writeRaw(data: Uint8Array): void {
    this.ensureCapacity(data.length)
    this.buffer.set(data, this.length)
    this.length += data.length
  }

  pokeU32(absOffset: number, value: number): void {
    if (absOffset + 4 > this.length) {
      throw new Error('flat sink pokeU32 out of range')
    }
    this.view.setUint32(absOffset, value >>> 0, true)
  }

  toUint8Array(): Uint8Array {
    return this.buffer.subarray(0, this.length)
  }

  private ensureCapacity(extra: number): void {
    const required = this.length + extra
    if (required <= this.buffer.length) return
    let capacity = this.buffer.length * 2
    while (capacity < required) capacity *= 2
    const next = new Uint8Array(capacity)
    next.set(this.buffer.subarray(0, this.length))
    this.buffer = next
    this.view = new DataView(this.buffer.buffer)
  }
}
