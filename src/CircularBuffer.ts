/**
 * CircularBuffer interface - common interface for circular buffer implementations
 */
export interface CircularBuffer {
  /**
   * Get the size of the buffer (total capacity including header)
   */
  getSize(): number

  /**
   * Get read offset
   */
  getReadOffset(): number

  /**
   * Set read offset
   */
  setReadOffset(offset: number): void

  /**
   * Get write offset
   */
  getWriteOffset(): number

  /**
   * Set write offset
   */
  setWriteOffset(offset: number): void

  /**
   * Get readable bytes count
   */
  readableBytes(): number

  /**
   * Get writable bytes count
   */
  writableBytes(): number

  /**
   * Get buffer capacity (usable data space)
   */
  capacity(): number

  /**
   * Write bytes to the buffer
   * @param source Source bytes to write
   * @param bytes Number of bytes to write
   * @returns Number of bytes actually written
   */
  write(source: Uint8Array | ArrayBufferView, bytes: number): number

  /**
   * Read bytes from the buffer
   * @param destination Destination buffer
   * @param bytes Number of bytes to read
   * @returns Number of bytes actually read
   */
  read(destination: Uint8Array, bytes: number): number

  /**
   * Peek bytes from the buffer without removing them
   * @param offset Offset from read position
   * @param destination Destination buffer
   * @param bytes Number of bytes to peek
   * @returns Number of bytes actually peeked
   */
  peek(offset: number, destination: Uint8Array, bytes: number): number

  /**
   * Poke bytes to the buffer without moving write offset
   * @param offset Offset from write position
   * @param source Source bytes
   * @param bytes Number of bytes to poke
   * @returns Number of bytes actually poked
   */
  poke(offset: number, source: Uint8Array | ArrayBufferView, bytes: number): number

  /**
   * Skip reading bytes
   * @param bytes Number of bytes to skip
   * @returns Number of bytes actually skipped
   */
  skipRead(bytes: number): number

  /**
   * Commit write (move write offset forward)
   * @param bytes Number of bytes to commit
   * @returns Number of bytes actually committed
   */
  commitWrite(bytes: number): number

  /**
   * Clear the buffer (reset offsets)
   */
  clear(): void

  /**
   * Read unsigned varint
   * @returns Value and number of bytes read
   */
  readUVarInt(): { value: number | bigint, bytesRead: number }

  /**
   * Write unsigned varint
   * @param value Value to write
   * @returns Number of bytes written
   */
  writeUVarInt(value: number | bigint): number

  /**
   * Read signed varint
   * @returns Value and number of bytes read
   */
  readSVarInt(): { value: number | bigint, bytesRead: number }

  /**
   * Peek unsigned varint at offset from read position (does not advance buffer).
   * @param offset Offset from current read position
   * @returns Value and number of bytes the varint occupies
   */
  peekUVarInt(offset: number): { value: number | bigint, bytesRead: number }

  /**
   * Peek signed varint at offset from read position (does not advance buffer).
   * @param offset Offset from current read position
   * @returns Value and number of bytes the varint occupies
   */
  peekSVarInt(offset: number): { value: number | bigint, bytesRead: number }

  /**
   * Write signed varint
   * @param value Value to write
   * @returns Number of bytes written
   */
  writeSVarInt(value: number | bigint): number

  /**
   * Poke unsigned varint
   * @param offset Offset from write position
   * @param value Value to write
   * @returns Number of bytes written
   */
  pokeUVarInt(offset: number, value: number | bigint): number

  /**
   * Poke signed varint
   * @param offset Offset from write position
   * @param value Value to write
   * @returns Number of bytes written
   */
  pokeSVarInt(offset: number, value: number | bigint): number

  /**
   * Peek unsigned 32-bit varint at offset (same encoding as 64-bit for values in 32-bit range).
   */
  peekUVarInt32(offset: number): { value: number, bytesRead: number }

  /**
   * Poke unsigned 32-bit varint.
   */
  pokeUVarInt32(offset: number, value: number): number

  /**
   * Peek signed 32-bit varint at offset (same encoding as 64-bit for values in 32-bit range).
   */
  peekSVarInt32(offset: number): { value: number, bytesRead: number }

  /**
   * Poke signed 32-bit varint.
   */
  pokeSVarInt32(offset: number, value: number): number

  /**
   * Peek unsigned 16-bit varint at offset (same encoding as 64-bit for values in 16-bit range).
   */
  peekUVarInt16(offset: number): { value: number, bytesRead: number }

  /**
   * Poke unsigned 16-bit varint.
   */
  pokeUVarInt16(offset: number, value: number): number

  /**
   * Peek signed 16-bit varint at offset (same encoding as 64-bit for values in 16-bit range).
   */
  peekSVarInt16(offset: number): { value: number, bytesRead: number }

  /**
   * Poke signed 16-bit varint.
   */
  pokeSVarInt16(offset: number, value: number): number

  /**
   * Copy data from this buffer to destination buffer
   * @param destination Destination buffer
   * @returns Number of bytes copied
   */
  copyTo(destination: CircularBuffer): number

  /**
   * Grow so the buffer can hold at least `newMinimumSize` bytes of data capacity.
   * Returns the new capacity, or false when the buffer cannot grow.
   * Optional: implementations that cannot grow may omit this.
   */
  grow?(newMinimumSize: number): number | boolean
}

/**
 * Ensure `required` writable bytes (including uncommitted poke space).
 * Calls `grow` when present; throws if the buffer is still too small.
 */
export function ensureCircularWritable(
  buffer: CircularBuffer,
  required: number,
  message = 'flat circular writer: buffer full'
): void {
  if (buffer.writableBytes() >= required) return
  if (typeof buffer.grow === 'function') {
    buffer.grow(required)
  }
  if (buffer.writableBytes() < required) {
    throw new Error(message)
  }
}
