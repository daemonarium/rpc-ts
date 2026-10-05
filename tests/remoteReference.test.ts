import { expect } from 'chai'

import {
  CodecRegistry,
  LocalSocket,
  Observable,
  ObservablePromise,
  ObservableState,
  RemoteObservable,
  RemoteReference,
  RemoteRegistry,
  SocketRpcClient,
  SocketRpcServer,
  StreamMultiplexer,
  StreamPublisher,
  STREAM_MESSAGE_TYPES,
  stream_flags,
  TypeDescription,
  TypeKind,
  TypeRegistry,
  ensureRpcCodecs,
  ensureRpcTypesInRegistry,
  serializeValueByType,
  deserializeValueByType,
  type BinaryEntry,
  type JsonValue,
  type Change,
  type Consumer,
  type MessageChannel,
  type StreamCancel,
  type StreamHandle,
  type SocketMessageChannelSocket,
} from '../src/index.js'
import { bytesEqual, DbIoError } from '../src/observable/types.js'

const kDbStartScan = 5

function bin(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function expectKey(actual: Uint8Array, expected: string): void {
  expect(bytesEqual(actual, bin(expected))).to.equal(true)
}

class RecordingConsumer implements Consumer {
  changes: Change[] = []
  since: bigint | number = 0
  readys = 0
  resets = 0
  errors = 0
  closeds = 0

  onChange(c: Change): ObservablePromise {
    this.changes.push(c)
    return ObservablePromise.resolved()
  }
  onReady(): void { this.readys++ }
  onReset(): void {
    this.resets++
    this.changes = []
  }
  onError(_ex: unknown): void { this.errors++ }
  onClosed(): void { this.closeds++ }
  sinceTimestamp(): bigint | number { return this.since }
}

interface StartCall {
  function_id: number
  handle: StreamHandle
  query: unknown
}

class MockClient implements MessageChannel {
  private readonly handlers = new Map<string, (msg: unknown, payloadSize?: number) => void>()
  starts: StartCall[] = []
  cancels: StreamCancel[] = []
  sent: Array<{ typeName: string, value: object }> = []
  writable = true
  private readonly writableHandlers: Array<() => void> = []

  registerMessageType(_typeName: string): void {}

  onMessage(typeName: string, handler: (msg: unknown, payloadSize?: number) => void): void {
    this.handlers.set(typeName, handler)
  }

  sendMessage(typeName: string, value: object): void {
    this.sent.push({ typeName, value })
    if (typeName === 'stream_cancel') {
      this.cancels.push(value as StreamCancel)
    }
  }

  tryQueueMessage(typeName: string, value: object): boolean {
    if (!this.writable) return false
    this.sendMessage(typeName, value)
    return true
  }

  isWritable(): boolean {
    return this.writable
  }

  onWritable(handler: () => void): void {
    this.writableHandlers.push(handler)
  }

  notifyWritable(): void {
    for (const h of this.writableHandlers) h()
  }

  call(functionId: number, ...args: unknown[]): unknown {
    this.starts.push({
      function_id: functionId,
      handle: args[0] as StreamHandle,
      query: args[1],
    })
    return ObservablePromise.resolved()
  }

  inject(typeName: string, msg: unknown): void {
    const handler = this.handlers.get(typeName)
    if (handler) handler(msg)
  }
}

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
  const tmp = new Uint8Array(BUF_SIZE)
  function transfer(from: SocketMessageChannelSocket, to: SocketMessageChannelSocket): void {
    const out = from.outputBuffer
    const inp = to.inputBuffer
    while (out.readableBytes() > 0) {
      const n = out.read(tmp, Math.min(tmp.length, out.readableBytes()))
      if (n === 0) break
      inp.write(tmp.subarray(0, n), n)
    }
  }
  return { s0, s1, transfer }
}

