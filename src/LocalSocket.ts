/**
 * LocalSocket - TypeScript implementation that uses local buffers
 * This implements the same socket logic as ModuleSocket but uses
 * LocalCircularBuffer instead of MemoryCircularBuffer, and manages
 * all socket options locally.
 */

import { Socket } from './Socket.js'
import { LocalCircularBuffer } from './LocalCircularBuffer.js'

export const SOCKET_FLAG_OPEN = 0x01
export const SOCKET_FLAG_READABLE = 0x02
export const SOCKET_FLAG_WRITABLE = 0x04
export const SOCKET_FLAG_ERROR = 0x08

/**
 * Socket options matching C socket_options structure
 */
export interface SocketOptions {
  inputBufferSize: number
  outputBufferSize: number
  flushThreshold: number
  dataEventThreshold: number
  drainEventThreshold: number
  flags: number
  inputNewLengthCallback?: (requestedLength: number) => number
  outputNewLengthCallback?: (requestedLength: number) => number
  dataEventCallback?: (dataSize: number) => void
  drainEventCallback?: (dataSize: number) => void
  flushCallback?: (socket: number) => void
  drainCallback?: (socket: number) => void
}

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

export class LocalSocket implements Socket {
  public readonly inputBuffer: LocalCircularBuffer
  public readonly outputBuffer: LocalCircularBuffer

  private flags: number
  private flushThreshold: number
  private dataEventThreshold: number
  private drainEventThreshold: number
  private dataEventCallback?: (dataSize: number) => void
  private drainEventCallback?: (dataSize: number) => void
  private flushCallback?: (socket: number) => void
  private drainCallback?: (socket: number) => void

  /**
   * Creates a LocalSocket with local buffers
   * @param index Socket index
   * @param options Socket options
   */
  constructor(public readonly index: number, options: SocketOptions) {
    this.flags = options.flags | SOCKET_FLAG_OPEN
    this.flushThreshold = options.flushThreshold
    this.dataEventThreshold = options.dataEventThreshold
    this.drainEventThreshold = options.drainEventThreshold
    this.dataEventCallback = options.dataEventCallback
    this.drainEventCallback = options.drainEventCallback
    this.flushCallback = options.flushCallback
    this.drainCallback = options.drainCallback

    this.inputBuffer = new LocalCircularBuffer(
      options.inputBufferSize,
      options.inputNewLengthCallback || defaultNewLength
    )
    this.outputBuffer = new LocalCircularBuffer(
      options.outputBufferSize,
      options.outputNewLengthCallback || defaultNewLength
    )
  }

  /**
   * Check if socket is open
   */
  isOpen(): boolean {
    return (this.flags & SOCKET_FLAG_OPEN) !== 0
  }

  /**
   * Get socket flags
   */
  getFlags(): number {
    return this.flags
  }

  /**
   * Set socket flags
   */
  setFlags(flags: number): void {
    this.flags = flags
  }

  /**
   * Check if socket is readable
   */
  isReadable(): boolean {
    return (this.flags & SOCKET_FLAG_READABLE) !== 0
  }

  /**
   * Check if socket is writable
   */
  isWritable(): boolean {
    return (this.flags & SOCKET_FLAG_WRITABLE) !== 0
  }

  /**
   * Check if socket has error
   */
  hasError(): boolean {
    return (this.flags & SOCKET_FLAG_ERROR) !== 0
  }

  /**
   * Get number of readable bytes in input buffer
   */
  readableBytes(): number {
    return this.inputBuffer.readableBytes()
  }

  /**
   * Get number of writable bytes in output buffer
   */
  writableBytes(): number {
    return this.outputBuffer.writableBytes()
  }

  /**
   * Read data from input buffer
   */
  read(destination: Uint8Array, bytes: number): number {
    return this.inputBuffer.read(destination, bytes)
  }

  /**
   * Write data to output buffer
   * Automatically triggers flush if flush_threshold is reached
   */
  write(source: Uint8Array | ArrayBufferView, bytes: number): number {
    const sourceArray = source instanceof Uint8Array
      ? source
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    const written = this.outputBuffer.write(sourceArray, bytes)
    
    // Check if flush threshold is reached
    const readableBytes = this.outputBuffer.readableBytes()
    if (readableBytes >= this.flushThreshold) {
      this.flush()
    }
    
    return written
  }

  /**
   * Peek data from input buffer without removing it
   */
  peek(offset: number, destination: Uint8Array, bytes: number): number {
    return this.inputBuffer.peek(offset, destination, bytes)
  }

  /**
   * Poke data to output buffer without moving write offset
   */
  poke(offset: number, source: Uint8Array, bytes: number): number {
    return this.outputBuffer.poke(offset, source, bytes)
  }

  /**
   * Skip reading bytes from input buffer
   */
  skipRead(bytes: number): number {
    return this.inputBuffer.skipRead(bytes)
  }

  /**
   * Commit write (move write offset forward) in output buffer
   */
  commitWrite(bytes: number): number {
    return this.outputBuffer.commitWrite(bytes)
  }

  /**
   * Read unsigned varint from input buffer
   */
  readUVarInt(): { value: number | bigint, bytesRead: number } {
    return this.inputBuffer.readUVarInt()
  }

