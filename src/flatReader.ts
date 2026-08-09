import { CodecRegistry } from './codec.js'
import { FlatReaderBase, Uint8ArrayFlatSource } from './flatReaderBase.js'

/**
 * Flat LE reader over a contiguous ArrayBuffer / Uint8Array.
 */
export class FlatReader extends FlatReaderBase {
  constructor(source: ArrayBufferLike | ArrayBufferView | Uint8Array, codecs: CodecRegistry) {
    super(new Uint8ArrayFlatSource(source), codecs)
  }
}
