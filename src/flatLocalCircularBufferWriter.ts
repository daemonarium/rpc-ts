import { type CircularBuffer, ensureCircularWritable } from './CircularBuffer.js'
import { CodecRegistry } from './codec.js'
import { FlatWriterBase, type FlatSink } from './flatWriterBase.js'
import { storeLeU32 } from './flatEncoding.js'

class CircularFlatSink implements FlatSink {
  constructor(
    private readonly buffer: CircularBuffer,
    private offsetRef: { offset: number }
  ) {}

  currentPos(): number {
    return this.offsetRef.offset
  }

  writeRaw(data: Uint8Array): void {
    if (data.length === 0) return
    this.ensureWritable(data.length)
    const written = this.buffer.poke(this.offsetRef.offset, data, data.length)
    if (written !== data.length) {
      throw new Error('flat circular writer: short poke')
    }
    this.offsetRef.offset += written
  }

  pokeU32(absOffset: number, value: number): void {
    const buf = new Uint8Array(4)
    storeLeU32(buf, 0, value)
    const written = this.buffer.poke(absOffset, buf, 4)
    if (written !== 4) {
      throw new Error('flat circular writer: pokeU32 failed')
    }
  }

  private ensureWritable(bytes: number): void {
    ensureCircularWritable(this.buffer, this.offsetRef.offset + bytes)
  }
}

/**
 * Flat LE writer into CircularBuffer via poke (no auto-commit).
 * Grows when the buffer supports grow(); throws if full.
 * Caller commits with buffer.commitWrite(writer.offset).
 */
export class FlatLocalCircularBufferWriter extends FlatWriterBase {
  private readonly offsetRef: { offset: number }

  constructor(buffer: CircularBuffer, codecs: CodecRegistry, offset: number = 0) {
    const offsetRef = { offset }
    super(new CircularFlatSink(buffer, offsetRef), codecs)
    this.offsetRef = offsetRef
  }

  get offset(): number {
    return this.offsetRef.offset
  }

  set offset(value: number) {
    this.offsetRef.offset = value
  }

  getOffset(): number {
    return this.offsetRef.offset
  }

  /** Back-patch a u32 LE at an absolute poke offset (e.g. encoded_size_0). */
  pokeU32(absOffset: number, value: number): void {
    this.sink.pokeU32(absOffset, value)
  }
}
