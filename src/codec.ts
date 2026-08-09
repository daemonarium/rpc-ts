import type { IWriter, IReader } from './writerTypes.js'

export interface TypedValue {
  _type: string
  [key: string]: unknown
}

export type Serializer<T = unknown> = (writer: IWriter, value: T) => void
export type Deserializer<T = unknown> = (reader: IReader, output: (value: T) => void) => void

export interface Codec<T = unknown> {
  name: string
  serialize: Serializer<T>
  deserialize: Deserializer<T>
}

export class CodecChannel {
  private codecs: Codec[] = []
  private indexByName = new Map<string, number>()

  register<T>(codec: Codec<T>): number {
    if (this.indexByName.has(codec.name)) {
      throw new Error(`Codec ${codec.name} already registered`)
    }
    const index = this.codecs.length
    this.codecs.push(codec)
    this.indexByName.set(codec.name, index)
    return index
  }

  getIndexOrThrow(name: string): number {
    const index = this.indexByName.get(name)
    if (index === undefined) {
      throw new Error(`Codec ${name} not registered`)
    }
    return index
  }

  getByIndex(index: number): Codec {
    const codec = this.codecs[index]
    if (!codec) {
      throw new Error(`Codec at index ${index} not registered`)
    }
    return codec
  }

  has(name: string): boolean {
    return this.indexByName.has(name)
  }

  replace<T>(codec: Codec<T>): void {
    this.codecs[this.indexByName.get(codec.name)] = codec
  }
}

export class CodecRegistry {
  readonly typed = new CodecChannel()
  readonly messages = new CodecChannel()
  readonly exceptions = new CodecChannel()
}
