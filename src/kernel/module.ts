import { TypeRegistry } from "../typeDescription.js";
import { deserializeTypeRegistry } from "../registrySerialization.js";
import { ModuleSockets, Socket } from "../ModuleSockets.js";

export class SocketConnectionDestination { 
  module: Module;
  socket: Socket;
  socketIndex: number;
}

export class SocketConnection {
  socket: Socket;
  connectedTo?: SocketConnectionDestination;
  flushHandler?: (socket: Socket) => void;
  drainHandler?: (socket: Socket) => void;

  constructor(socket: Socket) {
    this.socket = socket;
  }
}

export class Module {

  wasm: WebAssembly.Module;
  memory: WebAssembly.Memory;
  instance?: WebAssembly.Instance;
  rpcDescription?: TypeRegistry;

  socketConnections: Array<SocketConnection> = [];

  private sendMessageCallback?: (channel: number, buffer: Uint8Array) => void;
  private moduleSockets?: ModuleSockets;
  
  constructor(wasm: WebAssembly.Module) {
    this.wasm = wasm;
    this.memory = new WebAssembly.Memory({ initial: 1024, maximum: 2048 });    
  }
  
  async instantiate() {
    const imports = {
      env: {
        memory: this.memory,
      },
      waos: {
        waos_socket_flush: (socket: number) => {
          const socketConnection = this.socketConnections[socket]
          if(socketConnection?.connectedTo) {
            const copiedBytes = socketConnection.socket.outputBuffer.copyTo(socketConnection.connectedTo.socket.inputBuffer)
            if(copiedBytes > 0) {
              /// TODO: use scheduler when under load
              const handleData = socketConnection.connectedTo.module.instance.exports.waos_socket_data as (socket: number) => void | undefined
              if(!handleData) {
                throw new Error('waos_socket_data not exported from WASM module');
              }
              handleData(socketConnection.connectedTo.socket.index)
            }
          }
          if(socketConnection?.flushHandler) {
            socketConnection.flushHandler?.(socketConnection.socket);
          }
        },
        waos_socket_drain: (socket: number) => {
          /// TODO: implement
          const socketConnection = this.socketConnections[socket]
          if(socketConnection?.connectedTo) {
            const copiedBytes = socketConnection.connectedTo.socket.inputBuffer.copyTo(socketConnection.socket.outputBuffer)
            if(copiedBytes > 0) {
              /// TODO: use scheduler when under load
              const handleDrain = socketConnection.connectedTo.module.instance.exports.waos_socket_drain as (socket: number) => void | undefined
              if(!handleDrain) {
                throw new Error('waos_socket_drain not exported from WASM module');
              }
              handleDrain(socketConnection.connectedTo.socket.index)
            }
          }
          if(socketConnection?.drainHandler) {
            socketConnection.drainHandler?.(socketConnection.socket);
          }
        }
      }
    }
    this.instance = await WebAssembly.instantiate(this.wasm, imports)
    //@ts-ignore
    this.instance.exports._initialize()
    //@ts-ignore
    this.instance.exports.start()

    // initialize sockets view
    this.moduleSockets = await ModuleSockets.fromInstance(this.instance, this.memory)
    this.socketConnections[0] = new SocketConnection(this.moduleSockets.getSocket(0))
    this.socketConnections[0].flushHandler = (socket: Socket) => this.handleRequestSocketFlush(socket)
    this.socketConnections[0].drainHandler = (socket: Socket) => this.handleRequestSocketDrain(socket)

    this.rpcDescription = deserializeTypeRegistry(this.readRawRpcDescription())
    if (this.rpcDescription) {
      this.rpcDescription.assignMethodIds()
    }
  }

  setSendMessageCallback(callback: (channel: number, buffer: Uint8Array) => void) {
    this.sendMessageCallback = callback;
  }

  /**
   * Send RPC request into socket 0 input buffer and trigger processing inside WASM.
   */
  handleMessage(_channel: number, data: ArrayBuffer | Uint8Array): void {
    if (!this.instance || !this.moduleSockets) {
      throw new Error('Module not instantiated');
    }

    const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
    const socket0 = this.moduleSockets.getSocket(0);
    if (!socket0) {
      throw new Error('Socket 0 not available or not open');
    }

    // Ensure enough space (length prefix + payload)
    const total = 4 + buffer.length;
    if (total > socket0.inputBuffer.writableBytes()) {
      throw new Error('Not enough space in socket 0 input buffer for request');
    }

    // Write length prefix (uint32 LE) then payload
    const lenBytes = new Uint8Array(4);
    new DataView(lenBytes.buffer).setUint32(0, buffer.length, true);
    socket0.write(lenBytes, lenBytes.length);
    if (buffer.length > 0) {
      socket0.write(buffer, buffer.length);
    }

    // Trigger RPC processing on socket 0
    const handleRpc = this.instance.exports.waos_socket_data as (socket: number) => void | undefined;
    if (!handleRpc) {
      throw new Error('waos_handle_rpc_socket0 not exported from WASM module');
    }
    handleRpc(0);
  }

  readRawRpcDescription(): Uint8Array {
    /// call exported malloc to create space for returned pointer
    const pointer = (this.instance?.exports.malloc as (size: number) => number)(4);
    if (!pointer) {
      throw new Error('Failed to allocate memory for rpc description');
    }
    /// call exported rpc_description to get the description
    const descriptionSize = (this.instance?.exports.rpc_description as (pointer: number) => number)(pointer);
    if (!descriptionSize) {
      throw new Error('Failed to get rpc description');
    }
    /// read the description pointer from the memory
    const descriptionPointer = new Uint32Array(this.memory.buffer, pointer, 1)[0];
    if (!descriptionPointer) {
      throw new Error('Failed to read description pointer');
    }
    /// read the description from the memory by copying it to a new array buffer
    return new Uint8Array(this.memory.buffer, descriptionPointer, descriptionSize);
  }

  /**
   * Called from WASM when socket_flush is invoked.
   * Reads all data from the flushed socket output buffer and forwards via callback.
   */
  private handleRequestSocketFlush(sock: Socket) {

    // Process length-prefixed messages; there may be multiple in the buffer
    while (true) {
      const readable = sock.outputBuffer.readableBytes();
      if (readable < 4) break;

      const lenBuf = new Uint8Array(4);
      sock.outputBuffer.peek(0, lenBuf, 4);
      const msgLen = new DataView(lenBuf.buffer).getUint32(0, true);

      if (readable < 4 + msgLen) break; // wait for more data

      // Consume length
      sock.outputBuffer.skipRead(4);

      // Read message
      const data = new Uint8Array(msgLen);
      if (msgLen > 0) {
        sock.outputBuffer.read(data, msgLen);
      }

      if (this.sendMessageCallback) {
        this.sendMessageCallback(sock.index, data);
      } else {
        console.log('socket_flush', sock.index, data);
      }
    }
  }

  private handleRequestSocketDrain(sock: Socket) {
    /// TODO: implement
  }
}