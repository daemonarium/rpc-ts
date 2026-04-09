/**
 * ModuleCircularBuffer - TypeScript implementation that operates on WebAssembly memory
 * This mirrors the C circular_buffer implementation structure.
 * 
 * Structure in memory (circular_buffer_data):
 * In C, the struct is:
 *   struct circular_buffer_data {
 *     size_t size;
 *     size_t read_offset;
 *     size_t write_offset;
 *     char data[0];
 *   };
 * 
 * In WebAssembly (WASM32), size_t is 32-bit (4 bytes), so:
 * - offset 0-3: size (uint32)
 * - offset 4-7: read_offset (uint32)
 * - offset 8-11: write_offset (uint32)
 * - offset 12+: data
 * 
 * However, C code uses HEADER_SIZE = 8, which suggests that in the C build
 * size_t might be different, or HEADER_SIZE refers to something else.
 * For WebAssembly compatibility, we use 32-bit size_t and HEADER_SIZE = 12.
 * 
 * Note: If the C code was compiled for 64-bit, size_t would be 8 bytes each,
 * making HEADER_SIZE = 24. But since we're targeting WASM32, we use 32-bit.
 */

import { CircularBuffer } from './CircularBuffer.js'

const HEADER_SIZE = 12 // 2 * sizeof(uint32) for WASM32
const SIZE_OFFSET = 0
const READ_OFFSET_OFFSET = 4
const WRITE_OFFSET_OFFSET = 8
const DATA_OFFSET = 12

export class ModuleCircularBuffer implements CircularBuffer {
  private memory: WebAssembly.Memory
  private ptrAddress: number  // address in WASM memory where the circular_buffer_data* pointer is stored

  /**
   * Creates a ModuleCircularBuffer that operates on WebAssembly memory.
   * The buffer pointer is read dynamically from ptrAddress each time,
   * so it stays correct after circular_buffer_grow reallocations and memory growth.
   *
   * @param memory WebAssembly memory instance
   * @param ptrAddress Address in WASM memory where the pointer to circular_buffer_data is stored
   */
  constructor(memory: WebAssembly.Memory, ptrAddress: number) {
    this.memory = memory
    this.ptrAddress = ptrAddress
  }

  /**
   * Read the current circular_buffer_data pointer from WASM memory
   */
  private getBufferPtr(): number {
    return new DataView(this.memory.buffer).getUint32(this.ptrAddress, true)
  }

  private getView(): DataView {
    return new DataView(this.memory.buffer, this.getBufferPtr())
  }

  getSize(): number {
    return this.getView().getUint32(SIZE_OFFSET, true)
  }

  getReadOffset(): number {
    return this.getView().getUint32(READ_OFFSET_OFFSET, true)
  }

  setReadOffset(offset: number): void {
    this.getView().setUint32(READ_OFFSET_OFFSET, offset, true)
  }

  getWriteOffset(): number {
    return this.getView().getUint32(WRITE_OFFSET_OFFSET, true)
  }

  setWriteOffset(offset: number): void {
    this.getView().setUint32(WRITE_OFFSET_OFFSET, offset, true)
  }

  private getDataBuffer(): Uint8Array {
    const bufferPtr = this.getBufferPtr()
    const size = new DataView(this.memory.buffer, bufferPtr).getUint32(SIZE_OFFSET, true)
    return new Uint8Array(this.memory.buffer, bufferPtr + DATA_OFFSET, size - DATA_OFFSET)
  }

  /**
   * Get readable bytes count
   */
  readableBytes(): number {
    const readOffset = this.getReadOffset()
    const writeOffset = this.getWriteOffset()
    const bufferSize = this.getSize() - HEADER_SIZE

    if (readOffset <= writeOffset) {
      return writeOffset - readOffset
    } else {
      return bufferSize - readOffset + writeOffset
    }
  }

  /**
   * Get writable bytes count
   */
  writableBytes(): number {
    const readOffset = this.getReadOffset()
    const writeOffset = this.getWriteOffset()
    const bufferSize = this.getSize() - HEADER_SIZE

    if (readOffset <= writeOffset) {
      return bufferSize - writeOffset + readOffset - 1
    } else {
      return readOffset - writeOffset - 1
    }
  }

  /**
   * Get buffer capacity (usable data space)
   */
  capacity(): number {
    return this.getSize() - HEADER_SIZE - 1
  }

  /**
   * Write bytes to the buffer
   * @param source Source bytes to write
   * @param bytes Number of bytes to write
   * @returns Number of bytes actually written
   */
  write(source: Uint8Array | ArrayBufferView, bytes: number): number {
    const sourceArray = source instanceof Uint8Array 
      ? source 
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    
    const writeLength = Math.min(this.writableBytes(), bytes)
    if (writeLength === 0) return 0

    const writeOffset = this.getWriteOffset()
    const bufferSize = this.getSize() - HEADER_SIZE
    const dataBuffer = this.getDataBuffer()

    const writeAtEnd = Math.min(bufferSize - writeOffset, writeLength)
    const writeAtStart = writeLength - writeAtEnd

    if (writeAtEnd > 0) {
      dataBuffer.set(sourceArray.subarray(0, writeAtEnd), writeOffset)
    }
    if (writeAtStart > 0) {
      dataBuffer.set(sourceArray.subarray(writeAtEnd), 0)
    }

    const newWriteOffset = (writeOffset + writeLength) % bufferSize
    this.setWriteOffset(newWriteOffset)

    return writeLength
  }

  /**
   * Read bytes from the buffer
   * @param destination Destination buffer
   * @param bytes Number of bytes to read
   * @returns Number of bytes actually read
   */
  read(destination: Uint8Array, bytes: number): number {
    const readLength = Math.min(this.readableBytes(), bytes)
    if (readLength === 0) return 0

    const readOffset = this.getReadOffset()
    const bufferSize = this.getSize() - HEADER_SIZE
    const dataBuffer = this.getDataBuffer()

    const readAtEnd = Math.min(bufferSize - readOffset, readLength)
    const readAtStart = readLength - readAtEnd

    if (readAtEnd > 0) {
      destination.set(dataBuffer.subarray(readOffset, readOffset + readAtEnd), 0)
    }
    if (readAtStart > 0) {
      destination.set(dataBuffer.subarray(0, readAtStart), readAtEnd)
    }

    const newReadOffset = (readOffset + readLength) % bufferSize
    this.setReadOffset(newReadOffset)

    return readLength
  }

  /**
   * Peek bytes from the buffer without removing them
   * @param offset Offset from read position
   * @param destination Destination buffer
   * @param bytes Number of bytes to peek
   * @returns Number of bytes actually peeked
   */
  peek(offset: number, destination: Uint8Array, bytes: number): number {
    const readable = this.readableBytes()
    const readRequest = bytes + offset
    const readLength = Math.min(readable, readRequest)
    if (readLength === 0) return 0

    const readOffset = this.getReadOffset()
    const bufferSize = this.getSize() - HEADER_SIZE
    const dataBuffer = this.getDataBuffer()

    const readAtEnd = Math.min(bufferSize - readOffset, readLength)
    const readAtStart = readLength - readAtEnd

    if (readAtEnd > offset) {
      const peekAtEnd = readAtEnd - offset
      destination.set(dataBuffer.subarray(readOffset + offset, readOffset + readAtEnd), 0)
      if (readAtStart > 0) {
        destination.set(dataBuffer.subarray(0, readAtStart), peekAtEnd)
      }
    } else {
      const offsetRest = offset - readAtEnd
      const peekLength = readAtStart - offsetRest
      if (peekLength > 0) {
        destination.set(dataBuffer.subarray(offsetRest, offsetRest + peekLength), 0)
      }
    }

    return Math.max(0, readLength - offset)
  }

