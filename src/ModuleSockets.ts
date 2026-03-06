import { CircularBuffer } from './CircularBuffer.js'
import { MemoryCircularBuffer } from './MemoryCircularBuffer.js'
import { Socket } from './Socket.js'

/**
 * Socket flags matching C definitions
 */
export const SOCKET_FLAG_OPEN = 0x01
export const SOCKET_FLAG_READABLE = 0x02
export const SOCKET_FLAG_WRITABLE = 0x04
export const SOCKET_FLAG_ERROR = 0x08

/**
 * Structure offsets in WebAssembly memory (WASM32, 32-bit pointers)
 * 
 * sockets_table:
 * - offset 0-3: size (uint32)
 * - offset 4+: sockets[] (flexible array)
 * 
 * socket_info (per socket):
 * - offset 0-3: input_buffer.data (pointer to circular_buffer_data)
 * - offset 4-7: input_buffer.new_length (pointer to function)
 * - offset 8-11: output_buffer.data (pointer to circular_buffer_data)
 * - offset 12-15: output_buffer.new_length (pointer to function)
 * - offset 16-19: flush_threshold (size_t)
 * - offset 20-23: data_event_threshold (size_t)
 * - offset 24-27: drain_event_threshold (size_t)
 * - offset 28: flags (uint8_t)
 * - offset 29-31: padding
 * - offset 32-35: data_event_callback (pointer)
 * - offset 36-39: drain_event_callback (pointer)
 */
const SOCKETS_TABLE_SIZE_OFFSET = 0
const SOCKET_INFO_SIZE = 40 // sizeof(socket_info) in WASM32

const SOCKET_INFO_INPUT_BUFFER_DATA_OFFSET = 0
const SOCKET_INFO_OUTPUT_BUFFER_DATA_OFFSET = 8
const SOCKET_INFO_FLAGS_OFFSET = 28

/**
 * Represents a single socket with input and output buffers
 */
export class ModuleSocket implements Socket {
  private memory: WebAssembly.Memory
  private socketIndex: number
  private socketInfoPtr: number
  private dataView: DataView

  /**
   * Input buffer (data coming into the module)
   */
  public readonly inputBuffer: CircularBuffer

  /**
   * Output buffer (data going out of the module)
   */
  public readonly outputBuffer: CircularBuffer

  constructor(memory: WebAssembly.Memory, socketIndex: number, socketInfoPtr: number) {
    this.memory = memory
    this.socketIndex = socketIndex
    this.socketInfoPtr = socketInfoPtr
    this.dataView = new DataView(memory.buffer, socketInfoPtr)

    // Pass the address where the circular_buffer_data* pointer is stored
    // so MemoryCircularBuffer reads it dynamically (survives realloc + memory growth)
    this.inputBuffer = new MemoryCircularBuffer(memory, socketInfoPtr + SOCKET_INFO_INPUT_BUFFER_DATA_OFFSET)
    this.outputBuffer = new MemoryCircularBuffer(memory, socketInfoPtr + SOCKET_INFO_OUTPUT_BUFFER_DATA_OFFSET)
  }

  /**
   * Get socket index
   */
  get index(): number {
    return this.socketIndex
  }

  /**
   * Check if socket is open
   */
  private getDataView(): DataView {
    return new DataView(this.memory.buffer, this.socketInfoPtr)
  }

  isOpen(): boolean {
    const flags = this.getDataView().getUint8(SOCKET_INFO_FLAGS_OFFSET)
    return (flags & SOCKET_FLAG_OPEN) !== 0
  }

  /**
   * Get socket flags
   */
  getFlags(): number {
    return this.getDataView().getUint8(SOCKET_INFO_FLAGS_OFFSET)
  }

  /**
   * Check if socket is readable
   */
  isReadable(): boolean {
    return (this.getFlags() & SOCKET_FLAG_READABLE) !== 0
  }

  /**
   * Check if socket is writable
   */
  isWritable(): boolean {
    return (this.getFlags() & SOCKET_FLAG_WRITABLE) !== 0
  }

  /**
   * Check if socket has error
   */
  hasError(): boolean {
    return (this.getFlags() & SOCKET_FLAG_ERROR) !== 0
  }

  /**
   * Get number of readable bytes in output buffer
   */
  readableBytes(): number {
    return this.outputBuffer.readableBytes()
  }

  /**
   * Get number of writable bytes in input buffer
   */
  writableBytes(): number {
    return this.inputBuffer.writableBytes()
  }

  /**
   * Read data from output buffer
   */
  read(destination: Uint8Array, bytes: number): number {
    return this.outputBuffer.read(destination, bytes)
  }

  /**
   * Write data to input buffer
   */
  write(source: Uint8Array | ArrayBufferView, bytes: number): number {
    const sourceArray = source instanceof Uint8Array
      ? source
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    return this.inputBuffer.write(sourceArray, bytes)
  }

  /**
   * Peek data from output buffer without removing it
   */
  peek(offset: number, destination: Uint8Array, bytes: number): number {
    return this.outputBuffer.peek(offset, destination, bytes)
  }

