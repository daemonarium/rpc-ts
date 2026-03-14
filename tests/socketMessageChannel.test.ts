import { expect } from 'chai'

import {
  LocalSocket,
  SocketMessageChannel,
  CodecRegistry,
  type SocketMessageChannelSocket,
  type Writer,
  type Reader,
} from '../src/index.js'

const BUF_SIZE = 4096
const SOCKET_OPTS = {
  inputBufferSize: BUF_SIZE,
  outputBufferSize: BUF_SIZE,
  flushThreshold: BUF_SIZE,
  dataEventThreshold: 0,
  drainEventThreshold: BUF_SIZE,
  flags: 0,
}

function createLoopbackPair(): {
  s0: SocketMessageChannelSocket
  s1: SocketMessageChannelSocket
  transfer: (from: SocketMessageChannelSocket, to: SocketMessageChannelSocket) => void
} {
  const s0 = new LocalSocket(0, SOCKET_OPTS) as SocketMessageChannelSocket
  const s1 = new LocalSocket(1, SOCKET_OPTS) as SocketMessageChannelSocket
  const tmp = new Uint8Array(4096)
  function transfer(from: SocketMessageChannelSocket, to: SocketMessageChannelSocket): void {
    const out = from.outputBuffer
    const inp = to.inputBuffer
    while (out.readableBytes() > 0) {
      const n = out.read(tmp, Math.min(tmp.length, out.readableBytes()))
      if (n === 0) break
      const src = tmp.subarray(0, n)
      inp.write(src, n)
    }
  }
  return { s0, s1, transfer }
}

interface Ping {
  seq: number
}

interface Pong {
  seq: number
  data: string
}

function registerPingPongCodecs(codecs: CodecRegistry): void {
  if (!codecs.has('ping')) {
    codecs.register({
      name: 'ping',
      serialize: (w, v) => {
        const ping = v as Ping
        ;(w as Writer).writeU64(ping.seq)
      },
      deserialize: (r, out) => {
        const seq = Number((r as Reader).readU64())
        out({ seq })
      },
    })
  }
  if (!codecs.has('pong')) {
    codecs.register({
      name: 'pong',
      serialize: (w, v) => {
        const pong = v as Pong
        ;(w as Writer).writeU64(pong.seq)
        ;(w as Writer).writeString(pong.data)
      },
      deserialize: (r, out) => {
        const seq = Number((r as Reader).readU64())
        const data = (r as Reader).readString()
        out({ seq, data })
      },
    })
  }
}

