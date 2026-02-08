/**
 * LocalCircularBuffer - TypeScript implementation that uses local memory buffer
 * This implements the same circular buffer logic as MemoryCircularBuffer but
 * uses a local ArrayBuffer instead of WebAssembly memory, and allows resizing.
 */

import { CircularBuffer } from './CircularBuffer.js'

const HEADER_SIZE = 12 // 3 * sizeof(uint32) for consistency with MemoryCircularBuffer
const SIZE_OFFSET = 0
const READ_OFFSET_OFFSET = 4
const WRITE_OFFSET_OFFSET = 8
const DATA_OFFSET = 12

/**
 * Default function to calculate new buffer size (nearest power of two)
 */
function defaultNewLength(requestedLength: number): number {
  let newLength = 1
  while (newLength < requestedLength) {
    newLength <<= 1
  }
  return newLength
}

export class LocalCircularBuffer implements CircularBuffer {
  private buffer: ArrayBuffer
  private dataView: DataView
  private uint8View: Uint8Array
  private newLengthCallback: (requestedLength: number) => number

  /**
   * Creates a LocalCircularBuffer with local memory buffer
   * @param initialSize Initial capacity of the buffer (data space, excluding header)
   * @param newLengthCallback Optional callback to calculate new buffer size when resizing
   */
  constructor(initialSize: number, newLengthCallback?: (requestedLength: number) => number) {
    this.newLengthCallback = newLengthCallback || defaultNewLength
    const totalSize = initialSize + HEADER_SIZE + 1 // +1 so read_offset != write_offset means buffer is full
    this.buffer = new ArrayBuffer(totalSize)
    this.dataView = new DataView(this.buffer)
    this.uint8View = new Uint8Array(this.buffer)
    
    // Initialize header
    this.dataView.setUint32(SIZE_OFFSET, totalSize, true)
    this.dataView.setUint32(READ_OFFSET_OFFSET, 0, true)
    this.dataView.setUint32(WRITE_OFFSET_OFFSET, 0, true)
  }

  /**
   * Get the size of the buffer (total capacity including header)
   */
  getSize(): number {
    return this.dataView.getUint32(SIZE_OFFSET, true)
  }

  /**
   * Get read offset
   */
  getReadOffset(): number {
    return this.dataView.getUint32(READ_OFFSET_OFFSET, true)
  }

  /**
   * Set read offset
   */
  setReadOffset(offset: number): void {
    this.dataView.setUint32(READ_OFFSET_OFFSET, offset, true)
  }

  /**
   * Get write offset
   */
  getWriteOffset(): number {
    return this.dataView.getUint32(WRITE_OFFSET_OFFSET, true)
  }

  /**
   * Set write offset
   */
  setWriteOffset(offset: number): void {
    this.dataView.setUint32(WRITE_OFFSET_OFFSET, offset, true)
  }

  /**
   * Get the data buffer (Uint8Array view of the data portion)
   */
  private getDataBuffer(): Uint8Array {
    const size = this.getSize()
    return new Uint8Array(this.buffer, DATA_OFFSET, size - DATA_OFFSET)
  }

  /**
   * Get readable bytes count
   */
  readableBytes(): number {
    const readOffset = this.getReadOffset()
    const writeOffset = this.getWriteOffset()
    const bufferSize = this.getSize() - DATA_OFFSET

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
    const bufferSize = this.getSize() - DATA_OFFSET

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
    return this.getSize() - DATA_OFFSET - 1
  }