  /**
   * Poke data to input buffer without moving write offset
   */
  poke(offset: number, source: Uint8Array, bytes: number): number {
    return this.inputBuffer.poke(offset, source, bytes)
  }

  /**
   * Skip reading bytes from output buffer
   */
  skipRead(bytes: number): number {
    return this.outputBuffer.skipRead(bytes)
  }

  /**
   * Commit write (move write offset forward) in input buffer
   */
  commitWrite(bytes: number): number {
    return this.inputBuffer.commitWrite(bytes)
  }

  /**
   * Read unsigned varint from output buffer
   */
  readUVarInt(): { value: number | bigint, bytesRead: number } {
    return this.outputBuffer.readUVarInt()
  }

  /**
   * Write unsigned varint to input buffer
   */
  writeUVarInt(value: number | bigint): number {
    return this.inputBuffer.writeUVarInt(value)
  }

  /**
   * Read signed varint from output buffer
   */
  readSVarInt(): { value: number | bigint, bytesRead: number } {
    return this.outputBuffer.readSVarInt()
  }

  /**
   * Write signed varint to input buffer
   */
  writeSVarInt(value: number | bigint): number {
    return this.inputBuffer.writeSVarInt(value)
  }

}

/**
 * Manages sockets for a WebAssembly module
 * Sockets are managed by C/C++ code - this class only provides read/write access
 */
export class ModuleSockets {
  private memory: WebAssembly.Memory
  private socketsTablePtr: number
  private dataView: DataView
  private sockets: Map<number, Socket> = new Map()

  /**
   * Get the sockets table pointer from WebAssembly module
   * @param instance WebAssembly instance with exported get_sockets_table function
   */
  static async fromInstance(instance: WebAssembly.Instance, memory: WebAssembly.Memory): Promise<ModuleSockets> {
    const getSocketsTable = instance.exports.waos_sockets_table as (() => number) | undefined
    if (!getSocketsTable) {
      throw new Error('WebAssembly module does not export waos_sockets_table function')
    }

    const socketsTablePtr = getSocketsTable()
    if (socketsTablePtr === 0) {
      throw new Error('Sockets table not initialized - call sockets_init() first')
    }

    return new ModuleSockets(memory, socketsTablePtr)
  }

  /**
   * Create ModuleSockets with explicit sockets table pointer
   * @param memory WebAssembly memory
   * @param socketsTablePtr Pointer to sockets_table structure
   */
  constructor(memory: WebAssembly.Memory, socketsTablePtr: number) {
    this.memory = memory
    this.socketsTablePtr = socketsTablePtr
    this.dataView = new DataView(memory.buffer, socketsTablePtr)
  }

  private getDataView(): DataView {
    return new DataView(this.memory.buffer, this.socketsTablePtr)
  }

  /**
   * Get the number of sockets in the table
   */
  getSize(): number {
    return this.getDataView().getUint32(SOCKETS_TABLE_SIZE_OFFSET, true)
  }

  /**
   * Get socket by index
   * @param index Socket index
   * @returns Socket instance or null if socket is not open
   */
  getSocket(index: number): Socket | null {
    if (index < 0 || index >= this.getSize()) {
      return null
    }

    // Check if we already have this socket cached
    if (this.sockets.has(index)) {
      const socket = this.sockets.get(index)!
      if (socket.isOpen()) {
        return socket
      } else {
        // Socket was closed, remove from cache
        this.sockets.delete(index)
        return null
      }
    }

    // Calculate socket_info pointer
    const socketInfoPtr = this.socketsTablePtr + 4 + (index * SOCKET_INFO_SIZE)
    const socketInfoView = new DataView(this.memory.buffer, socketInfoPtr)  // temporary view, OK if memory grows later

    // Check if socket is open
    const flags = socketInfoView.getUint8(SOCKET_INFO_FLAGS_OFFSET)
    if ((flags & SOCKET_FLAG_OPEN) === 0) {
      return null
    }

    // Create and cache socket
    const socket = new ModuleSocket(this.memory, index, socketInfoPtr)
    this.sockets.set(index, socket)
    return socket
  }

  /**
   * Get all open sockets
   * @returns Array of open socket instances
   */
  getOpenSockets(): Socket[] {
    const openSockets: Socket[] = []
    const size = this.getSize()

    for (let i = 0; i < size; i++) {
      const socket = this.getSocket(i)
      if (socket) {
        openSockets.push(socket)
      }
    }

    return openSockets
  }

  /**
   * Refresh socket cache (useful if sockets were opened/closed from C/C++ code)
   */
  refresh(): void {
    // Remove closed sockets from cache
    for (const [index, socket] of this.sockets.entries()) {
      if (!socket.isOpen()) {
        this.sockets.delete(index)
      }
    }

    // Try to add newly opened sockets
    const size = this.getSize()
    for (let i = 0; i < size; i++) {
      if (!this.sockets.has(i)) {
        this.getSocket(i) // This will cache it if it's open
      }
    }
  }

  /**
   * Clear socket cache
   */
  clearCache(): void {
    this.sockets.clear()
  }
}

