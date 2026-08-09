import { CodecRegistry } from './codec.js'
import { FlatWriterBase, Uint8ArrayFlatSink } from './flatWriterBase.js'

/**
 * Flat LE writer into a growable Uint8Array (ArrayBuffer backend).
 */
export class FlatWriter extends FlatWriterBase {
  private readonly arraySink: Uint8ArrayFlatSink

  constructor(codecs: CodecRegistry, initialCapacity = 1024) {
    const sink = new Uint8ArrayFlatSink(initialCapacity)
    super(sink, codecs)
    this.arraySink = sink
  }

  get size(): number {
    return this.arraySink.currentPos()
  }

  toUint8Array(): Uint8Array {
    return this.arraySink.toUint8Array().slice()
  }

  toArrayBuffer(): ArrayBuffer {
    const bytes = this.toUint8Array()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }
}