function createScanRegistry(onStart: (stream: StreamHandle, query: unknown) => void): TypeRegistry {
  const registry = new TypeRegistry()
  const t = (name: string) => {
    const found = registry.getTypeByName(name)
    if (!found) throw new Error(`missing builtin ${name}`)
    return found
  }
  const voidType = t('void')
  const uint32 = t('uint32')
  const uint64 = t('uint64')
  const uint8 = t('uint8')
  const binary = t('binary')
  const stringType = t('string')

  const streamHandle = TypeDescription.create({
    name: 'stream_handle',
    kind: TypeKind.Object,
    members: [
      { name: 'pid', type: uint64, annotations: [] },
      { name: 'socket', type: uint32, annotations: [] },
      { name: 'stream_id', type: uint64, annotations: [] },
      { name: 'since_timestamp', type: uint64, annotations: [] },
      { name: 'flags', type: uint8, annotations: [] },
    ],
  })
  const scanQuery = TypeDescription.create({
    name: 'db_scan_query',
    kind: TypeKind.Object,
    members: [
      { name: 'limit', type: uint64, annotations: [] },
    ],
  })
  registry.registerType(streamHandle)
  registry.registerType(scanQuery)

  const dummy = (name: string) => {
    const fn = TypeDescription.create({
      name,
      kind: TypeKind.Function,
      members: [],
      item: voidType,
    })
    fn.implementation = () => {}
    registry.registerType(fn)
    return fn
  }

  const startScanFn = TypeDescription.create({
    name: 'db.start_scan',
    kind: TypeKind.Function,
    members: [
      { name: 'stream', type: streamHandle, annotations: [] },
      { name: 'query', type: scanQuery, annotations: [] },
    ],
    item: voidType,
  })
  startScanFn.implementation = (stream: StreamHandle, query: unknown) => {
    onStart(stream, query)
  }
  registry.registerType(startScanFn)

  const msg = (name: string, members: Array<{ name: string, type: ReturnType<typeof t> }>) => {
    const type = TypeDescription.create({
      name,
      kind: TypeKind.Message,
      members: members.map((m) => ({ name: m.name, type: m.type, annotations: [] })),
    })
    registry.registerType(type)
    return type
  }

  msg('socket_opened', [])
  msg('stream_item', [
    { name: 'stream_id', type: uint64 },
    { name: 'key', type: binary },
    { name: 'value', type: binary },
    { name: 'timestamp', type: uint64 },
  ])
  msg('stream_key', [
    { name: 'stream_id', type: uint64 },
    { name: 'key', type: binary },
    { name: 'timestamp', type: uint64 },
  ])
  msg('stream_done', [{ name: 'stream_id', type: uint64 }])
  msg('stream_error', [
    { name: 'stream_id', type: uint64 },
    { name: 'message', type: stringType },
  ])
  msg('stream_reset', [{ name: 'stream_id', type: uint64 }])
  msg('stream_cancel', [{ name: 'stream_id', type: uint64 }])
  msg('stream_opened', [{ name: 'stream_id', type: uint64 }])

  const getFn = dummy('db.get')
  const setFn = dummy('db.set')
  const batchFn = dummy('db.batch')
  const openFn = dummy('db.open_socket')
  const closeFn = dummy('db.close_socket')

  const dbType = TypeDescription.create({
    name: 'db',
    kind: TypeKind.Object,
    members: [
      { name: 'get', type: getFn, annotations: [] },
      { name: 'set', type: setFn, annotations: [] },
      { name: 'batch', type: batchFn, annotations: [] },
      { name: 'open_socket', type: openFn, annotations: [] },
      { name: 'close_socket', type: closeFn, annotations: [] },
      { name: 'start_scan', type: startScanFn, annotations: [] },
    ],
  })
  registry.registerType(dbType)
  registry.assignMethodIds()
  return registry
}

function createScanCodecs(registry: TypeRegistry): CodecRegistry {
  const codecs = new CodecRegistry()
  ensureRpcTypesInRegistry(registry)
  ensureRpcCodecs(codecs, registry)
  for (const type of registry.getTypes()) {
    if (type.kind !== TypeKind.Message || codecs.messages.has(type.name)) continue
    codecs.messages.register({
      name: type.name,
      serialize: (writer, value) => {
        serializeValueByType(writer, registry, type, value as JsonValue)
      },
      deserialize: (reader, output) => {
        deserializeValueByType(reader, registry, type, output)
      },
    })
  }
  return codecs
}