  /**
   * Grow the buffer to accommodate at least newMinimumSize bytes
   * @param newMinimumSize Minimum new capacity (data space, excluding header)
   * @returns New capacity
   */
  grow(newMinimumSize: number): number {
    const currentDataSize = this.getSize() - DATA_OFFSET - 1
    if (newMinimumSize <= currentDataSize) {
      return currentDataSize
    }

    const newTotalSize = this.newLengthCallback(newMinimumSize + HEADER_SIZE + 1)
    const oldBufferSize = this.getSize() - DATA_OFFSET
    const newBufferLength = newTotalSize - DATA_OFFSET
    const bufferIncrement = newBufferLength - oldBufferSize

    // Create new buffer
    const newBuffer = new ArrayBuffer(newTotalSize)
    const newDataView = new DataView(newBuffer)
    const newUint8View = new Uint8Array(newBuffer)

    // Copy header
    newDataView.setUint32(SIZE_OFFSET, newTotalSize, true)
    const readOffset = this.getReadOffset()
    const writeOffset = this.getWriteOffset()
    newDataView.setUint32(READ_OFFSET_OFFSET, readOffset, true)
    newDataView.setUint32(WRITE_OFFSET_OFFSET, writeOffset, true)

    // Copy data
    const oldDataBuffer = this.getDataBuffer()
    const newDataBuffer = new Uint8Array(newBuffer, DATA_OFFSET, newBufferLength)

    if (readOffset <= writeOffset) {
      // Data is contiguous, copy it directly
      newDataBuffer.set(oldDataBuffer.subarray(readOffset, writeOffset), readOffset)
    } else {
      // Data wraps around, need to move read offset
      const newReadOffset = readOffset + bufferIncrement
      const bytesToMove = oldBufferSize - readOffset
      
      // Copy data from old read offset to end
      newDataBuffer.set(
        oldDataBuffer.subarray(readOffset, oldBufferSize),
        newReadOffset
      )
      // Copy data from start to write offset
      newDataBuffer.set(
        oldDataBuffer.subarray(0, writeOffset),
        0
      )
      
      newDataView.setUint32(READ_OFFSET_OFFSET, newReadOffset, true)
    }

    // Update references
    this.buffer = newBuffer
    this.dataView = newDataView
    this.uint8View = newUint8View

    return newBufferLength - 1
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
    const bufferSize = this.getSize() - DATA_OFFSET
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
    const bufferSize = this.getSize() - DATA_OFFSET
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
    const bufferSize = this.getSize() - DATA_OFFSET
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
    const bufferSize = this.getSize() - DATA_OFFSET
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
    const bufferSize = this.getSize() - DATA_OFFSET
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
    const bufferSize = this.getSize() - DATA_OFFSET
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
    const written =  this.pokeUVarInt(0, value)
    this.commitWrite(written)
    return written  
  }

