import type { CircularBuffer } from './CircularBuffer.js'
import { CodecRegistry } from './codec.js'
import { KeyWriter } from './keyWriter.js'
import type { IWriter, TypedWriteValue, WriteLater } from './writerTypes.js'

/**
 * Key format writer into a CircularBuffer.
 * Accumulates like KeyWriter; finish() writes the full blob via buffer.write.
 */
export class KeyLocalCircularBufferWriter implements IWriter {
  private readonly inner: KeyWriter
  private done = false

  constructor(
    private readonly buffer: CircularBuffer,
    codecs: CodecRegistry,
    initialCapacity = 64
  ) {
    this.inner = new KeyWriter(codecs, initialCapacity)
  }

  beginFrame(): void { this.inner.beginFrame() }
  endFrame(): void { this.inner.endFrame() }
  saveOffset(): void { this.inner.saveOffset() }
  writeRest(): void { this.inner.writeRest() }
  deferredPointerUsesTypeIndex(): boolean {
    return this.inner.deferredPointerUsesTypeIndex()
  }

  writeU64(value: bigint | number): void { this.inner.writeU64(value) }
  writeI64(value: bigint | number): void { this.inner.writeI64(value) }
  writeU32(value: number): void { this.inner.writeU32(value) }
  writeI32(value: number): void { this.inner.writeI32(value) }
  writeU16(value: number): void { this.inner.writeU16(value) }
  writeI16(value: number): void { this.inner.writeI16(value) }
  writeU8(value: number): void { this.inner.writeU8(value) }
  writeI8(value: number): void { this.inner.writeI8(value) }
  writeF32(value: number): void { this.inner.writeF32(value) }
  writeF64(value: number): void { this.inner.writeF64(value) }
  writeBool(value: boolean): void { this.inner.writeBool(value) }
  writeLength(length: number): void { this.inner.writeLength(length) }
  writeString(value: string): void { this.inner.writeString(value) }
  writeBinary(value: ArrayBufferView | ArrayBuffer): void { this.inner.writeBinary(value) }
  writeTyped(value: TypedWriteValue): void { this.inner.writeTyped(value) }
  writePointer(value: unknown, writeLater: WriteLater): void {
    this.inner.writePointer(value, writeLater)
  }
  writeMap(
    entries: ReadonlyArray<[unknown, unknown]>,
    writeKey: (w: IWriter, key: unknown) => void,
    writeVal: (w: IWriter, val: unknown) => void
  ): void {
    this.inner.writeMap(entries, writeKey, writeVal)
  }

  /** Finish key blob and write it into the circular buffer. */
  finish(): Uint8Array {
    if (this.done) {
      throw new Error('key format: writer already finished')
    }
    const blob = this.inner.finish()
    this.done = true
    if (blob.length === 0) return blob

    // Grow LocalCircularBuffer if needed (other CircularBuffer impls may not grow).
    const growable = this.buffer as CircularBuffer & { grow?: (n: number) => number }
    if (typeof growable.grow === 'function' && this.buffer.writableBytes() < blob.length) {
      growable.grow(this.buffer.capacity() + blob.length)
    }

    const written = this.buffer.write(blob, blob.length)
    if (written !== blob.length) {
      throw new Error('key circular writer: short write')
    }
    return blob
  }

  finished(): boolean {
    return this.done
  }
}