describe('remoteObservable (port of remote_observable_ut.cpp)', () => {
  it('1 subscribe triggers onStart createStream once', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 2)
    const obs = new RemoteObservable(mux, kDbStartScan, 0, {})
    const c = new RecordingConsumer()
    expect(obs.state()).to.equal(ObservableState.idle)
    obs.subscribe(c)
    expect(client.starts.length).to.equal(1)
    expect(client.starts[0].function_id).to.equal(kDbStartScan)
    expect(BigInt(client.starts[0].handle.pid)).to.equal(1n)
    expect(client.starts[0].handle.socket).to.equal(2)
    expect(BigInt(client.starts[0].handle.since_timestamp)).to.equal(0n)
    expect(client.starts[0].handle.flags).to.equal(0)
    expect(obs.streamId()).to.equal(1n)
    expect(obs.state()).to.equal(ObservableState.loading)
  })

  it('2 onStreamItem drives onItem then onStreamDone to ready', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 2)
    const obs = new RemoteObservable(mux, kDbStartScan, 0, {})
    const c = new RecordingConsumer()
    obs.subscribe(c)
    obs.onStreamItem({ stream_id: obs.streamId(), key: bin('a'), value: bin('1'), timestamp: 10 })
    expect(c.changes.length).to.equal(1)
    expectKey(c.changes[0].key, 'a')
    expect(c.changes[0].ts).to.equal(10n)
    expect(obs.state()).to.equal(ObservableState.loading)
    obs.onStreamDone({ stream_id: obs.streamId() })
    expect(obs.state()).to.equal(ObservableState.ready)
    expect(c.readys).to.equal(1)
    expect(obs.getEntries().length).to.equal(1)
  })

  it('3 onStreamReset clear-and-rebuild sets-only replay', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 2)
    const obs = new RemoteObservable(mux, kDbStartScan, 0, {})
    const c = new RecordingConsumer()
    obs.subscribe(c)
    obs.onStreamItem({ stream_id: obs.streamId(), key: bin('a'), value: bin('1'), timestamp: 1 })
    obs.onStreamDone({ stream_id: obs.streamId() })
    obs.onStreamReset({ stream_id: obs.streamId() })
    expect(obs.state()).to.equal(ObservableState.reloading)
    expect(c.resets).to.equal(1)
    expect(c.changes.length).to.equal(0)
    expect(obs.getEntries().length).to.equal(1)
    expectKey(obs.getEntries()[0].key, 'a')
    obs.onStreamItem({ stream_id: obs.streamId(), key: bin('b'), value: bin('2'), timestamp: 2 })
    obs.onStreamDone({ stream_id: obs.streamId() })
    expect(obs.state()).to.equal(ObservableState.ready)
    expect(obs.getEntries().length).to.equal(1)
    expectKey(obs.getEntries()[0].key, 'b')
    expect(c.changes.length).to.equal(1)
    expectKey(c.changes[0].key, 'b')
  })

  it('4 onStreamError to error lastError retained', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 2)
    const obs = new RemoteObservable(mux, kDbStartScan, 0, {})
    const c = new RecordingConsumer()
    obs.subscribe(c)
    obs.onStreamItem({ stream_id: obs.streamId(), key: bin('a'), value: bin('1'), timestamp: 1 })
    obs.onStreamDone({ stream_id: obs.streamId() })
    obs.onStreamError({ stream_id: obs.streamId(), message: 'wire boom' })
    expect(obs.state()).to.equal(ObservableState.error)
    expect(c.errors).to.equal(1)
    expect(obs.lastError()).to.not.equal(null)
    expect(obs.getEntries().length).to.equal(1)
    const err = obs.lastError()
    expect(err).to.be.instanceOf(DbIoError)
    expect((err as Error).message).to.equal('wire boom')
  })

  it('5 last unsubscribe onStop cancelStream idle', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 2)
    const obs = new RemoteObservable(mux, kDbStartScan, 0, {})
    const c = new RecordingConsumer()
    const out = obs.subscribe(c)
    expect(client.starts.length).to.equal(1)
    const id = obs.streamId()
    out.unsubscribe()
    expect(obs.state()).to.equal(ObservableState.idle)
    expect(client.cancels.length).to.equal(1)
    expect(BigInt((client.cancels[0] as StreamCancel).stream_id)).to.equal(id)
    expect(obs.streamId()).to.equal(0n)
  })

  it('6 resubscribe after idle since_timestamp is maxTs', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 2)
    const obs = new RemoteObservable(mux, kDbStartScan, 0, {})
    const c = new RecordingConsumer()
    const out = obs.subscribe(c)
    obs.onStreamItem({ stream_id: obs.streamId(), key: bin('a'), value: bin('1'), timestamp: 10 })
    obs.onStreamDone({ stream_id: obs.streamId() })
    expect(obs.maxTs()).to.equal(10n)
    out.unsubscribe()
    const c2 = new RecordingConsumer()
    obs.subscribe(c2)
    expect(client.starts.length).to.equal(2)
    expect(BigInt(client.starts[1].handle.since_timestamp)).to.equal(10n)
    expect(obs.state()).to.equal(ObservableState.loading)
  })

  it('7 onStreamReset after error is reloading', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 2)
    const obs = new RemoteObservable(mux, kDbStartScan, 0, {})
    const c = new RecordingConsumer()
    obs.subscribe(c)
    obs.onStreamError({ stream_id: obs.streamId(), message: 'fail' })
    expect(obs.state()).to.equal(ObservableState.error)
    obs.onStreamReset({ stream_id: obs.streamId() })
    expect(obs.state()).to.equal(ObservableState.reloading)
    expect(c.resets).to.equal(1)
  })

  it('loopback start_scan then stream_item stream_done stream_cancel', async () => {
    const last = {
      starts: 0,
      cancels: 0,
      lastCancel: 0n,
      lastHandle: null as StreamHandle | null,
    }
    const registry = createScanRegistry((stream) => {
      last.lastHandle = stream
      last.starts++
    })
    const sockets = createLoopbackPair()
    const serverCodecs = createScanCodecs(registry)
    const clientCodecs = createScanCodecs(registry)
    const server = new SocketRpcServer(sockets.s0, registry, serverCodecs)
    const client = new SocketRpcClient(sockets.s1, registry, clientCodecs)

    for (const name of STREAM_MESSAGE_TYPES) {
      server.registerMessageType(name)
      client.registerMessageType(name)
    }
    server.onMessage('stream_cancel', (msg: StreamCancel) => {
      last.lastCancel = typeof msg.stream_id === 'bigint' ? msg.stream_id : BigInt(msg.stream_id)
      last.cancels++
    })

    const mux = new StreamMultiplexer(client, 1, 1)
    const obs = new RemoteObservable(mux, kDbStartScan, 0, { limit: 0n })
    const c = new RecordingConsumer()
    const out = obs.subscribe(c)
    expect(obs.state()).to.equal(ObservableState.loading)

    sockets.transfer(sockets.s1, sockets.s0)
    await server.channel().handleData()
    sockets.transfer(sockets.s0, sockets.s1)
    await client.channel().handleData()

    expect(last.starts).to.equal(1)
    expect(BigInt(last.lastHandle.stream_id)).to.equal(obs.streamId())

    const sid = last.lastHandle.stream_id
    server.sendMessage('stream_item', {
      stream_id: sid,
      key: bin('a'),
      value: bin('1'),
      timestamp: 5n,
    })
    server.sendMessage('stream_item', {
      stream_id: sid,
      key: bin('b'),
      value: bin('2'),
      timestamp: 6n,
    })
    server.sendMessage('stream_done', { stream_id: sid })
    sockets.transfer(sockets.s0, sockets.s1)
    await client.channel().handleData()

    expect(c.changes.length).to.equal(2)
    expectKey(c.changes[0].key, 'a')
    expectKey(c.changes[1].key, 'b')
    expect(c.readys).to.equal(1)
    expect(obs.state()).to.equal(ObservableState.ready)
    expect(obs.getEntries().length).to.equal(2)

    const id = obs.streamId()
    out.unsubscribe()
    sockets.transfer(sockets.s1, sockets.s0)
    await server.channel().handleData()
    sockets.transfer(sockets.s0, sockets.s1)
    await client.channel().handleData()
    expect(last.cancels).to.equal(1)
    expect(last.lastCancel).to.equal(id)
    expect(obs.state()).to.equal(ObservableState.idle)
  })

  it('registry same key reuses reference across idle with delta resume', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 1)
    const registry = new RemoteRegistry(mux)
    const q = {}
    const a = registry.getOrCreate(kDbStartScan, q)
    const b = registry.getOrCreate(kDbStartScan, q)
    expect(a).to.equal(b)

    const other = { limit: 10 }
    const d = registry.getOrCreate(kDbStartScan, other)
    expect(a).to.not.equal(d)
    expect(registry.size()).to.equal(2)

    const live = a.observable()
    const c = new RecordingConsumer()
    const out = live.subscribe(c)
    const remote = live as RemoteObservable
    remote.onStreamItem({ stream_id: remote.streamId(), key: bin('a'), value: bin('1'), timestamp: 10 })
    remote.onStreamDone({ stream_id: remote.streamId() })
    expect(live.maxTs()).to.equal(10n)
    out.unsubscribe()
    expect(live.state()).to.equal(ObservableState.idle)
    expect(registry.size()).to.equal(2)

    const c2 = new RecordingConsumer()
    live.subscribe(c2)
    expect(client.starts.length).to.equal(2)
    expect(BigInt(client.starts[1].handle.since_timestamp)).to.equal(10n)
    expect(a).to.equal(registry.getOrCreate(kDbStartScan, q))
  })

  it('MockChannel tryQueueMessage false holds item ahead of control', () => {
    const channel = new MockClient()
    const src = new Observable<BinaryEntry>()
    const pub = new StreamPublisher(channel)
    pub.attach(7n, src, 0n, 8)
    expect(channel.sent.some((m) => m.typeName === 'stream_opened')).to.equal(true)

    channel.writable = false
    src.onItem({ key: bin('a'), value: bin('1'), ts: 1n })
    src.onDone()
    const items = channel.sent.filter((m) => m.typeName === 'stream_item')
    const dones = channel.sent.filter((m) => m.typeName === 'stream_done')
    expect(items.length).to.equal(0)
    expect(dones.length).to.equal(0)

    channel.writable = true
    pub.onWritable()
    expect(channel.sent.filter((m) => m.typeName === 'stream_item').length).to.equal(1)
    expect(channel.sent.filter((m) => m.typeName === 'stream_done').length).to.equal(1)
    const itemIdx = channel.sent.findIndex((m) => m.typeName === 'stream_item')
    const doneIdx = channel.sent.findIndex((m) => m.typeName === 'stream_done')
    expect(itemIdx).to.be.lessThan(doneIdx)
  })
})