  /**
   * Read signed varint
   * @returns Value and number of bytes read
   */
  readSVarInt(): { value: number | bigint, bytesRead: number } {
    const number = new Uint8Array(9)
    const firstRead = this.peek(0, number, 1)
    if (firstRead === 0) return { value: 0, bytesRead: 0 }

    const first = number[0]
    const negative = (first & 0x80) === 0

    if ((first & 0x40) === 0) {
      // 6 bit signed number encoded in 1 byte
      const raw = first & 0x3F
      const mask = 0x3F
      const value = negative ? -(((~raw) & mask)) : raw
      this.skipRead(1)
      return { value, bytesRead: 1 }
    }
    if ((first & 0x20) === 0) {
      // 13 bit signed number encoded in 2 bytes
      const secondRead = this.peek(1, number.subarray(1), 1)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const raw = ((first & 0x1F) << 8) | number[1]
      const mask = 0x3FFF
      const value = negative ? -(((~raw) & mask)) : raw
      this.skipRead(2)
      return { value, bytesRead: 2 }
    }
    if ((first & 0x10) === 0) {
      // 20 bit signed number encoded in 3 bytes
      const secondRead = this.peek(1, number.subarray(1), 2)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const raw = ((first & 0x0F) << 16) | (number[1] << 8) | number[2]
      const mask = 0x1FFFF
      const value = negative ? -(((~raw) & mask)) : raw
      this.skipRead(3)
      return { value, bytesRead: 3 }
    }
    if ((first & 0x08) === 0) {
      // 27 bit signed number encoded in 4 bytes
      const secondRead = this.peek(1, number.subarray(1), 3)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const raw = ((first & 0x07) << 24) | (number[1] << 16) | (number[2] << 8) | number[3]
      const mask = 0xFFFFFF
      const value = negative ? -(((~raw) & mask)) : raw
      this.skipRead(4)
      return { value, bytesRead: 4 }
    }
    if ((first & 0x04) === 0) {
      // 34 bit signed number encoded in 5 bytes
      const secondRead = this.peek(1, number.subarray(1), 4)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const rawBig = (BigInt(first & 0x03) << 32n)
        | (BigInt(number[1]) << 24n)
        | (BigInt(number[2]) << 16n)
        | (BigInt(number[3]) << 8n)
        | BigInt(number[4])
      const mask = BigInt('0x7FFFFFFF')
      const valueBig = negative ? -(((~rawBig) & mask)) : rawBig
      this.skipRead(5)
      if (valueBig >= BigInt(Number.MIN_SAFE_INTEGER) && valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(valueBig), bytesRead: 5 }
      }
      return { value: valueBig, bytesRead: 5 }
    }
    if ((first & 0x02) === 0) {
      // 41 bit signed number encoded in 6 bytes
      const secondRead = this.peek(1, number.subarray(1), 5)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const rawBig = (BigInt(first & 0x01) << 40n)
        | (BigInt(number[1]) << 32n)
        | (BigInt(number[2]) << 24n)
        | (BigInt(number[3]) << 16n)
        | (BigInt(number[4]) << 8n)
        | BigInt(number[5])
      const mask = BigInt('0x7FFFFFFFFF')
      const valueBig = negative ? -(((~rawBig) & mask)) : rawBig
      this.skipRead(6)
      if (valueBig >= BigInt(Number.MIN_SAFE_INTEGER) && valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(valueBig), bytesRead: 6 }
      }
      return { value: valueBig, bytesRead: 6 }
    }
    if ((first & 0x01) === 0) {
      // 48 bit signed number encoded in 7 bytes
      const secondRead = this.peek(1, number.subarray(1), 6)
      if (secondRead === 0) return { value: 0, bytesRead: 0 }
      const rawBig = (BigInt(number[1]) << 40n)
        | (BigInt(number[2]) << 32n)
        | (BigInt(number[3]) << 24n)
        | (BigInt(number[4]) << 16n)
        | (BigInt(number[5]) << 8n)
        | BigInt(number[6])
      const mask = BigInt('0x7FFFFFFFFFFFFF')
      const valueBig = negative ? -(((~rawBig) & mask)) : rawBig
      this.skipRead(7)
      if (valueBig >= BigInt(Number.MIN_SAFE_INTEGER) && valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return { value: Number(valueBig), bytesRead: 7 }
      }
      return { value: valueBig, bytesRead: 7 }
    }
    // 64 bit signed number encoded in 9 bytes
    const secondRead = this.peek(1, number.subarray(1), 8)
    if (secondRead === 0) return { value: 0, bytesRead: 0 }
    const rawBig = (BigInt(number[1]) << 56n)
      | (BigInt(number[2]) << 48n)
      | (BigInt(number[3]) << 40n)
      | (BigInt(number[4]) << 32n)
      | (BigInt(number[5]) << 24n)
      | (BigInt(number[6]) << 16n)
      | (BigInt(number[7]) << 8n)
      | BigInt(number[8])
    const mask = BigInt('0x7FFFFFFFFFFFFFFF')
    const valueBig = negative ? -(((~rawBig) & mask)) : rawBig
    this.skipRead(9)
    if (valueBig >= BigInt(Number.MIN_SAFE_INTEGER) && valueBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return { value: Number(valueBig), bytesRead: 9 }
    }
    return { value: valueBig, bytesRead: 9 }
  }

  /**
   * Poke signed varint
   * @param value Value to write
   * @returns Number of bytes written
   */
  pokeSVarInt(offset: number, value: number | bigint): number {
    const valueBig = typeof value === 'number' ? BigInt(value) : value
    const negative = valueBig < 0n
    const unsignedValue = negative ? -valueBig : valueBig

    const bytes = new Uint8Array(9)
    let bytesWritten = 0

    if (unsignedValue < 0x40n) {
      // 6 bit signed number encoded in 1 byte
      const byte = negative
        ? Number((~unsignedValue) & 0x3Fn)
        : Number(0x80n | unsignedValue)
      bytes[0] = byte
      bytesWritten = 1
    } else if (unsignedValue < 0x2000n) {
      // 13 bit signed number encoded in 2 bytes
      if (negative) {
        bytes[0] = Number(0x40n | (((~unsignedValue) >> 8n) & 0x1Fn))
        bytes[1] = Number((~unsignedValue) & 0xFFn)
      } else {
        bytes[0] = Number(0xC0n | (unsignedValue >> 8n))
        bytes[1] = Number(unsignedValue & 0xFFn)
      }
      bytesWritten = 2
    } else if (unsignedValue < 0x100000n) {
      // 20 bit signed number encoded in 3 bytes
      if (negative) {
        bytes[0] = Number(0x60n | (((~unsignedValue) >> 16n) & 0x0Fn))
        bytes[1] = Number(((~unsignedValue) >> 8n) & 0xFFn)
        bytes[2] = Number((~unsignedValue) & 0xFFn)
      } else {
        bytes[0] = Number(0xE0n | (unsignedValue >> 16n))
        bytes[1] = Number((unsignedValue >> 8n) & 0xFFn)
        bytes[2] = Number(unsignedValue & 0xFFn)
      }
      bytesWritten = 3
    } else if (unsignedValue < 0x8000000n) {
      // 27 bit signed number encoded in 4 bytes
      if (negative) {
        bytes[0] = Number(0x70n | (((~unsignedValue) >> 24n) & 0x07n))
        bytes[1] = Number(((~unsignedValue) >> 16n) & 0xFFn)
        bytes[2] = Number(((~unsignedValue) >> 8n) & 0xFFn)
        bytes[3] = Number((~unsignedValue) & 0xFFn)
      } else {
        bytes[0] = Number(0xF0n | (unsignedValue >> 24n))
        bytes[1] = Number((unsignedValue >> 16n) & 0xFFn)
        bytes[2] = Number((unsignedValue >> 8n) & 0xFFn)
        bytes[3] = Number(unsignedValue & 0xFFn)
      }
      bytesWritten = 4
    } else if (unsignedValue < 0x400000000n) {
      // 34 bit signed number encoded in 5 bytes
      if (negative) {
        bytes[0] = Number(0x78n | (((~unsignedValue) >> 32n) & 0x03n))
        bytes[1] = Number(((~unsignedValue) >> 24n) & 0xFFn)
        bytes[2] = Number(((~unsignedValue) >> 16n) & 0xFFn)
        bytes[3] = Number(((~unsignedValue) >> 8n) & 0xFFn)
        bytes[4] = Number((~unsignedValue) & 0xFFn)
      } else {
        bytes[0] = Number(0xF8n | (unsignedValue >> 32n))
        bytes[1] = Number((unsignedValue >> 24n) & 0xFFn)
        bytes[2] = Number((unsignedValue >> 16n) & 0xFFn)
        bytes[3] = Number((unsignedValue >> 8n) & 0xFFn)
        bytes[4] = Number(unsignedValue & 0xFFn)
      }
      bytesWritten = 5
    } else if (unsignedValue < 0x20000000000n) {
      // 41 bit signed number encoded in 6 bytes
      if (negative) {
        bytes[0] = Number(0x7Cn | (((~unsignedValue) >> 40n) & 0x01n))
        bytes[1] = Number(((~unsignedValue) >> 32n) & 0xFFn)
        bytes[2] = Number(((~unsignedValue) >> 24n) & 0xFFn)
        bytes[3] = Number(((~unsignedValue) >> 16n) & 0xFFn)
        bytes[4] = Number(((~unsignedValue) >> 8n) & 0xFFn)
        bytes[5] = Number((~unsignedValue) & 0xFFn)
      } else {
        bytes[0] = Number(0xFCn | (unsignedValue >> 40n))
        bytes[1] = Number((unsignedValue >> 32n) & 0xFFn)
        bytes[2] = Number((unsignedValue >> 24n) & 0xFFn)
        bytes[3] = Number((unsignedValue >> 16n) & 0xFFn)
        bytes[4] = Number((unsignedValue >> 8n) & 0xFFn)
        bytes[5] = Number(unsignedValue & 0xFFn)
      }
      bytesWritten = 6
    } else if (unsignedValue < 0x1000000000000n) {
      // 48 bit signed number encoded in 7 bytes
      if (negative) {
        bytes[0] = 0x7E
        bytes[1] = Number(((~unsignedValue) >> 40n) & 0xFFn)
        bytes[2] = Number(((~unsignedValue) >> 32n) & 0xFFn)
        bytes[3] = Number(((~unsignedValue) >> 24n) & 0xFFn)
        bytes[4] = Number(((~unsignedValue) >> 16n) & 0xFFn)
        bytes[5] = Number(((~unsignedValue) >> 8n) & 0xFFn)
        bytes[6] = Number((~unsignedValue) & 0xFFn)
      } else {
        bytes[0] = 0xFE
        bytes[1] = Number((unsignedValue >> 40n) & 0xFFn)
        bytes[2] = Number((unsignedValue >> 32n) & 0xFFn)
        bytes[3] = Number((unsignedValue >> 24n) & 0xFFn)
        bytes[4] = Number((unsignedValue >> 16n) & 0xFFn)
        bytes[5] = Number((unsignedValue >> 8n) & 0xFFn)
        bytes[6] = Number(unsignedValue & 0xFFn)
      }
      bytesWritten = 7
    } else {
      // 64 bit signed number encoded in 9 bytes
      if (negative) {
        bytes[0] = 0x7F
        bytes[1] = Number(((~unsignedValue) >> 56n) & 0xFFn)
        bytes[2] = Number(((~unsignedValue) >> 48n) & 0xFFn)
        bytes[3] = Number(((~unsignedValue) >> 40n) & 0xFFn)
        bytes[4] = Number(((~unsignedValue) >> 32n) & 0xFFn)
        bytes[5] = Number(((~unsignedValue) >> 24n) & 0xFFn)
        bytes[6] = Number(((~unsignedValue) >> 16n) & 0xFFn)
        bytes[7] = Number(((~unsignedValue) >> 8n) & 0xFFn)
        bytes[8] = Number((~unsignedValue) & 0xFFn)
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
      }
      bytesWritten = 9
    }

    const written = this.write(bytes.subarray(0, bytesWritten), bytesWritten)
    if (written !== bytesWritten) {
      throw new Error('Failed to write svarint to circular buffer')
    }
    return bytesWritten
  }

  writeSVarInt(value: number | bigint): number {
    const written = this.pokeSVarInt(0, value)
    this.commitWrite(written)
    return written
  }

  /**
   * Copy data from this buffer to destination buffer
   * @param destination Destination buffer
   * @returns Number of bytes copied
   */
  copyTo(destination: CircularBuffer): number {
    const readableBytes = this.readableBytes()
    const writableBytes = destination.writableBytes()
    const copyBytes = Math.min(readableBytes, writableBytes)
    // read bytes from read offset to end of this buffer, by writing them to destination buffer
    const readOffset = this.getReadOffset()
    const bufferSize = this.getSize() - DATA_OFFSET
    const readAtEnd = Math.min(bufferSize - readOffset, copyBytes)
    const readAtStart = copyBytes - readAtEnd
    const dataBuffer = this.getDataBuffer()
    
    if (readAtEnd > 0) {
      destination.write(dataBuffer.subarray(readOffset, readOffset + readAtEnd), readAtEnd)
    }
    if (readAtStart > 0) {
      destination.write(dataBuffer.subarray(0, readAtStart), readAtEnd)
    }
    
    // Advance read offset
    const newReadOffset = (readOffset + copyBytes) % bufferSize
    this.setReadOffset(newReadOffset)
    
    return copyBytes
  }
}