  /**
   * Write unsigned varint to output buffer
   */
  writeUVarInt(value: number | bigint): number {
    return this.outputBuffer.writeUVarInt(value)
  }

  /**
   * Read signed varint from input buffer
   */
  readSVarInt(): { value: number | bigint, bytesRead: number } {
    return this.inputBuffer.readSVarInt()
  }

  /**
   * Write signed varint to output buffer
   */
  writeSVarInt(value: number | bigint): number {
    return this.outputBuffer.writeSVarInt(value)
  }

  /**
   * Reserve bytes for reading - increases buffer size so that readable bytes can be available
   * @param size The number of bytes to reserve
   * @returns The number of bytes available for reading after the call
   */
  reserveForReading(size: number): number {
    const currentReadable = this.inputBuffer.readableBytes()
    const currentWritable = this.inputBuffer.writableBytes()
    const totalAvailable = currentReadable + currentWritable
    
    if (totalAvailable >= size) {
      return totalAvailable
    }
    
    const needed = size - totalAvailable
    const currentCapacity = this.inputBuffer.capacity()
    const newMinimumSize = currentCapacity + needed
    
    this.inputBuffer.grow(newMinimumSize)
    
    return this.inputBuffer.readableBytes() + this.inputBuffer.writableBytes()
  }

  /**
   * Reserve bytes for writing - Reserves space for writing to the socket output buffer
   * @param size The number of bytes to reserve
   * @returns The number of bytes available for writing after the call
   */
  reserveForWriting(size: number): number {
    const currentWritable = this.outputBuffer.writableBytes()
    
    if (currentWritable >= size) {
      return currentWritable
    }
    
    const needed = size - currentWritable
    const currentCapacity = this.outputBuffer.capacity()
    const newMinimumSize = currentCapacity + needed
    
    this.outputBuffer.grow(newMinimumSize)
    
    return this.outputBuffer.writableBytes()
  }

  /**
   * Get input buffer capacity (for reading)
   */
  readCapacity(): number {
    return this.inputBuffer.capacity()
  }

  /**
   * Get output buffer capacity (for writing)
   */
  writeCapacity(): number {
    return this.outputBuffer.capacity()
  }

  /**
   * Flush the socket output buffer
   * Calls the flush callback if set, which handles copying data to connected sockets
   */
  flush(): void {
    if (this.flushCallback) {
      this.flushCallback(this.index)
    }
  }

  /**
   * Drain the socket input buffer
   * Calls the drain callback if set, which handles copying data from connected sockets
   */
  drain(): void {
    if (this.drainCallback) {
      this.drainCallback(this.index)
    }
  }

  /**
   * Handle data event - called when data is available in input buffer
   */
  handleData(): void {
    const dataSize = this.inputBuffer.readableBytes()
    if (this.dataEventCallback && dataSize >= this.dataEventThreshold) {
      this.dataEventCallback(dataSize)
    }
  }

  /**
   * Handle drain event - called when output buffer is drained
   */
  handleDrain(): void {
    const dataSize = this.outputBuffer.readableBytes()
    if (this.drainEventCallback && dataSize <= this.drainEventThreshold) {
      this.drainEventCallback(dataSize)
    }
  }

  /**
   * Set socket options
   */
  setOptions(options: Partial<SocketOptions>): void {
    if (options.flags !== undefined) {
      this.flags = (this.flags & SOCKET_FLAG_OPEN) | (options.flags & ~SOCKET_FLAG_OPEN)
    }
    if (options.flushThreshold !== undefined) {
      this.flushThreshold = options.flushThreshold
    }
    if (options.dataEventThreshold !== undefined) {
      this.dataEventThreshold = options.dataEventThreshold
    }
    if (options.drainEventThreshold !== undefined) {
      this.drainEventThreshold = options.drainEventThreshold
    }
    if (options.dataEventCallback !== undefined) {
      this.dataEventCallback = options.dataEventCallback
    }
    if (options.drainEventCallback !== undefined) {
      this.drainEventCallback = options.drainEventCallback
    }
    if (options.flushCallback !== undefined) {
      this.flushCallback = options.flushCallback
    }
    if (options.drainCallback !== undefined) {
      this.drainCallback = options.drainCallback
    }
    if (options.inputBufferSize !== undefined) {
      this.inputBuffer.grow(options.inputBufferSize)
    }
    if (options.outputBufferSize !== undefined) {
      this.outputBuffer.grow(options.outputBufferSize)
    }
  }

  /**
   * Get socket options
   */
  getOptions(): SocketOptions {
    return {
      inputBufferSize: this.inputBuffer.capacity(),
      outputBufferSize: this.outputBuffer.capacity(),
      flushThreshold: this.flushThreshold,
      dataEventThreshold: this.dataEventThreshold,
      drainEventThreshold: this.drainEventThreshold,
      flags: this.flags,
      dataEventCallback: this.dataEventCallback,
      drainEventCallback: this.drainEventCallback,
      flushCallback: this.flushCallback,
      drainCallback: this.drainCallback,
    }
  }

  /**
   * Close the socket
   */
  close(): void {
    if (this.isOpen()) {
      this.flags = 0
      this.inputBuffer.clear()
      this.outputBuffer.clear()
    }
  }
}
