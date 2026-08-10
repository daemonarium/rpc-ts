import type { CircularBuffer } from './CircularBuffer.js'
import { CodecRegistry } from './codec.js'
import { KeyReader } from './keyReader.js'
import type { IReader, ReadLater } from './writerTypes.js'

/**
 * Key format reader over a CircularBuffer: peeks `messageLen` bytes at read offset,
 * then decodes as a key blob (does not consume).
 */
export class KeyLocalCircularBufferReader implements IReader {
  private readonly inner: KeyReader

  constructor(buffer: CircularBuffer, messageLen: number, codecs: CodecRegistry) {
    if (messageLen > buffer.readableBytes()) {
      throw new Error('key circular reader: message_len exceeds readable')
    }
    const blob = new Uint8Array(messageLen)
    if (messageLen > 0) {
      const peeked = buffer.peek(0, blob, messageLen)
      if (peeked !== messageLen) {
        throw new Error('key circular reader: short peek')
      }
    }
    this.inner = new KeyReader(blob, codecs)
  }

  isIndexed(): boolean { return this.inner.isIndexed() }
  deferredPointerUsesTypeIndex(): boolean {
    return this.inner.deferredPointerUsesTypeIndex()
  }
  enterFrame(): void { this.inner.enterFrame() }
  exitFrame(): void { this.inner.exitFrame() }
  saveOffset(): void { this.inner.saveOffset() }
  readRest(): void { this.inner.readRest() }

  readU64(): number | bigint { return this.inner.readU64() }
  readI64(): number | bigint { return this.inner.readI64() }
  readU32(): number { return this.inner.readU32() }
  readI32(): number { return this.inner.readI32() }
  readU16(): number { return this.inner.readU16() }
  readI16(): number { return this.inner.readI16() }
  readU8(): number { return this.inner.readU8() }
  readI8(): number { return this.inner.readI8() }
  readF32(): number { return this.inner.readF32() }
  readF64(): number { return this.inner.readF64() }
  readBool(): boolean { return this.inner.readBool() }
  readLength(): number { return this.inner.readLength() }
  readString(): string { return this.inner.readString() }
  readBinary(): Uint8Array { return this.inner.readBinary() }
  readTyped<T>(output: (value: T) => void): void { this.inner.readTyped(output) }
  readPointer<T>(assign: (value: T) => void, readLater: ReadLater): void {
    this.inner.readPointer(assign, readLater)
  }
  readMap(
    readKey: (r: IReader, assign: (key: unknown) => void) => void,
    readVal: (r: IReader, assign: (val: unknown) => void) => void
  ): Array<[unknown, unknown]> {
    return this.inner.readMap(readKey, readVal)
  }
}