  /**
   * Poke bytes to the buffer without moving write offset
   * @param offset Offset from write position
   * @param source Source bytes
   * @param bytes Number of bytes to poke
   * @returns Number of bytes actually poked
   */
  poke(offset: number, source: Uint8Array | ArrayBufferView, bytes: number): number {
    const writable = this.writableBytes()
    const writeRequest = bytes + offset
    const writeLength = Math.min(writable, writeRequest)
    if (writeLength === 0) return 0

    const writeOffset = this.getWriteOffset()
    const bufferSize = this.getSize() - HEADER_SIZE
    const dataBuffer = this.getDataBuffer()

    const sourceArray = source instanceof Uint8Array 
      ? source 
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)

    const writeAtEnd = Math.min(bufferSize - writeOffset, writeLength)
    const writeAtStart = writeLength - writeAtEnd

    if (writeAtEnd > offset) {
      const pokeAtEnd = writeAtEnd - offset
      dataBuffer.set(sourceArray.subarray(0, pokeAtEnd), writeOffset + offset)
      if (writeAtStart > 0) {
        dataBuffer.set(sourceArray.subarray(pokeAtEnd), 0)
      }
    } else {
      const offsetRest = offset - writeAtEnd
      const pokeLength = writeAtEnd - offsetRest
      if (pokeLength > 0) {
        dataBuffer.set(sourceArray.subarray(0, pokeLength), offsetRest)
      }
    }

