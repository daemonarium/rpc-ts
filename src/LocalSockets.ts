import type { Socket } from './Socket.js'

import { LocalSocket } from './LocalSocket.js'
import type { SocketOptions } from './LocalSocket.js'

export class LocalSockets {
  private sockets: Map<number, LocalSocket> = new Map()
  private size: number = 0

  createSocket(index: number, options: SocketOptions): LocalSocket {
    const resolvedIndex = index < 0 ? this.getNextSocketIndex() : index
    if (this.sockets.has(resolvedIndex)) {
      throw new Error(`Socket ${resolvedIndex} already exists`)
    }

    const socket = new LocalSocket(resolvedIndex, options)
    this.sockets.set(resolvedIndex, socket)
    this.size = Math.max(this.size, resolvedIndex + 1)
    return socket
  }

  getSocket(index: number): Socket | null {
    const socket = this.sockets.get(index)
    if (!socket) return null
    if (!socket.isOpen()) return null
    return socket
  }

  getSize(): number {
    return this.size
  }

  getOpenSockets(): Socket[] {
    const result: Socket[] = []
    for (const socket of this.sockets.values()) {
      if (socket.isOpen()) result.push(socket)
    }
    return result
  }

  private getNextSocketIndex(): number {
    let index = 0
    while (this.sockets.has(index)) index++
    return index
  }
}

