import { expect } from 'chai'
import {
  CodecRegistry,
  LocalSocket,
  TypeRegistry,
  addMuxSocketTypes,
  registerMessageCodecs,
  registerMuxSocketMessages,
  SocketMux,
  MUX_SOCKET_OPEN,
  MUX_SOCKET_DATA,
  MUX_SOCKET_CLOSE,
  MUX_SOCKET_WINDOW,
  type MessageChannel,
  type SocketOptions
} from '../src/index.js'
import { FlatSocketMessageChannel } from '../src/FlatSocketMessageChannel.js'

class MockChannel implements MessageChannel {
  writable = true
  sent: { type: string, value: object }[] = []
  private handlers = new Map<string, (msg: unknown) => void>()
  private writableHandlers: Array<() => void> = []

  registerMessageType(_typeName: string): void {}

  onMessage(typeName: string, handler: (msg: unknown, payloadSize?: number) => void): void {
    this.handlers.set(typeName, handler)
  }

  sendMessage(typeName: string, value: object): void {
    this.sent.push({ type: typeName, value })
  }

  tryQueueMessage(typeName: string, value: object): boolean {
    if (!this.writable) return false
    this.sent.push({ type: typeName, value })
    return true
  }

  isWritable(): boolean {
    return this.writable
  }

  onWritable(handler: () => void): void {
    this.writableHandlers.push(handler)
  }

  emit(typeName: string, value: object): void {
    this.handlers.get(typeName)?.(value)
  }

  drain(): void {
    for (const handler of this.writableHandlers) handler()
  }

  ofType(typeName: string): object[] {
    return this.sent.filter((item) => item.type === typeName).map((item) => item.value)
  }
}

function payload(n: number, fill = 1): Uint8Array {
  return new Uint8Array(n).fill(fill)
}

describe('SocketMux', () => {
  it('open/data/close round-trip', () => {
    const ch = new MockChannel()
    const received: Uint8Array[] = []
    const mux = new SocketMux(ch, {
      onData: (_id, bytes) => { received.push(bytes) }
    })
    mux.openSocket(7)
    expect(ch.ofType(MUX_SOCKET_OPEN)).to.have.length(1)

    mux.grantWindow(7, 100)
    expect((ch.ofType(MUX_SOCKET_WINDOW)[0] as { add_bytes: bigint }).add_bytes).to.equal(100n)

    ch.emit(MUX_SOCKET_WINDOW, { socket_id: 7n, add_bytes: 100n })
    const p = mux.sendData(7, payload(4, 9))
    expect(p.state).to.equal('resolved')
    const data = ch.ofType(MUX_SOCKET_DATA)[0] as { socket_id: bigint, payload: Uint8Array }
    expect(data.socket_id).to.equal(7n)
    expect(Array.from(data.payload)).to.deep.equal([9, 9, 9, 9])

    ch.emit(MUX_SOCKET_DATA, { socket_id: 7n, payload: payload(2, 3) })
    expect(received).to.have.length(1)

    mux.closeSocket(7)
    expect(ch.ofType(MUX_SOCKET_CLOSE)).to.have.length(1)
    expect(mux.hasSocket(7)).to.equal(false)
  })

  it('window flow control blocks then resumes', () => {
    const ch = new MockChannel()
    const mux = new SocketMux(ch)
    mux.openSocket(1)
    const first = mux.sendData(1, payload(8))
    expect(first.state).to.equal('pending')
    expect(ch.ofType(MUX_SOCKET_DATA)).to.have.length(0)

    ch.emit(MUX_SOCKET_WINDOW, { socket_id: 1n, add_bytes: 8n })
    expect(first.state).to.equal('resolved')
    expect(ch.ofType(MUX_SOCKET_DATA)).to.have.length(1)

    const second = mux.sendData(1, payload(8))
    expect(second.state).to.equal('pending')
    ch.emit(MUX_SOCKET_WINDOW, { socket_id: 1n, add_bytes: 8n })
    expect(second.state).to.equal('resolved')
  })

  it('send-one-past: oversized frame goes through, next blocks', () => {
    const ch = new MockChannel()
    const mux = new SocketMux(ch)
    mux.openSocket(1)
    ch.emit(MUX_SOCKET_WINDOW, { socket_id: 1n, add_bytes: 10n })
    const first = mux.sendData(1, payload(40))
    expect(first.state).to.equal('resolved')
    expect(mux.remaining(1)).to.equal(0n)
    const second = mux.sendData(1, payload(4))
    expect(second.state).to.equal('pending')
    expect(ch.ofType(MUX_SOCKET_DATA)).to.have.length(1)
  })

  it('backpressure isolation: stalled A does not block B', () => {
    const ch = new MockChannel()
    const mux = new SocketMux(ch)
    mux.openSocket(1)
    mux.openSocket(2)
    ch.emit(MUX_SOCKET_WINDOW, { socket_id: 2n, add_bytes: 100n })
    const blocked = mux.sendData(1, payload(8))
    const ok = mux.sendData(2, payload(8))
    expect(blocked.state).to.equal('pending')
    expect(ok.state).to.equal('resolved')
    const ids = ch.ofType(MUX_SOCKET_DATA).map((msg) => Number((msg as { socket_id: bigint }).socket_id))
    expect(ids).to.deep.equal([2])
  })

  it('DRR fairness: two ready sockets both send', () => {
    const ch = new MockChannel()
    const mux = new SocketMux(ch, { quantum: 1 })
    mux.openSocket(1)
    mux.openSocket(2)
    ch.emit(MUX_SOCKET_WINDOW, { socket_id: 1n, add_bytes: 100n })
    ch.emit(MUX_SOCKET_WINDOW, { socket_id: 2n, add_bytes: 100n })
    ch.writable = false
    mux.sendData(1, payload(4, 1))
    mux.sendData(1, payload(4, 1))
    mux.sendData(2, payload(4, 2))
    mux.sendData(2, payload(4, 2))
    ch.writable = true
    ch.drain()
    const ids = ch.ofType(MUX_SOCKET_DATA).map((msg) => Number((msg as { socket_id: bigint }).socket_id))
    expect(ids.filter((id) => id === 1).length).to.equal(2)
    expect(ids.filter((id) => id === 2).length).to.equal(2)
    expect(new Set(ids.slice(0, 2)).size).to.equal(2)
  })

  it('close zeroes credit and resolves blocked send', () => {
    const ch = new MockChannel()
    const mux = new SocketMux(ch)
    mux.openSocket(3)
    const blocked = mux.sendData(3, payload(8))
    expect(blocked.state).to.equal('pending')
    mux.closeSocket(3)
    expect(blocked.state).to.equal('resolved')
    expect(mux.remaining(3)).to.equal(0n)
    expect(mux.sent(3)).to.equal(0n)
    mux.openSocket(3)
    expect(mux.remaining(3)).to.equal(0n)
  })

  it('unknown socket_id is a no-op', () => {
    const ch = new MockChannel()
    const mux = new SocketMux(ch)
    ch.emit(MUX_SOCKET_WINDOW, { socket_id: 99n, add_bytes: 50n })
    ch.emit(MUX_SOCKET_DATA, { socket_id: 99n, payload: payload(4) })
    ch.emit(MUX_SOCKET_CLOSE, { socket_id: 99n })
    const p = mux.sendData(99, payload(4))
    expect(p.state).to.equal('resolved')
    expect(ch.ofType(MUX_SOCKET_DATA)).to.have.length(0)
  })

  it('control frames pass when remaining is 0', () => {
    const ch = new MockChannel()
    const mux = new SocketMux(ch)
    mux.openSocket(1)
    const blocked = mux.sendData(1, payload(8))
    expect(blocked.state).to.equal('pending')
    mux.closeSocket(1)
    expect(ch.ofType(MUX_SOCKET_CLOSE)).to.have.length(1)
    expect(blocked.state).to.equal('resolved')
  })

  it('paused grants are flushed on resume', () => {
    const ch = new MockChannel()
    const mux = new SocketMux(ch)
    mux.openSocket(1)
    mux.setPaused(1, true)
    mux.grantWindow(1, 50)
    expect(ch.ofType(MUX_SOCKET_WINDOW)).to.have.length(0)
    mux.setPaused(1, false)
    expect(ch.ofType(MUX_SOCKET_WINDOW)).to.have.length(1)
  })

  it('channel not writable holds the frame until drain', () => {
    const ch = new MockChannel()
    const mux = new SocketMux(ch)
    mux.openSocket(1)
    ch.emit(MUX_SOCKET_WINDOW, { socket_id: 1n, add_bytes: 100n })
    ch.writable = false
    const p = mux.sendData(1, payload(8))
    expect(p.state).to.equal('pending')
    ch.writable = true
    ch.drain()
    expect(p.state).to.equal('resolved')
  })
})