    return Math.max(0, writeLength - offset)
  }

  /**
   * Skip reading bytes
   * @param bytes Number of bytes to skip
   * @returns Number of bytes actually skipped
   */
  skipRead(bytes: number): number {
    const readLength = Math.min(this.readableBytes(), bytes)
    if (readLength === 0) return 0

    const readOffset = this.getReadOffset()
    const bufferSize = this.getSize() - HEADER_SIZE
    const newReadOffset = (readOffset + readLength) % bufferSize
    this.setReadOffset(newReadOffset)

    return readLength
  }

  /**
   * Commit write (move write offset forward)
   * @param bytes Number of bytes to commit
   * @returns Number of bytes actually committed
   */
  commitWrite(bytes: number): number {
    const writeLength = Math.min(this.writableBytes(), bytes)
    if (writeLength === 0) return 0

    const writeOffset = this.getWriteOffset()
    const bufferSize = this.getSize() - HEADER_SIZE
    const newWriteOffset = (writeOffset + writeLength) % bufferSize
    this.setWriteOffset(newWriteOffset)

    return writeLength
  }

  /**
   * Clear the buffer (reset offsets)
   */
  clear(): void {
    this.setReadOffset(0)
    this.setWriteOffset(0)
  }

  /**
   * Read unsigned varint
   * @returns Value and number of bytes read
   */
  readUVarInt(): { value: number | bigint, bytesRead: number } {
    const number = new Uint8Array(9)
    const firstRead = this.peek(0, number, 1)
    if (firstRead === 0) return { value: 0, bytesRead: 0 }

    const first = number[0]
    if ((first & 0x80) === 0) {
      // 7 bit number encoded in 1 byte
      this.skipRead(1)
      return { value: first, bytesRead: 1 }
    }
    if ((first & 0x40) === 0) {
      // 14 bit number encoded in 2 bytes
      const secondRead = this.peek(1, number.subarray(1), 1)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const value = ((first & 0x3F) << 8) | number[1]
      this.skipRead(2)
      return { value, bytesRead: 2 }
    }
    if ((first & 0x20) === 0) {
      // 21 bit number encoded in 3 bytes
      const secondRead = this.peek(1, number.subarray(1), 2)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const value = ((first & 0x1F) << 16) | (number[1] << 8) | number[2]
      this.skipRead(3)
      return { value, bytesRead: 3 }
    }
    if ((first & 0x10) === 0) {
      // 28 bit number encoded in 4 bytes
      const secondRead = this.peek(1, number.subarray(1), 3)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const value = ((first & 0x0F) << 24) | (number[1] << 16) | (number[2] << 8) | number[3]
      this.skipRead(4)
      return { value, bytesRead: 4 }
    }
    if ((first & 0x08) === 0) {
      // 35 bit number encoded in 5 bytes
      const secondRead = this.peek(1, number.subarray(1), 4)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const valueBig = (BigInt(first & 0x07) << 32n)
        | (BigInt(number[1]) << 24n)
        | (BigInt(number[2]) << 16n)
        | (BigInt(number[3]) << 8n)
        | BigInt(number[4])
      this.skipRead(5)
      if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(valueBig), bytesRead: 5 }
      }
      return { value: valueBig, bytesRead: 5 }
    }
    if ((first & 0x04) === 0) {
      // 42 bit number encoded in 6 bytes
      const secondRead = this.peek(1, number.subarray(1), 5)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const valueBig = (BigInt(first & 0x03) << 40n)
        | (BigInt(number[1]) << 32n)
        | (BigInt(number[2]) << 24n)
        | (BigInt(number[3]) << 16n)
        | (BigInt(number[4]) << 8n)
        | BigInt(number[5])
      this.skipRead(6)
      if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(valueBig), bytesRead: 6 }
      }
      return { value: valueBig, bytesRead: 6 }
    }
    if ((first & 0x02) === 0) {
      // 49 bit number encoded in 7 bytes
      const secondRead = this.peek(1, number.subarray(1), 6)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const valueBig = (BigInt(first & 0x01) << 48n)
        | (BigInt(number[1]) << 40n)
        | (BigInt(number[2]) << 32n)
        | (BigInt(number[3]) << 24n)
        | (BigInt(number[4]) << 16n)
        | (BigInt(number[5]) << 8n)
        | BigInt(number[6])
      this.skipRead(7)
      if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(valueBig), bytesRead: 7 }
      }
      return { value: valueBig, bytesRead: 7 }
    }
    if ((first & 0x01) === 0) {
      // 56 bit number encoded in 8 bytes
      const secondRead = this.peek(1, number.subarray(1), 7)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const valueBig = (BigInt(number[1]) << 48n)
        | (BigInt(number[2]) << 40n)
        | (BigInt(number[3]) << 32n)
        | (BigInt(number[4]) << 24n)
        | (BigInt(number[5]) << 16n)
        | (BigInt(number[6]) << 8n)
        | BigInt(number[7])
      this.skipRead(8)
      if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(valueBig), bytesRead: 8 }
      }
      return { value: valueBig, bytesRead: 8 }
    }
    // 64 bit number encoded in 9 bytes
    const secondRead = this.peek(1, number.subarray(1), 8)
    if (secondRead === 0) return { value: 0, bytesRead: 0 }
    const valueBig = (BigInt(number[1]) << 56n)
      | (BigInt(number[2]) << 48n)
      | (BigInt(number[3]) << 40n)
      | (BigInt(number[4]) << 32n)
      | (BigInt(number[5]) << 24n)
      | (BigInt(number[6]) << 16n)
      | (BigInt(number[7]) << 8n)
      | BigInt(number[8])
    this.skipRead(9)
    if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return { value: Number(valueBig), bytesRead: 9 }
    }
    return { value: valueBig, bytesRead: 9 }
  }

  /**
   * Peek unsigned varint at offset from read position (does not advance buffer).
   */
  peekUVarInt(offset: number): { value: number | bigint, bytesRead: number } {
    const number = new Uint8Array(9)
    const firstRead = this.peek(offset, number, 1)
    if (firstRead === 0) return { value: 0, bytesRead: 0 }

    const first = number[0]
    if ((first & 0x80) === 0) {
      return { value: first, bytesRead: 1 }
    }
    if ((first & 0x40) === 0) {
      const secondRead = this.peek(offset + 1, number.subarray(1), 1)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const value = ((first & 0x3F) << 8) | number[1]
      return { value, bytesRead: 2 }
    }
    if ((first & 0x20) === 0) {
      const secondRead = this.peek(offset + 1, number.subarray(1), 2)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const value = ((first & 0x1F) << 16) | (number[1] << 8) | number[2]
      return { value, bytesRead: 3 }
    }
    if ((first & 0x10) === 0) {
      const secondRead = this.peek(offset + 1, number.subarray(1), 3)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const value = ((first & 0x0F) << 24) | (number[1] << 16) | (number[2] << 8) | number[3]
      return { value, bytesRead: 4 }
    }
    if ((first & 0x08) === 0) {
      const secondRead = this.peek(offset + 1, number.subarray(1), 4)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const valueBig = (BigInt(first & 0x07) << 32n)
        | (BigInt(number[1]) << 24n)
        | (BigInt(number[2]) << 16n)
        | (BigInt(number[3]) << 8n)
        | BigInt(number[4])
      if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(valueBig), bytesRead: 5 }
      }
      return { value: valueBig, bytesRead: 5 }
    }
    if ((first & 0x04) === 0) {
      const secondRead = this.peek(offset + 1, number.subarray(1), 5)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const valueBig = (BigInt(first & 0x03) << 40n)
        | (BigInt(number[1]) << 32n)
        | (BigInt(number[2]) << 24n)
        | (BigInt(number[3]) << 16n)
        | (BigInt(number[4]) << 8n)
        | BigInt(number[5])
      if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(valueBig), bytesRead: 6 }
      }
      return { value: valueBig, bytesRead: 6 }
    }
    if ((first & 0x02) === 0) {
      const secondRead = this.peek(offset + 1, number.subarray(1), 6)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const valueBig = (BigInt(first & 0x01) << 48n)
        | (BigInt(number[1]) << 40n)
        | (BigInt(number[2]) << 32n)
        | (BigInt(number[3]) << 24n)
        | (BigInt(number[4]) << 16n)
        | (BigInt(number[5]) << 8n)
        | BigInt(number[6])
      if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(valueBig), bytesRead: 7 }
      }
      return { value: valueBig, bytesRead: 7 }
    }
    if ((first & 0x01) === 0) {
      const secondRead = this.peek(offset + 1, number.subarray(1), 7)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const valueBig = (BigInt(number[1]) << 48n)
        | (BigInt(number[2]) << 40n)
        | (BigInt(number[3]) << 32n)
        | (BigInt(number[4]) << 24n)
        | (BigInt(number[5]) << 16n)
        | (BigInt(number[6]) << 8n)
        | BigInt(number[7])
      if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(valueBig), bytesRead: 8 }
      }
      return { value: valueBig, bytesRead: 8 }
    }
    const secondRead = this.peek(offset + 1, number.subarray(1), 8)
    if (secondRead === 0) return { value: 0, bytesRead: 0 }
    const valueBig = (BigInt(number[1]) << 56n)
      | (BigInt(number[2]) << 48n)
      | (BigInt(number[3]) << 40n)
      | (BigInt(number[4]) << 32n)
      | (BigInt(number[5]) << 24n)
      | (BigInt(number[6]) << 16n)
      | (BigInt(number[7]) << 8n)
      | BigInt(number[8])
    if (valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return { value: Number(valueBig), bytesRead: 9 }
    }
    return { value: valueBig, bytesRead: 9 }
  }

  /**
   * Poke unsigned varint
   * @param offset Offset from write position
   * @param value Value to write
   * @returns Number of bytes written
   */
  pokeUVarInt(offset: number, value: number | bigint): number {
    const valueBig = typeof value === 'number' ? BigInt(value) : value
    if (valueBig < 0n) {
      throw new Error('UVarInt cannot be negative')
    }

    const bytes = new Uint8Array(9)
    let bytesWritten = 0

    if (valueBig < 0x80n) {
      // 7 bit number encoded in 1 byte
      bytes[0] = Number(valueBig)
      bytesWritten = 1
    } else if (valueBig < 0x4000n) {
      // 14 bit number encoded in 2 bytes
      bytes[0] = Number(0x80n | (valueBig >> 8n))
      bytes[1] = Number(valueBig & 0xFFn)
      bytesWritten = 2
    } else if (valueBig < 0x200000n) {
      // 21 bit number encoded in 3 bytes
      bytes[0] = Number(0xC0n | (valueBig >> 16n))
      bytes[1] = Number((valueBig >> 8n) & 0xFFn)
      bytes[2] = Number(valueBig & 0xFFn)
      bytesWritten = 3
    } else if (valueBig < 0x10000000n) {
      // 28 bit number encoded in 4 bytes
      bytes[0] = Number(0xE0n | (valueBig >> 24n))
      bytes[1] = Number((valueBig >> 16n) & 0xFFn)
      bytes[2] = Number((valueBig >> 8n) & 0xFFn)
      bytes[3] = Number(valueBig & 0xFFn)
      bytesWritten = 4
    } else if (valueBig < 0x800000000n) {
      // 35 bit number encoded in 5 bytes
      bytes[0] = Number(0xF0n | (valueBig >> 32n))
      bytes[1] = Number((valueBig >> 24n) & 0xFFn)
      bytes[2] = Number((valueBig >> 16n) & 0xFFn)
      bytes[3] = Number((valueBig >> 8n) & 0xFFn)
      bytes[4] = Number(valueBig & 0xFFn)
      bytesWritten = 5
    } else if (valueBig < 0x40000000000n) {
      // 42 bit number encoded in 6 bytes
      bytes[0] = Number(0xF8n | (valueBig >> 40n))
      bytes[1] = Number((valueBig >> 32n) & 0xFFn)
      bytes[2] = Number((valueBig >> 24n) & 0xFFn)
      bytes[3] = Number((valueBig >> 16n) & 0xFFn)
      bytes[4] = Number((valueBig >> 8n) & 0xFFn)
      bytes[5] = Number(valueBig & 0xFFn)
      bytesWritten = 6
    } else if (valueBig < 0x2000000000000n) {
      // 49 bit number encoded in 7 bytes
      bytes[0] = Number(0xFCn | (valueBig >> 48n))
      bytes[1] = Number((valueBig >> 40n) & 0xFFn)
      bytes[2] = Number((valueBig >> 32n) & 0xFFn)
      bytes[3] = Number((valueBig >> 24n) & 0xFFn)
      bytes[4] = Number((valueBig >> 16n) & 0xFFn)
      bytes[5] = Number((valueBig >> 8n) & 0xFFn)
      bytes[6] = Number(valueBig & 0xFFn)
      bytesWritten = 7
    } else if (valueBig < 0x100000000000000n) {
      // 56 bit number encoded in 8 bytes
      bytes[0] = 0xFE
      bytes[1] = Number((valueBig >> 48n) & 0xFFn)
      bytes[2] = Number((valueBig >> 40n) & 0xFFn)
      bytes[3] = Number((valueBig >> 32n) & 0xFFn)
      bytes[4] = Number((valueBig >> 24n) & 0xFFn)
      bytes[5] = Number((valueBig >> 16n) & 0xFFn)
      bytes[6] = Number((valueBig >> 8n) & 0xFFn)
      bytes[7] = Number(valueBig & 0xFFn)
      bytesWritten = 8
    } else {
      // 64 bit number encoded in 9 bytes
      bytes[0] = 0xFF
      bytes[1] = Number((valueBig >> 56n) & 0xFFn)
      bytes[2] = Number((valueBig >> 48n) & 0xFFn)
      bytes[3] = Number((valueBig >> 40n) & 0xFFn)
      bytes[4] = Number((valueBig >> 32n) & 0xFFn)
      bytes[5] = Number((valueBig >> 24n) & 0xFFn)
      bytes[6] = Number((valueBig >> 16n) & 0xFFn)
      bytes[7] = Number((valueBig >> 8n) & 0xFFn)
      bytes[8] = Number(valueBig & 0xFFn)
      bytesWritten = 9
    }

    const written = this.poke(offset, bytes.subarray(0, bytesWritten), bytesWritten)
    if (written !== bytesWritten) {
      throw new Error('Failed to write uvarint to circular buffer')
    }
    return bytesWritten
  }

  /**
   * Write unsigned varint
   * @param value Value to write
   * @returns Number of bytes written
   */
  writeUVarInt(value: number | bigint): number {
    const written = this.pokeUVarInt(0, value)
    this.commitWrite(written)
    return written
  }

  /**
   * Read signed varint (same encoding as C++ circular_buffer_peek_svarint).
   * Negative: length = leading zeros then a one. Positive: leading ones then a zero.
   */
  readSVarInt(): { value: number | bigint, bytesRead: number } {
    const number = new Uint8Array(9)
    const firstRead = this.peek(0, number, 1)
    if (firstRead === 0) return { value: 0, bytesRead: 0 }

    const first = number[0]
    const negative = (first & 0x80) === 0

    const ret = (value: number | bigint, bytesRead: number) => {
      this.skipRead(bytesRead)
      if (typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(value), bytesRead }
      }
      return { value, bytesRead }
    }

    if (negative) {
      if ((first & 0x40) !== 0) {
        return ret(-((~first) & 0x3F), 1)
      }
      if ((first & 0xE0) === 0x20) {
        const rest = this.peek(1, number.subarray(1), 1)
        if (rest === 0) return { value: 0, bytesRead: 0 }
        const encoded = ((first & 0x1F) << 8) | number[1]
        return ret(-(0x1FFF - encoded), 2)
      }
      if ((first & 0xF0) === 0x10) {
        const rest = this.peek(1, number.subarray(1), 2)
        if (rest < 2) return { value: 0, bytesRead: 0 }
        const encoded = ((first & 0x0F) << 16) | (number[1] << 8) | number[2]
        return ret(-(0xFFFFFn - BigInt(encoded)), 3)
      }
      if ((first & 0xF8) === 0x08) {
        const rest = this.peek(1, number.subarray(1), 3)
        if (rest < 3) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(first & 0x07) << 24n) | (BigInt(number[1]) << 16n) | (BigInt(number[2]) << 8n) | BigInt(number[3])
        return ret(-(0x7FFFFFFn - encoded), 4)
      }
      if ((first & 0xFC) === 0x04) {
        const rest = this.peek(1, number.subarray(1), 4)
        if (rest < 4) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(first & 0x03) << 32n) | (BigInt(number[1]) << 24n) | (BigInt(number[2]) << 16n) | (BigInt(number[3]) << 8n) | BigInt(number[4])
        return ret(-(0x3FFFFFFFFn - encoded), 5)
      }
      if ((first & 0xFE) === 0x02) {
        const rest = this.peek(1, number.subarray(1), 5)
        if (rest < 5) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(first & 0x01) << 40n) | (BigInt(number[1]) << 32n) | (BigInt(number[2]) << 24n) | (BigInt(number[3]) << 16n) | (BigInt(number[4]) << 8n) | BigInt(number[5])
        return ret(-(0x1FFFFFFFFFFn - encoded), 6)
      }
      if (first === 0x01) {
        const rest = this.peek(1, number.subarray(1), 6)
        if (rest < 6) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(number[1]) << 40n) | (BigInt(number[2]) << 32n) | (BigInt(number[3]) << 24n) | (BigInt(number[4]) << 16n) | (BigInt(number[5]) << 8n) | BigInt(number[6])
        return ret(-(0xFFFFFFFFFFFFn - encoded), 7)
      }
      const rest = this.peek(1, number.subarray(1), 8)
      if (rest < 8) return { value: 0, bytesRead: 0 }
      const encoded = (BigInt(number[1]) << 56n) | (BigInt(number[2]) << 48n) | (BigInt(number[3]) << 40n) | (BigInt(number[4]) << 32n) | (BigInt(number[5]) << 24n) | (BigInt(number[6]) << 16n) | (BigInt(number[7]) << 8n) | BigInt(number[8])
      return ret(-(0xFFFFFFFFFFFFFFFFn - encoded), 9)
    } else {
      if ((first & 0x40) === 0) {
        return ret(first & 0x3F, 1)
      }
      if ((first & 0x20) === 0) {
        const rest = this.peek(1, number.subarray(1), 1)
        if (rest === 0) return { value: 0, bytesRead: 0 }
        const encoded = ((first & 0x1F) << 8) | number[1]
        return ret(encoded, 2)
      }
      if ((first & 0x10) === 0) {
        const rest = this.peek(1, number.subarray(1), 2)
        if (rest < 2) return { value: 0, bytesRead: 0 }
        const encoded = ((first & 0x0F) << 16) | (number[1] << 8) | number[2]
        return ret(encoded, 3)
      }
      if ((first & 0x08) === 0) {
        const rest = this.peek(1, number.subarray(1), 3)
        if (rest < 3) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(first & 0x07) << 24n) | (BigInt(number[1]) << 16n) | (BigInt(number[2]) << 8n) | BigInt(number[3])
        return ret(encoded, 4)
      }
      if ((first & 0x04) === 0) {
        const rest = this.peek(1, number.subarray(1), 4)
        if (rest < 4) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(first & 0x03) << 32n) | (BigInt(number[1]) << 24n) | (BigInt(number[2]) << 16n) | (BigInt(number[3]) << 8n) | BigInt(number[4])
        return ret(encoded, 5)
      }
      if ((first & 0x02) === 0) {
        const rest = this.peek(1, number.subarray(1), 5)
        if (rest < 5) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(first & 0x01) << 40n) | (BigInt(number[1]) << 32n) | (BigInt(number[2]) << 24n) | (BigInt(number[3]) << 16n) | (BigInt(number[4]) << 8n) | BigInt(number[5])
        return ret(encoded, 6)
      }
      if ((first & 0x01) === 0) {
        const rest = this.peek(1, number.subarray(1), 6)
        if (rest < 6) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(number[1]) << 40n) | (BigInt(number[2]) << 32n) | (BigInt(number[3]) << 24n) | (BigInt(number[4]) << 16n) | (BigInt(number[5]) << 8n) | BigInt(number[6])
        return ret(encoded, 7)
      }
      const rest = this.peek(1, number.subarray(1), 8)
      if (rest < 8) return { value: 0, bytesRead: 0 }
      const encoded = (BigInt(number[1]) << 56n) | (BigInt(number[2]) << 48n) | (BigInt(number[3]) << 40n) | (BigInt(number[4]) << 32n) | (BigInt(number[5]) << 24n) | (BigInt(number[6]) << 16n) | (BigInt(number[7]) << 8n) | BigInt(number[8])
      return ret(encoded, 9)
    }
  }

  /**
   * Peek signed varint at offset from read position (does not advance buffer).
   */
  peekSVarInt(offset: number): { value: number | bigint, bytesRead: number } {
    const number = new Uint8Array(9)
    const firstRead = this.peek(offset, number, 1)
    if (firstRead === 0) return { value: 0, bytesRead: 0 }

    const first = number[0]
    const negative = (first & 0x80) === 0

    const retVal = (value: number | bigint, bytesRead: number) => {
      if (typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(value), bytesRead }
      }
      return { value, bytesRead }
    }

    if (negative) {
      if ((first & 0x40) !== 0) return retVal(-((~first) & 0x3F), 1)
      if ((first & 0xE0) === 0x20) {
        const rest = this.peek(offset + 1, number.subarray(1), 1)
        if (rest === 0) return { value: 0, bytesRead: 0 }
        const encoded = ((first & 0x1F) << 8) | number[1]
        return retVal(-(0x1FFF - encoded), 2)
      }
      if ((first & 0xF0) === 0x10) {
        const rest = this.peek(offset + 1, number.subarray(1), 2)
        if (rest < 2) return { value: 0, bytesRead: 0 }
        const encoded = ((first & 0x0F) << 16) | (number[1] << 8) | number[2]
        return retVal(-(0xFFFFFn - BigInt(encoded)), 3)
      }
      if ((first & 0xF8) === 0x08) {
        const rest = this.peek(offset + 1, number.subarray(1), 3)
        if (rest < 3) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(first & 0x07) << 24n) | (BigInt(number[1]) << 16n) | (BigInt(number[2]) << 8n) | BigInt(number[3])
        return retVal(-(0x7FFFFFFn - encoded), 4)
      }
      if ((first & 0xFC) === 0x04) {
        const rest = this.peek(offset + 1, number.subarray(1), 4)
        if (rest < 4) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(first & 0x03) << 32n) | (BigInt(number[1]) << 24n) | (BigInt(number[2]) << 16n) | (BigInt(number[3]) << 8n) | BigInt(number[4])
        return retVal(-(0x3FFFFFFFFn - encoded), 5)
      }
      if ((first & 0xFE) === 0x02) {
        const rest = this.peek(offset + 1, number.subarray(1), 5)
        if (rest < 5) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(first & 0x01) << 40n) | (BigInt(number[1]) << 32n) | (BigInt(number[2]) << 24n) | (BigInt(number[3]) << 16n) | (BigInt(number[4]) << 8n) | BigInt(number[5])
        return retVal(-(0x1FFFFFFFFFFn - encoded), 6)
      }
      if (first === 0x01) {
        const rest = this.peek(offset + 1, number.subarray(1), 6)
        if (rest < 6) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(number[1]) << 40n) | (BigInt(number[2]) << 32n) | (BigInt(number[3]) << 24n) | (BigInt(number[4]) << 16n) | (BigInt(number[5]) << 8n) | BigInt(number[6])
        return retVal(-(0xFFFFFFFFFFFFn - encoded), 7)
      }
      const rest = this.peek(offset + 1, number.subarray(1), 8)
      if (rest < 8) return { value: 0, bytesRead: 0 }
      const encoded = (BigInt(number[1]) << 56n) | (BigInt(number[2]) << 48n) | (BigInt(number[3]) << 40n) | (BigInt(number[4]) << 32n) | (BigInt(number[5]) << 24n) | (BigInt(number[6]) << 16n) | (BigInt(number[7]) << 8n) | BigInt(number[8])
      return retVal(-(0xFFFFFFFFFFFFFFFFn - encoded), 9)
    } else {
      if ((first & 0x40) === 0) return retVal(first & 0x3F, 1)
      if ((first & 0x20) === 0) {
        const rest = this.peek(offset + 1, number.subarray(1), 1)
        if (rest === 0) return { value: 0, bytesRead: 0 }
        const encoded = ((first & 0x1F) << 8) | number[1]
        return retVal(encoded, 2)
      }
      if ((first & 0x10) === 0) {
        const rest = this.peek(offset + 1, number.subarray(1), 2)
        if (rest < 2) return { value: 0, bytesRead: 0 }
        const encoded = ((first & 0x0F) << 16) | (number[1] << 8) | number[2]
        return retVal(encoded, 3)
      }
      if ((first & 0x08) === 0) {
        const rest = this.peek(offset + 1, number.subarray(1), 3)
        if (rest < 3) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(first & 0x07) << 24n) | (BigInt(number[1]) << 16n) | (BigInt(number[2]) << 8n) | BigInt(number[3])
        return retVal(encoded, 4)
      }
      if ((first & 0x04) === 0) {
        const rest = this.peek(offset + 1, number.subarray(1), 4)
        if (rest < 4) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(first & 0x03) << 32n) | (BigInt(number[1]) << 24n) | (BigInt(number[2]) << 16n) | (BigInt(number[3]) << 8n) | BigInt(number[4])
        return retVal(encoded, 5)
      }
      if ((first & 0x02) === 0) {
        const rest = this.peek(offset + 1, number.subarray(1), 5)
        if (rest < 5) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(first & 0x01) << 40n) | (BigInt(number[1]) << 32n) | (BigInt(number[2]) << 24n) | (BigInt(number[3]) << 16n) | (BigInt(number[4]) << 8n) | BigInt(number[5])
        return retVal(encoded, 6)
      }
      if ((first & 0x01) === 0) {
        const rest = this.peek(offset + 1, number.subarray(1), 6)
        if (rest < 6) return { value: 0, bytesRead: 0 }
        const encoded = (BigInt(number[1]) << 40n) | (BigInt(number[2]) << 32n) | (BigInt(number[3]) << 24n) | (BigInt(number[4]) << 16n) | (BigInt(number[5]) << 8n) | BigInt(number[6])
        return retVal(encoded, 7)
      }
      const rest = this.peek(offset + 1, number.subarray(1), 8)
      if (rest < 8) return { value: 0, bytesRead: 0 }
      const encoded = (BigInt(number[1]) << 56n) | (BigInt(number[2]) << 48n) | (BigInt(number[3]) << 40n) | (BigInt(number[4]) << 32n) | (BigInt(number[5]) << 24n) | (BigInt(number[6]) << 16n) | (BigInt(number[7]) << 8n) | BigInt(number[8])
      return retVal(encoded, 9)
    }
  }

  /**
   * Poke signed varint (same encoding as C++ circular_buffer_poke_svarint).
   * Negative: prefix 01 (1B), 001 (2B), ... Positive: prefix 10 (1B), 110 (2B), ...
   */
  pokeSVarInt(offset: number, value: number | bigint): number {
    const valueBig = typeof value === 'number' ? BigInt(value) : value
    const negative = valueBig < 0n
    const unsignedValue = negative ? -valueBig : valueBig

    const bytes = new Uint8Array(9)
    let bytesWritten = 0

    if (negative) {
      if (unsignedValue < 0x40n) {
        bytes[0] = Number(0x40n | ((~unsignedValue) & 0x3Fn))
        bytesWritten = 1
      } else if (unsignedValue < 0x2000n) {
        bytes[0] = Number(0x20n | (((~unsignedValue) >> 8n) & 0x1Fn))
        bytes[1] = Number((~unsignedValue) & 0xFFn)
        bytesWritten = 2
      } else if (unsignedValue < 0x100000n) {
        bytes[0] = Number(0x10n | (((~unsignedValue) >> 16n) & 0x0Fn))
        bytes[1] = Number(((~unsignedValue) >> 8n) & 0xFFn)
        bytes[2] = Number((~unsignedValue) & 0xFFn)
        bytesWritten = 3
      } else if (unsignedValue < 0x8000000n) {
        bytes[0] = Number(0x08n | (((~unsignedValue) >> 24n) & 0x07n))
        bytes[1] = Number(((~unsignedValue) >> 16n) & 0xFFn)
        bytes[2] = Number(((~unsignedValue) >> 8n) & 0xFFn)
        bytes[3] = Number((~unsignedValue) & 0xFFn)
        bytesWritten = 4
      } else if (unsignedValue < 0x400000000n) {
        bytes[0] = Number(0x04n | (((~unsignedValue) >> 32n) & 0x03n))
        bytes[1] = Number(((~unsignedValue) >> 24n) & 0xFFn)
        bytes[2] = Number(((~unsignedValue) >> 16n) & 0xFFn)
        bytes[3] = Number(((~unsignedValue) >> 8n) & 0xFFn)
        bytes[4] = Number((~unsignedValue) & 0xFFn)
        bytesWritten = 5
      } else if (unsignedValue < 0x20000000000n) {
        bytes[0] = Number(0x02n | (((~unsignedValue) >> 40n) & 0x01n))
        bytes[1] = Number(((~unsignedValue) >> 32n) & 0xFFn)
        bytes[2] = Number(((~unsignedValue) >> 24n) & 0xFFn)
        bytes[3] = Number(((~unsignedValue) >> 16n) & 0xFFn)
        bytes[4] = Number(((~unsignedValue) >> 8n) & 0xFFn)
        bytes[5] = Number((~unsignedValue) & 0xFFn)
        bytesWritten = 6
      } else if (unsignedValue < 0x1000000000000n) {
        bytes[0] = 0x01
        bytes[1] = Number(((~unsignedValue) >> 40n) & 0xFFn)
        bytes[2] = Number(((~unsignedValue) >> 32n) & 0xFFn)
        bytes[3] = Number(((~unsignedValue) >> 24n) & 0xFFn)
        bytes[4] = Number(((~unsignedValue) >> 16n) & 0xFFn)
        bytes[5] = Number(((~unsignedValue) >> 8n) & 0xFFn)
        bytes[6] = Number((~unsignedValue) & 0xFFn)
        bytesWritten = 7
      } else {
        bytes[0] = 0x00
        bytes[1] = Number(((~unsignedValue) >> 56n) & 0xFFn)
        bytes[2] = Number(((~unsignedValue) >> 48n) & 0xFFn)
        bytes[3] = Number(((~unsignedValue) >> 40n) & 0xFFn)
        bytes[4] = Number(((~unsignedValue) >> 32n) & 0xFFn)
        bytes[5] = Number(((~unsignedValue) >> 24n) & 0xFFn)
        bytes[6] = Number(((~unsignedValue) >> 16n) & 0xFFn)
        bytes[7] = Number(((~unsignedValue) >> 8n) & 0xFFn)
        bytes[8] = Number((~unsignedValue) & 0xFFn)
        bytesWritten = 9
      }
    } else {
      if (unsignedValue < 0x40n) {
        bytes[0] = Number(0x80n | unsignedValue)
        bytesWritten = 1
      } else if (unsignedValue < 0x2000n) {
        bytes[0] = Number(0x80n | 0x40n | (unsignedValue >> 8n))
        bytes[1] = Number(unsignedValue & 0xFFn)
        bytesWritten = 2
      } else if (unsignedValue < 0x100000n) {
        bytes[0] = Number(0x80n | 0x60n | (unsignedValue >> 16n))
        bytes[1] = Number((unsignedValue >> 8n) & 0xFFn)
        bytes[2] = Number(unsignedValue & 0xFFn)
        bytesWritten = 3
      } else if (unsignedValue < 0x8000000n) {
        bytes[0] = Number(0x80n | 0x70n | (unsignedValue >> 24n))
        bytes[1] = Number((unsignedValue >> 16n) & 0xFFn)
        bytes[2] = Number((unsignedValue >> 8n) & 0xFFn)
        bytes[3] = Number(unsignedValue & 0xFFn)
        bytesWritten = 4
      } else if (unsignedValue < 0x400000000n) {
        bytes[0] = Number(0x80n | 0x78n | (unsignedValue >> 32n))
        bytes[1] = Number((unsignedValue >> 24n) & 0xFFn)
        bytes[2] = Number((unsignedValue >> 16n) & 0xFFn)
        bytes[3] = Number((unsignedValue >> 8n) & 0xFFn)
        bytes[4] = Number(unsignedValue & 0xFFn)
        bytesWritten = 5
      } else if (unsignedValue < 0x20000000000n) {
        bytes[0] = Number(0x80n | 0x7Cn | (unsignedValue >> 40n))
        bytes[1] = Number((unsignedValue >> 32n) & 0xFFn)
        bytes[2] = Number((unsignedValue >> 24n) & 0xFFn)
        bytes[3] = Number((unsignedValue >> 16n) & 0xFFn)
        bytes[4] = Number((unsignedValue >> 8n) & 0xFFn)
        bytes[5] = Number(unsignedValue & 0xFFn)
        bytesWritten = 6
      } else if (unsignedValue < 0x1000000000000n) {
        bytes[0] = 0xFE
        bytes[1] = Number((unsignedValue >> 40n) & 0xFFn)
        bytes[2] = Number((unsignedValue >> 32n) & 0xFFn)
        bytes[3] = Number((unsignedValue >> 24n) & 0xFFn)
        bytes[4] = Number((unsignedValue >> 16n) & 0xFFn)
        bytes[5] = Number((unsignedValue >> 8n) & 0xFFn)
        bytes[6] = Number(unsignedValue & 0xFFn)
        bytesWritten = 7
      } else {
        bytes[0] = 0xFF
        bytes[1] = Number((unsignedValue >> 56n) & 0xFFn)
        bytes[2] = Number((unsignedValue >> 48n) & 0xFFn)
        bytes[3] = Number((unsignedValue >> 40n) & 0xFFn)
        bytes[4] = Number((unsignedValue >> 32n) & 0xFFn)
        bytes[5] = Number((unsignedValue >> 24n) & 0xFFn)
        bytes[6] = Number((unsignedValue >> 16n) & 0xFFn)
        bytes[7] = Number((unsignedValue >> 8n) & 0xFFn)
        bytes[8] = Number(unsignedValue & 0xFFn)
        bytesWritten = 9
      }
    }

    const written = this.poke(offset, bytes.subarray(0, bytesWritten), bytesWritten)
    if (written !== bytesWritten) {
      throw new Error('Failed to write svarint to circular buffer')
    }
    return bytesWritten
  }

  /**
   * Write signed varint
   * @param value Value to write
   * @returns Number of bytes written
   */
  writeSVarInt(value: number | bigint): number {
    const written = this.pokeSVarInt(0, value)
    this.commitWrite(written)
    return written
  }

  /** Peek unsigned 32-bit varint (same encoding as C circular_buffer_peek_uvarint32). */
  peekUVarInt32(offset: number): { value: number, bytesRead: number } {
    const number = new Uint8Array(5)
    const firstRead = this.peek(offset, number, 1)
    if (firstRead === 0) return { value: 0, bytesRead: 0 }
    const first = number[0]
    if ((first & 0x80) === 0) return { value: first, bytesRead: 1 }
    if ((first & 0x40) === 0) {
      const r = this.peek(offset + 1, number.subarray(1), 1)
      if (r === 0) return { value: 0, bytesRead: 0 }
      return { value: ((first & 0x3F) << 8) | number[1], bytesRead: 2 }
    }
    if ((first & 0x20) === 0) {
      const r = this.peek(offset + 1, number.subarray(1), 2)
      if (r === 0) return { value: 0, bytesRead: 0 }
      return { value: ((first & 0x1F) << 16) | (number[1] << 8) | number[2], bytesRead: 3 }
    }
    if ((first & 0x10) === 0) {
      const r = this.peek(offset + 1, number.subarray(1), 3)
      if (r === 0) return { value: 0, bytesRead: 0 }
      return { value: ((first & 0x0F) << 24) | (number[1] << 16) | (number[2] << 8) | number[3], bytesRead: 4 }
    }
    if ((first & 0x08) === 0) {
      const r = this.peek(offset + 1, number.subarray(1), 4)
      if (r === 0 || (first & 0x07) !== 0) return { value: 0, bytesRead: 0 }
      const v = (number[1] << 24) | (number[2] << 16) | (number[3] << 8) | number[4]
      return { value: v >>> 0, bytesRead: 5 }
    }
    return { value: 0, bytesRead: 0 }
  }

  pokeUVarInt32(offset: number, value: number): number {
    if (value < 0 || value > 0xFFFFFFFF) throw new Error('UVarInt32 out of range')
    const bytes = new Uint8Array(5)
    let n = 0
    if (value < 0x80) {
      bytes[0] = value
      n = 1
    } else if (value < 0x4000) {
      bytes[0] = 0x80 | (value >> 8)
      bytes[1] = value & 0xFF
      n = 2
    } else if (value < 0x200000) {
      bytes[0] = 0xC0 | (value >> 16)
      bytes[1] = (value >> 8) & 0xFF
      bytes[2] = value & 0xFF
      n = 3
    } else if (value < 0x10000000) {
      bytes[0] = 0xE0 | (value >> 24)
      bytes[1] = (value >> 16) & 0xFF
      bytes[2] = (value >> 8) & 0xFF
      bytes[3] = value & 0xFF
      n = 4
    } else {
      bytes[0] = 0xF0
      bytes[1] = (value >> 24) & 0xFF
      bytes[2] = (value >> 16) & 0xFF
      bytes[3] = (value >> 8) & 0xFF
      bytes[4] = value & 0xFF
      n = 5
    }
    const w = this.poke(offset, bytes.subarray(0, n), n)
    if (w !== n) throw new Error('Failed to poke uvarint32')
    return n
  }

  /** Peek signed 32-bit varint (same encoding as C circular_buffer_peek_svarint32). */
  peekSVarInt32(offset: number): { value: number, bytesRead: number } {
    const number = new Uint8Array(5)
    const firstRead = this.peek(offset, number, 1)
    if (firstRead === 0) return { value: 0, bytesRead: 0 }
    const first = number[0]
    const negative = (first & 0x80) === 0
    if (negative) {
      if ((first & 0x40) !== 0) return { value: -((~first) & 0x3F), bytesRead: 1 }
      if ((first & 0xE0) === 0x20) {
        const r = this.peek(offset + 1, number.subarray(1), 1)
        if (r === 0) return { value: 0, bytesRead: 0 }
        const enc = ((first & 0x1F) << 8) | number[1]
        return { value: -(0x1FFF - enc), bytesRead: 2 }
      }
      if ((first & 0xF0) === 0x10) {
        const r = this.peek(offset + 1, number.subarray(1), 2)
        if (r < 2) return { value: 0, bytesRead: 0 }
        const enc = ((first & 0x0F) << 16) | (number[1] << 8) | number[2]
        return { value: -(0xFFFFF - enc), bytesRead: 3 }
      }
      if ((first & 0xF8) === 0x08) {
        const r = this.peek(offset + 1, number.subarray(1), 3)
        if (r < 3) return { value: 0, bytesRead: 0 }
        const enc = ((first & 0x07) << 24) | (number[1] << 16) | (number[2] << 8) | number[3]
        return { value: -(0x7FFFFFF - enc), bytesRead: 4 }
      }
      if ((first & 0xFC) === 0x04) {
        const r = this.peek(offset + 1, number.subarray(1), 4)
        if (r < 4) return { value: 0, bytesRead: 0 }
        const enc = (first & 0x03) * 0x100000000 + (number[1] << 24) | (number[2] << 16) | (number[3] << 8) | number[4]
        const mag = 0x3FFFFFFFF - enc
        if (mag > 0x80000000) return { value: 0, bytesRead: 0 }
        return { value: -mag | 0, bytesRead: 5 }
      }
      return { value: 0, bytesRead: 0 }
    }
    if ((first & 0x40) === 0) return { value: first & 0x3F, bytesRead: 1 }
    if ((first & 0x20) === 0) {
      const r = this.peek(offset + 1, number.subarray(1), 1)
      if (r === 0) return { value: 0, bytesRead: 0 }
      return { value: ((first & 0x1F) << 8) | number[1], bytesRead: 2 }
    }
    if ((first & 0x10) === 0) {
      const r = this.peek(offset + 1, number.subarray(1), 2)
      if (r < 2) return { value: 0, bytesRead: 0 }
      return { value: ((first & 0x0F) << 16) | (number[1] << 8) | number[2], bytesRead: 3 }
    }
    if ((first & 0x08) === 0) {
      const r = this.peek(offset + 1, number.subarray(1), 3)
      if (r < 3) return { value: 0, bytesRead: 0 }
      const enc = ((first & 0x07) << 24) | (number[1] << 16) | (number[2] << 8) | number[3]
      if (enc > 0x7FFFFFFF) return { value: 0, bytesRead: 0 }
      return { value: enc, bytesRead: 4 }
    }
    if ((first & 0x04) === 0) {
      const r = this.peek(offset + 1, number.subarray(1), 4)
      if (r < 4 || (first & 0x03) !== 0) return { value: 0, bytesRead: 0 }
      const enc = (number[1] << 24) | (number[2] << 16) | (number[3] << 8) | number[4]
      if (enc > 0x7FFFFFFF) return { value: 0, bytesRead: 0 }
      return { value: enc, bytesRead: 5 }
    }
    return { value: 0, bytesRead: 0 }
  }

  pokeSVarInt32(offset: number, value: number): number {
    const u = value < 0 ? (-value) >>> 0 : value >>> 0
    const bytes = new Uint8Array(5)
    let n = 0
    if (value < 0) {
      if (u <= 0x3F) {
        bytes[0] = 0x40 | ((~u) & 0x3F)
        n = 1
      } else if (u <= 0x1FFF) {
        bytes[0] = 0x20 | (((~u) >> 8) & 0x1F)
        bytes[1] = (~u) & 0xFF
        n = 2
      } else if (u <= 0xFFFFF) {
        bytes[0] = 0x10 | (((~u) >> 16) & 0x0F)
        bytes[1] = ((~u) >> 8) & 0xFF
        bytes[2] = (~u) & 0xFF
        n = 3
      } else if (u <= 0x7FFFFFF) {
        bytes[0] = 0x08 | (((~u) >> 24) & 0x07)
        bytes[1] = ((~u) >> 16) & 0xFF
        bytes[2] = ((~u) >> 8) & 0xFF
        bytes[3] = (~u) & 0xFF
        n = 4
      } else {
        if (u > 0x80000000) throw new Error('SVarInt32 out of range')
        bytes[0] = 0x07
        bytes[1] = ((~u) >> 24) & 0xFF
        bytes[2] = ((~u) >> 16) & 0xFF
        bytes[3] = ((~u) >> 8) & 0xFF
        bytes[4] = (~u) & 0xFF
        n = 5
      }
    } else {
      if (u <= 0x3F) {
        bytes[0] = 0x80 | u
        n = 1
      } else if (u <= 0x1FFF) {
        bytes[0] = 0xC0 | (u >> 8)
        bytes[1] = u & 0xFF
        n = 2
      } else if (u <= 0xFFFFF) {
        bytes[0] = 0xE0 | (u >> 16)
        bytes[1] = (u >> 8) & 0xFF
        bytes[2] = u & 0xFF
        n = 3
      } else if (u <= 0x7FFFFFF) {
        bytes[0] = 0xF0 | (u >> 24)
        bytes[1] = (u >> 16) & 0xFF
        bytes[2] = (u >> 8) & 0xFF
        bytes[3] = u & 0xFF
        n = 4
      } else {
        bytes[0] = 0xF8
        bytes[1] = (u >> 24) & 0xFF
        bytes[2] = (u >> 16) & 0xFF
        bytes[3] = (u >> 8) & 0xFF
        bytes[4] = u & 0xFF
        n = 5
      }
    }
    const w = this.poke(offset, bytes.subarray(0, n), n)
    if (w !== n) throw new Error('Failed to poke svarint32')
    return n
  }

  peekUVarInt16(offset: number): { value: number, bytesRead: number } {
    const number = new Uint8Array(3)
    const firstRead = this.peek(offset, number, 1)
    if (firstRead === 0) return { value: 0, bytesRead: 0 }
    const first = number[0]
    if ((first & 0x80) === 0) return { value: first, bytesRead: 1 }
    if ((first & 0x40) === 0) {
      const r = this.peek(offset + 1, number.subarray(1), 1)
      if (r === 0) return { value: 0, bytesRead: 0 }
      return { value: ((first & 0x3F) << 8) | number[1], bytesRead: 2 }
    }
    if ((first & 0x20) === 0) {
      const r = this.peek(offset + 1, number.subarray(1), 2)
      if (r === 0 || (first & 0x1F) !== 0) return { value: 0, bytesRead: 0 }
      return { value: (number[1] << 8) | number[2], bytesRead: 3 }
    }
    return { value: 0, bytesRead: 0 }
  }

  pokeUVarInt16(offset: number, value: number): number {
    if (value < 0 || value > 0xFFFF) throw new Error('UVarInt16 out of range')
    const bytes = new Uint8Array(3)
    let n: number
    if (value < 0x80) {
      bytes[0] = value
      n = 1
    } else if (value < 0x4000) {
      bytes[0] = 0x80 | (value >> 8)
      bytes[1] = value & 0xFF
      n = 2
    } else {
      bytes[0] = 0xC0
      bytes[1] = (value >> 8) & 0xFF
      bytes[2] = value & 0xFF
      n = 3
    }
    const w = this.poke(offset, bytes.subarray(0, n), n)
    if (w !== n) throw new Error('Failed to poke uvarint16')
    return n
  }

  peekSVarInt16(offset: number): { value: number, bytesRead: number } {
    const number = new Uint8Array(3)
    const firstRead = this.peek(offset, number, 1)
    if (firstRead === 0) return { value: 0, bytesRead: 0 }
    const first = number[0]
    const negative = (first & 0x80) === 0
    if (negative) {
      if ((first & 0x40) !== 0) return { value: -((~first) & 0x3F), bytesRead: 1 }
      if ((first & 0xE0) === 0x20) {
        const r = this.peek(offset + 1, number.subarray(1), 1)
        if (r === 0) return { value: 0, bytesRead: 0 }
        const enc = ((first & 0x1F) << 8) | number[1]
        return { value: -(0x1FFF - enc), bytesRead: 2 }
      }
      if ((first & 0xF0) === 0x10) {
        const r = this.peek(offset + 1, number.subarray(1), 2)
        if (r < 2) return { value: 0, bytesRead: 0 }
        const enc = ((first & 0x0F) << 16) | (number[1] << 8) | number[2]
        const mag = 0xFFFFF - enc
        if (mag > 0x8000) return { value: 0, bytesRead: 0 }
        return { value: -mag, bytesRead: 3 }
      }
      return { value: 0, bytesRead: 0 }
    }
    if ((first & 0x40) === 0) return { value: first & 0x3F, bytesRead: 1 }
    if ((first & 0x20) === 0) {
      const r = this.peek(offset + 1, number.subarray(1), 1)
      if (r === 0) return { value: 0, bytesRead: 0 }
      return { value: ((first & 0x1F) << 8) | number[1], bytesRead: 2 }
    }
    if ((first & 0x10) === 0) {
      const r = this.peek(offset + 1, number.subarray(1), 2)
      if (r < 2 || (first & 0x0F) !== 0) return { value: 0, bytesRead: 0 }
      const enc = (number[1] << 8) | number[2]
      if (enc > 0x7FFF) return { value: 0, bytesRead: 0 }
      return { value: enc, bytesRead: 3 }
    }
    return { value: 0, bytesRead: 0 }
  }

  pokeSVarInt16(offset: number, value: number): number {
    const u = value < 0 ? (-value) & 0xFFFF : value & 0xFFFF
    const bytes = new Uint8Array(3)
    let n: number
    if (value < 0) {
      if (u <= 0x3F) {
        bytes[0] = 0x40 | ((~u) & 0x3F)
        n = 1
      } else if (u <= 0x1FFF) {
        bytes[0] = 0x20 | (((~u) >> 8) & 0x1F)
        bytes[1] = (~u) & 0xFF
        n = 2
      } else {
        if (u > 0x8000) throw new Error('SVarInt16 out of range')
        const encoded = 0xF0000 + (0xFFFF - u)
        bytes[0] = 0x10 | (encoded >> 16)
        bytes[1] = (encoded >> 8) & 0xFF
        bytes[2] = encoded & 0xFF
        n = 3
      }
    } else {
      if (u <= 0x3F) {
        bytes[0] = 0x80 | u
        n = 1
      } else if (u <= 0x1FFF) {
        bytes[0] = 0xC0 | (u >> 8)
        bytes[1] = u & 0xFF
        n = 2
      } else {
        bytes[0] = 0xE0
        bytes[1] = (u >> 8) & 0xFF
        bytes[2] = u & 0xFF
        n = 3
      }
    }
    const w = this.poke(offset, bytes.subarray(0, n), n)
    if (w !== n) throw new Error('Failed to poke svarint16')
    return n
  }

  copyTo(destination: CircularBuffer): number {
    const readableBytes = this.readableBytes()
    const writableBytes = destination.writableBytes()
    const copyBytes = Math.min(readableBytes, writableBytes)
    // read bytes from read offset to end of this buffer, by writing them to destination buffer
    const readOffset = this.getReadOffset()
    const bufferSize = this.getSize() - HEADER_SIZE
    const readAtEnd = Math.min(bufferSize - readOffset, copyBytes)
    const readAtStart = copyBytes - readAtEnd
    const dataBuffer = this.getDataBuffer()
    
    if (readAtEnd > 0) {
      destination.write(dataBuffer.subarray(readOffset, readOffset + readAtEnd), readAtEnd)
    }
    if (readAtStart > 0) {
      destination.write(dataBuffer.subarray(0, readAtStart), readAtStart)
    }
    
    // Advance read offset
    const newReadOffset = (readOffset + copyBytes) % bufferSize
    this.setReadOffset(newReadOffset)
    
    return copyBytes
  }
}

