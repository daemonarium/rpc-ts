import { expect } from 'chai'

import {
  LocalSocket,
  FlatSocketMessageChannel,
  CodecRegistry,
  TypeRegistry,
  TypeDescription,
  TypeKind,
  registerDynamicCodecs,
  registerMessageCodecs,
  type SocketMessageChannelSocket,
  type FlatLocalCircularBufferWriter,
  type FlatLocalCircularBufferReader,
  loadLeU32,
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
  if (!codecs.messages.has('ping')) {
    codecs.messages.register({
      name: 'ping',
      serialize: (w, v) => {
        const ping = v as Ping
        ;(w as FlatLocalCircularBufferWriter).writeU64(ping.seq)
      },
      deserialize: (r, out) => {
        const seq = Number((r as FlatLocalCircularBufferReader).readU64())
        out({ seq })
      },
    })
  }
  if (!codecs.messages.has('pong')) {
    codecs.messages.register({
      name: 'pong',
      serialize: (w, v) => {
        const pong = v as Pong
        ;(w as FlatLocalCircularBufferWriter).writeU64(pong.seq)
        ;(w as FlatLocalCircularBufferWriter).writeString(pong.data)
      },
      deserialize: (r, out) => {
        const seq = Number((r as FlatLocalCircularBufferReader).readU64())
        const data = (r as FlatLocalCircularBufferReader).readString()
        out({ seq, data })
      },
    })
  }
}