describe('SocketMessageChannel', () => {
  it('send and receive simple message', async () => {
    const codecs = new CodecRegistry()
    registerPingPongCodecs(codecs)
    const { s0, s1, transfer } = createLoopbackPair()

    const ch0 = new SocketMessageChannel(s0, codecs)
    const ch1 = new SocketMessageChannel(s1, codecs)
    ch0.registerMessageType('ping')
    ch1.registerMessageType('ping')

    let received = false
    let receivedSeq = 0
    ch1.onMessage('ping', (msg: unknown) => {
      received = true
      receivedSeq = (msg as Ping).seq
    })

    ch0.sendMessage('ping', { seq: 42 })
    transfer(s0, s1)
    await ch1.handleData()

    expect(received).to.be.true
    expect(receivedSeq).to.equal(42)
  })

  it('send message with string field', async () => {
    const codecs = new CodecRegistry()
    registerPingPongCodecs(codecs)
    const { s0, s1, transfer } = createLoopbackPair()

    const ch0 = new SocketMessageChannel(s0, codecs)
    const ch1 = new SocketMessageChannel(s1, codecs)
    ch0.registerMessageType('pong')
    ch1.registerMessageType('pong')

    let received = false
    let receivedSeq = 0
    let receivedData = ''
    ch1.onMessage('pong', (msg: unknown) => {
      received = true
      const p = msg as Pong
      receivedSeq = p.seq
      receivedData = p.data
    })

    ch0.sendMessage('pong', { seq: 1, data: 'hello world' })
    transfer(s0, s1)
    await ch1.handleData()

    expect(received).to.be.true
    expect(receivedSeq).to.equal(1)
    expect(receivedData).to.equal('hello world')
  })

  it('send message with payload', async () => {
    const codecs = new CodecRegistry()
    registerPingPongCodecs(codecs)
    const { s0, s1, transfer } = createLoopbackPair()

    const ch0 = new SocketMessageChannel(s0, codecs)
    const ch1 = new SocketMessageChannel(s1, codecs)
    ch0.registerMessageType('ping')
    ch1.registerMessageType('ping')

    let received = false
    let receivedSeq = 0
    let receivedPayloadSize = 0
    let payloadValue: number | bigint = 0
    ch1.onMessage('ping', (msg: unknown, payloadSize: number) => {
      received = true
      receivedSeq = (msg as Ping).seq
      receivedPayloadSize = payloadSize
      if (payloadSize > 0) {
        payloadValue = ch1.getReader().readU64()
      }
    })

    const writer = ch0.beginSend('ping', { seq: 7 })
    writer.writeU64(12345n)
    ch0.commitSend()
    transfer(s0, s1)
    await ch1.handleData()

    expect(received).to.be.true
    expect(receivedSeq).to.equal(7)
    expect(receivedPayloadSize).to.be.greaterThan(0)
    expect(Number(payloadValue)).to.equal(12345)
  })

  it('multiple messages in sequence', async () => {
    const codecs = new CodecRegistry()
    registerPingPongCodecs(codecs)
    const { s0, s1, transfer } = createLoopbackPair()

    const ch0 = new SocketMessageChannel(s0, codecs)
    const ch1 = new SocketMessageChannel(s1, codecs)
    ch0.registerMessageType('ping')
    ch1.registerMessageType('ping')

    const receivedSeqs: number[] = []
    ch1.onMessage('ping', (msg: unknown) => {
      receivedSeqs.push((msg as Ping).seq)
    })

    ch0.sendMessage('ping', { seq: 1 })
    ch0.sendMessage('ping', { seq: 2 })
    ch0.sendMessage('ping', { seq: 3 })
    transfer(s0, s1)
    await ch1.handleData()

    expect(receivedSeqs).to.deep.equal([1, 2, 3])
  })

  it('mixed message types', async () => {
    const codecs = new CodecRegistry()
    registerPingPongCodecs(codecs)
    const { s0, s1, transfer } = createLoopbackPair()

    const ch0 = new SocketMessageChannel(s0, codecs)
    const ch1 = new SocketMessageChannel(s1, codecs)
    ch0.registerMessageType('ping')
    ch0.registerMessageType('pong')
    ch1.registerMessageType('ping')
    ch1.registerMessageType('pong')

    const pingSeqs: number[] = []
    const pongData: string[] = []
    ch1.onMessage('ping', (msg: unknown) => {
      pingSeqs.push((msg as Ping).seq)
    })
    ch1.onMessage('pong', (msg: unknown) => {
      pongData.push((msg as Pong).data)
    })

    ch0.sendMessage('ping', { seq: 1 })
    ch0.sendMessage('pong', { seq: 2, data: 'first' })
    ch0.sendMessage('ping', { seq: 3 })
    ch0.sendMessage('pong', { seq: 4, data: 'second' })
    transfer(s0, s1)
    await ch1.handleData()

    expect(pingSeqs).to.deep.equal([1, 3])
    expect(pongData).to.deep.equal(['first', 'second'])
  })

  it('unread payload is skipped', async () => {
    const codecs = new CodecRegistry()
    registerPingPongCodecs(codecs)
    const { s0, s1, transfer } = createLoopbackPair()

    const ch0 = new SocketMessageChannel(s0, codecs)
    const ch1 = new SocketMessageChannel(s1, codecs)
    ch0.registerMessageType('ping')
    ch1.registerMessageType('ping')

    const receivedSeqs: number[] = []
    ch1.onMessage('ping', (_msg: unknown, _payloadSize?: number) => {
      receivedSeqs.push((_msg as Ping).seq)
    })

    const w = ch0.beginSend('ping', { seq: 1 })
    w.writeU64(99999n)
    ch0.commitSend()
    ch0.sendMessage('ping', { seq: 2 })
    transfer(s0, s1)
    await ch1.handleData()

    expect(receivedSeqs).to.deep.equal([1, 2])
  })

  it('unknown type index throws', async () => {
    const codecs = new CodecRegistry()
    registerPingPongCodecs(codecs)
    const { s0, s1, transfer } = createLoopbackPair()

    const ch0 = new SocketMessageChannel(s0, codecs)
    const ch1 = new SocketMessageChannel(s1, codecs)
    ch0.registerMessageType('ping')
    ch0.registerMessageType('pong')
    ch1.registerMessageType('ping')

    ch0.sendMessage('pong', { seq: 1, data: 'test' })
    transfer(s0, s1)

    let threw = false
    let errMsg = ''
    try {
      await ch1.handleData()
    } catch (e) {
      threw = true
      errMsg = e instanceof Error ? e.message : String(e)
    }
    expect(threw).to.be.true
    expect(errMsg).to.match(/Unknown message type index/)
  })

  it('bidirectional communication', async () => {
    const codecs = new CodecRegistry()
    registerPingPongCodecs(codecs)
    const { s0, s1, transfer } = createLoopbackPair()

    const ch0 = new SocketMessageChannel(s0, codecs)
    const ch1 = new SocketMessageChannel(s1, codecs)
    ch0.registerMessageType('ping')
    ch1.registerMessageType('ping')

    let ch0Received = 0
    let ch1Received = 0
    ch0.onMessage('ping', (msg: unknown) => {
      ch0Received = (msg as Ping).seq
    })
    ch1.onMessage('ping', (msg: unknown) => {
      ch1Received = (msg as Ping).seq
    })

    ch0.sendMessage('ping', { seq: 100 })
    transfer(s0, s1)
    await ch1.handleData()

    ch1.sendMessage('ping', { seq: 200 })
    transfer(s1, s0)
    await ch0.handleData()

    expect(ch1Received).to.equal(100)
    expect(ch0Received).to.equal(200)
  })
})
