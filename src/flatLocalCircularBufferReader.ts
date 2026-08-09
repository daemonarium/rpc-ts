import type { CircularBuffer } from './CircularBuffer.js'
import { CodecRegistry } from './codec.js'
import { FlatReaderBase, type FlatPeekSource } from './flatReaderBase.js'

class CircularFlatPeekSource implements FlatPeekSource {
  constructor(private readonly buffer: CircularBuffer) {}

  size(): number {
    return this.buffer.readableBytes()
  }

  peek(offset: number, dest: Uint8Array): number {
    return this.buffer.peek(offset, dest, dest.length)
  }
}

/**
 * Flat LE reader over a CircularBuffer (peek-based).
 */
export class FlatLocalCircularBufferReader extends FlatReaderBase {
  constructor(buffer: CircularBuffer, codecs: CodecRegistry) {
    super(new CircularFlatPeekSource(buffer), codecs)
  }

  getReadOffset(): number {
    return this.getCursor()
  }

  setReadOffset(offset: number): void {
    this.setCursor(offset)
  }
}
