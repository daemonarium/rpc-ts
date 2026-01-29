/**
 * Socket interface - common interface for socket implementations
 */
import { CircularBuffer } from './CircularBuffer.js'

export interface Socket {
  /**
   * Get socket index
   */
  readonly index: number

  /**
   * Input buffer (data coming into the module)
   */
  readonly inputBuffer: CircularBuffer

  /**
   * Output buffer (data going out of the module)
   */
  readonly outputBuffer: CircularBuffer

  /**
   * Check if socket is open
   */
  isOpen(): boolean

  /**
   * Get socket flags
   */
  getFlags(): number

  /**
   * Check if socket is readable
   */
  isReadable(): boolean

  /**
   * Check if socket is writable
   */
  isWritable(): boolean

  /**
   * Check if socket has error
   */
  hasError(): boolean

  /**
   * Get number of readable bytes in output buffer
   */
  readableBytes(): number

  /**
   * Get number of writable bytes in input buffer
   */
  writableBytes(): number

  /**
   * Read data from output buffer
   */
  read(destination: Uint8Array, bytes: number): number

  /**
   * Write data to input buffer
   */
  write(source: Uint8Array | ArrayBufferView, bytes: number): number

  /**
   * Peek data from output buffer without removing it
   */
  peek(offset: number, destination: Uint8Array, bytes: number): number

  /**
   * Poke data to input buffer without moving write offset
   */
  poke(offset: number, source: Uint8Array, bytes: number): number

  /**
   * Skip reading bytes from output buffer
   */
  skipRead(bytes: number): number

  /**
   * Commit write (move write offset forward) in input buffer
   */
  commitWrite(bytes: number): number

  /**
   * Read unsigned varint from output buffer
   */
  readUVarInt(): { value: number | bigint, bytesRead: number }

  /**
   * Write unsigned varint to input buffer
   */
  writeUVarInt(value: number | bigint): number

  /**
   * Read signed varint from output buffer
   */
  readSVarInt(): { value: number | bigint, bytesRead: number }

  /**
   * Write signed varint to input buffer
   */
  writeSVarInt(value: number | bigint): number
}