describe('FlatSocketMessageChannel', () => {
  it('send and receive simple message', async () => {
    const codecs = new CodecRegistry()
    registerPingPongCodecs(codecs)
    const { s0, s1, transfer } = createLoopbackPair()

    const ch0 = new FlatSocketMessageChannel(s0, codecs)
    const ch1 = new FlatSocketMessageChannel(s1, codecs)
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

    const ch0 = new FlatSocketMessageChannel(s0, codecs)
    const ch1 = new FlatSocketMessageChannel(s1, codecs)
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

    const ch0 = new FlatSocketMessageChannel(s0, codecs)
    const ch1 = new FlatSocketMessageChannel(s1, codecs)
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

    const ch0 = new FlatSocketMessageChannel(s0, codecs)
    const ch1 = new FlatSocketMessageChannel(s1, codecs)
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

    const ch0 = new FlatSocketMessageChannel(s0, codecs)
    const ch1 = new FlatSocketMessageChannel(s1, codecs)
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

    const ch0 = new FlatSocketMessageChannel(s0, codecs)
    const ch1 = new FlatSocketMessageChannel(s1, codecs)
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

    const ch0 = new FlatSocketMessageChannel(s0, codecs)
    const ch1 = new FlatSocketMessageChannel(s1, codecs)
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

    const ch0 = new FlatSocketMessageChannel(s0, codecs)
    const ch1 = new FlatSocketMessageChannel(s1, codecs)
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

  it('graph in body: vector of pointers with cycle preserves identity', async () => {
    type Node = { _type: string, label: string, next: Node | null }
    type GraphMsg = { _type: string, nodes: Node[] }

    const registry = new TypeRegistry()
    const nodeType = TypeDescription.create({
      name: 'node',
      kind: TypeKind.DynamicObject,
      members: [
        { name: 'label', type: registry.getTypeByName('string')!, annotations: [] },
      ],
    })
    const nodePtr = TypeDescription.create({
      name: 'node*',
      kind: TypeKind.Pointer,
      item: nodeType,
    })
    nodeType.members.push({ name: 'next', type: nodePtr, annotations: [] })
    const nodePtrVec = TypeDescription.create({
      name: 'vector<node*>',
      kind: TypeKind.Array,
      item: nodePtr,
    })
    const graphMsg = TypeDescription.create({
      name: 'graph_msg',
      kind: TypeKind.Message,
      members: [
        { name: 'nodes', type: nodePtrVec, annotations: [] },
      ],
    })
    registry.registerType(nodeType)
    registry.registerType(nodePtr)
    registry.registerType(nodePtrVec)
    registry.registerType(graphMsg)

    const codecs = new CodecRegistry()
    registerDynamicCodecs(codecs, registry)
    registerMessageCodecs(codecs, registry)

    const a: Node = { _type: 'node', label: 'A', next: null }
    const b: Node = { _type: 'node', label: 'B', next: a }
    a.next = b
    const value: GraphMsg = { _type: 'graph_msg', nodes: [a, b] }

    const { s0, s1, transfer } = createLoopbackPair()
    const ch0 = new FlatSocketMessageChannel(s0, codecs)
    const ch1 = new FlatSocketMessageChannel(s1, codecs)
    ch0.registerMessageType('graph_msg')
    ch1.registerMessageType('graph_msg')

    let restored: GraphMsg | undefined
    ch1.onMessage('graph_msg', (msg: unknown) => {
      restored = msg as GraphMsg
    })

    ch0.sendMessage('graph_msg', value)
    transfer(s0, s1)
    await ch1.handleData()

    expect(restored).to.exist
    expect(restored!.nodes).to.have.length(2)
    expect(restored!.nodes[0].label).to.equal('A')
    expect(restored!.nodes[1].label).to.equal('B')
    expect(restored!.nodes[0].next).to.equal(restored!.nodes[1])
    expect(restored!.nodes[1].next).to.equal(restored!.nodes[0])
    expect(restored!.nodes[0]).to.equal(restored!.nodes[1].next)
  })

  it('golden layout: typeIndex u32 LE, encoded_size_0, sentinel before payload', async () => {
    // Message { n: i32 } — assert wire body after length prefix.
    const registry = new TypeRegistry()
    const numMsg = TypeDescription.create({
      name: 'num_msg',
      kind: TypeKind.Message,
      members: [
        { name: 'n', type: registry.getTypeByName('sint32')!, annotations: [] },
      ],
    })
    registry.registerType(numMsg)
    const codecs = new CodecRegistry()
    registerMessageCodecs(codecs, registry)

    const { s0, s1, transfer } = createLoopbackPair()
    const ch0 = new FlatSocketMessageChannel(s0, codecs)
    ch0.registerMessageType('num_msg')

    const writer = ch0.beginSend('num_msg', { n: 7 })
    writer.writeU32(0xAABBCCDD)
    ch0.commitSend()

    // Read raw committed frame from output buffer.
    const out = s0.outputBuffer
    const frame = new Uint8Array(out.readableBytes())
    out.peek(0, frame, frame.length)

    const msgLen = loadLeU32(frame, 0)
    expect(msgLen).to.equal(frame.length - 4)
    const body = frame.subarray(4)

    const typeIndex = loadLeU32(body, 0)
    expect(typeIndex).to.equal(codecs.messages.getIndexOrThrow('num_msg'))

    const encodedSize0 = loadLeU32(body, 4)
    expect(encodedSize0).to.be.at.least(1)

    // Sentinel is u32(0) immediately before payload (payload = writeU32).
    const payload = 0xAABBCCDD
    expect(loadLeU32(body, body.length - 8)).to.equal(0) // sentinel
    expect(loadLeU32(body, body.length - 4)).to.equal(payload)

    // Roundtrip still works.
    const ch1 = new FlatSocketMessageChannel(s1, codecs)
    ch1.registerMessageType('num_msg')
    let gotN = -1
    let gotPayload = 0
    ch1.onMessage('num_msg', (msg: unknown, payloadSize: number) => {
      gotN = (msg as { n: number }).n
      expect(payloadSize).to.equal(4)
      gotPayload = ch1.getReader().readU32()
    })
    transfer(s0, s1)
    await ch1.handleData()
    expect(gotN).to.equal(7)
    expect(gotPayload).to.equal(payload)
  })

  it('accepts a Socket that is not LocalSocket (LocalCircularBuffer grow still works)', async () => {
    class FramingSocket implements SocketMessageChannelSocket {
      constructor(private readonly inner: LocalSocket) {}
      get index() { return this.inner.index }
      get inputBuffer() { return this.inner.inputBuffer }
      get outputBuffer() { return this.inner.outputBuffer }
      isOpen() { return this.inner.isOpen() }
      getFlags() { return this.inner.getFlags() }
      isReadable() { return this.inner.isReadable() }
      isWritable() { return this.inner.isWritable() }
      hasError() { return this.inner.hasError() }
      readableBytes() { return this.inner.readableBytes() }
      writableBytes() { return this.inner.writableBytes() }
      read(destination: Uint8Array, bytes: number) { return this.inner.read(destination, bytes) }
      write(source: Uint8Array | ArrayBufferView, bytes: number) { return this.inner.write(source, bytes) }
      peek(offset: number, destination: Uint8Array, bytes: number) {
        return this.inner.peek(offset, destination, bytes)
      }
      poke(offset: number, source: Uint8Array, bytes: number) {
        return this.inner.poke(offset, source, bytes)
      }
      skipRead(bytes: number) { return this.inner.skipRead(bytes) }
      commitWrite(bytes: number) { return this.inner.commitWrite(bytes) }
      readUVarInt() { return this.inner.readUVarInt() }
      writeUVarInt(value: number | bigint) { return this.inner.writeUVarInt(value) }
      readSVarInt() { return this.inner.readSVarInt() }
      writeSVarInt(value: number | bigint) { return this.inner.writeSVarInt(value) }
      flush() { this.inner.flush() }
      drain() { this.inner.drain() }
      reserveForReading(size: number) { return this.inner.reserveForReading(size) }
      getOptions() { return this.inner.getOptions() }
      setOptions(options: Parameters<LocalSocket['setOptions']>[0]) { this.inner.setOptions(options) }
    }

    const codecs = new CodecRegistry()
    registerPingPongCodecs(codecs)
    const raw = createLoopbackPair()
    const s0 = new FramingSocket(raw.s0 as LocalSocket)
    const s1 = new FramingSocket(raw.s1 as LocalSocket)
    const ch0 = new FlatSocketMessageChannel(s0, codecs)
    const ch1 = new FlatSocketMessageChannel(s1, codecs)
    ch0.registerMessageType('ping')
    ch1.registerMessageType('ping')
    let seq = 0
    ch1.onMessage('ping', (msg: unknown) => { seq = (msg as Ping).seq })
    ch0.sendMessage('ping', { seq: 99 })
    raw.transfer(s0, s1)
    await ch1.handleData()
    expect(seq).to.equal(99)
  })
})