const SOCKET_OPTS: SocketOptions = {
  inputBufferSize: 4096,
  outputBufferSize: 4096,
  flushThreshold: 4096,
  dataEventThreshold: 0,
  drainEventThreshold: 4096,
  flags: 0
}

describe('SocketMux loopback', () => {
  it('delivers payload across two muxes', async () => {
    const registry = new TypeRegistry()
    addMuxSocketTypes(registry)
    const codecsA = new CodecRegistry()
    const codecsB = new CodecRegistry()
    registerMessageCodecs(codecsA, registry)
    registerMessageCodecs(codecsB, registry)
    const a = new LocalSocket(0, SOCKET_OPTS)
    const b = new LocalSocket(1, SOCKET_OPTS)
    const chA = new FlatSocketMessageChannel(a, codecsA)
    const chB = new FlatSocketMessageChannel(b, codecsB)
    registerMuxSocketMessages(chA)
    registerMuxSocketMessages(chB)
    const got: Uint8Array[] = []
    const muxA = new SocketMux(chA)
    const muxB = new SocketMux(chB, {
      onData: (_id, bytes) => { got.push(bytes) }
    })
    muxA.openSocket(5)
    muxA.grantWindow(5, 64)
    const tmp = new Uint8Array(4096)
    const transfer = (from: LocalSocket, to: LocalSocket) => {
      const out = from.outputBuffer
      const inp = to.inputBuffer
      while (out.readableBytes() > 0) {
        const n = out.read(tmp, Math.min(tmp.length, out.readableBytes()))
        if (n === 0) break
        inp.write(tmp.subarray(0, n), n)
      }
    }
    transfer(a, b)
    await chB.handleData()
    muxB.grantWindow(5, 64)
    transfer(b, a)
    await chA.handleData()
    const body = payload(6, 7)
    const p = muxA.sendData(5, body)
    expect(p.state).to.equal('resolved')
    transfer(a, b)
    await chB.handleData()
    expect(got).to.have.length(1)
    expect(Array.from(got[0])).to.deep.equal(Array.from(body))
  })
})