describe('RemoteReference', () => {
  it('observable() dedups and starts createStream once', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 1)
    const registry = new RemoteRegistry(mux)
    const ref = registry.getOrCreate(kDbStartScan, {})
    const a = ref.observable()
    const b = ref.observable()
    expect(a).to.equal(b)
    expect(a.activeCount()).to.equal(0)

    const c1 = new RecordingConsumer()
    const c2 = new RecordingConsumer()
    const out1 = a.subscribe(c1)
    expect(client.starts.length).to.equal(1)
    expect(client.starts[0].handle.flags).to.equal(stream_flags.observe)
    b.subscribe(c2)
    expect(client.starts.length).to.equal(1)
    expect(a.activeCount()).to.equal(2)

    out1.unsubscribe()
    expect(a.activeCount()).to.equal(1)
  })

  it('last unsubscribe cancels the stream', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 1)
    const registry = new RemoteRegistry(mux)
    const ref = registry.getOrCreate(kDbStartScan, {})
    const obs = ref.observable()
    const out = obs.subscribe(new RecordingConsumer())
    expect(client.starts.length).to.equal(1)
    out.unsubscribe()
    expect(obs.state()).to.equal(ObservableState.idle)
    expect(client.cancels.length).to.equal(1)
  })

  it('resubscribe after idle uses maxTs', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 1)
    const registry = new RemoteRegistry(mux)
    const ref = registry.getOrCreate(kDbStartScan, {})
    const obs = ref.observable() as RemoteObservable
    const out = obs.subscribe(new RecordingConsumer())
    obs.onStreamItem({ stream_id: obs.streamId(), key: bin('a'), value: bin('1'), timestamp: 10 })
    obs.onStreamDone({ stream_id: obs.streamId() })
    out.unsubscribe()
    obs.subscribe(new RecordingConsumer())
    expect(client.starts.length).to.equal(2)
    expect(BigInt(client.starts[1].handle.since_timestamp)).to.equal(10n)
  })

  it('stream() during active observe reuses the live observable', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 1)
    const registry = new RemoteRegistry(mux)
    const ref = registry.getOrCreate(kDbStartScan, {})
    const live = ref.observable()
    live.subscribe(new RecordingConsumer())
    expect(ref.stream()).to.equal(live)
    expect(client.starts.length).to.equal(1)
  })

  it('stream() without observe starts a scan stream', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 1)
    const registry = new RemoteRegistry(mux)
    const ref = registry.getOrCreate(kDbStartScan, {})
    const scan = ref.stream()
    scan.subscribe(new RecordingConsumer())
    expect(scan).to.not.equal(ref.peekLive())
    expect(client.starts.length).to.equal(1)
    expect(client.starts[0].handle.flags).to.equal(stream_flags.none)
  })

  it('fetch() while live starts a second scan', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 1)
    const registry = new RemoteRegistry(mux)
    const ref = registry.getOrCreate(kDbStartScan, {})
    const live = ref.observable()
    live.subscribe(new RecordingConsumer())
    expect(client.starts.length).to.equal(1)
    const scan = ref.fetch()
    expect(scan).to.not.equal(live)
    scan.subscribe(new RecordingConsumer())
    expect(client.starts.length).to.equal(2)
    expect(client.starts[1].handle.flags).to.equal(stream_flags.none)
    expect(ref.stream()).to.equal(live)
  })

  it('stream(since) without live forwards since', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 1)
    const registry = new RemoteRegistry(mux)
    const ref = registry.getOrCreate(kDbStartScan, {})
    const scan = ref.stream(5n)
    scan.subscribe(new RecordingConsumer())
    expect(client.starts.length).to.equal(1)
    expect(BigInt(client.starts[0].handle.since_timestamp)).to.equal(5n)
    expect(client.starts[0].handle.flags).to.equal(stream_flags.none)
  })

  it('hold() is a no-op drop in direct mode', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 1)
    const registry = new RemoteRegistry(mux)
    const ref = registry.getOrCreate(kDbStartScan, {})
    const holder = ref.hold()
    const obs = ref.observable()
    const out = obs.subscribe(new RecordingConsumer())
    out.unsubscribe()
    expect(obs.state()).to.equal(ObservableState.idle)
    expect(registry.getOrCreate(kDbStartScan, {})).to.equal(ref)
    holder.dispose()
    expect(registry.getOrCreate(kDbStartScan, {})).to.equal(ref)
  })

  it('getOrCreate dedups by functionId and args, not flags', () => {
    const client = new MockClient()
    const mux = new StreamMultiplexer(client, 1, 1)
    const registry = new RemoteRegistry(mux)
    const q = {}
    const a = registry.getOrCreate(kDbStartScan, q)
    const b = registry.getOrCreate(kDbStartScan, q)
    expect(a).to.equal(b)
    expect(registry.size()).to.equal(1)
    expect(a).to.be.instanceOf(RemoteReference)
  })
})

