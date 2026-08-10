import { expect } from 'chai'

import {
  CodecRegistry,
  LocalSocket,
  SocketRpcServer,
  SocketRpcClient,
  TypeDescription,
  TypeKind,
  TypeRegistry,
  registerMessageCodecs,
  RpcException,
  type SocketMessageChannelSocket,
} from '../src/index.js'

const BUF_SIZE = 4096
const LARGE_BUF = 16384
const FLAT = { format: 'flat' as const }

const SOCKET_OPTS = {
  inputBufferSize: BUF_SIZE,
  outputBufferSize: BUF_SIZE,
  flushThreshold: BUF_SIZE,
  dataEventThreshold: 0,
  drainEventThreshold: BUF_SIZE,
  flags: 0,
}

function createLoopbackPair(bufSize = BUF_SIZE): {
  s0: SocketMessageChannelSocket
  s1: SocketMessageChannelSocket
  transfer: (from: SocketMessageChannelSocket, to: SocketMessageChannelSocket) => void
} {
  const opts = {
    ...SOCKET_OPTS,
    inputBufferSize: bufSize,
    outputBufferSize: bufSize,
    flushThreshold: bufSize,
    drainEventThreshold: bufSize,
  }
  const s0 = new LocalSocket(0, opts) as SocketMessageChannelSocket
  const s1 = new LocalSocket(1, opts) as SocketMessageChannelSocket
  const tmp = new Uint8Array(bufSize)
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

interface TestMethods {
  addId: number
  greetId: number
  noopId: number
  failId: number
  failTypedId: number
  echoId: number
}

function createTestRegistry(): {
  registry: TypeRegistry
  methods: TestMethods
} {
  const registry = new TypeRegistry()
  const sint32 = registry.getTypeByName('sint32')
  const voidType = registry.getTypeByName('void')
  const stringType = registry.getTypeByName('string')
  const uint64 = registry.getTypeByName('uint64')
  if (!sint32 || !voidType || !stringType || !uint64) {
    throw new Error('Missing builtin types')
  }

  const runtimeErrorType = TypeDescription.create({
    name: 'runtime_error',
    kind: TypeKind.Exception,
    members: [{ name: 'what', type: stringType, annotations: [] }],
  })
  const typedErrorType = TypeDescription.create({
    name: 'typed_error',
    kind: TypeKind.Exception,
    members: [{ name: 'what', type: stringType, annotations: [] }],
  })

  const addFn = TypeDescription.create({
    name: 'add_fn',
    kind: TypeKind.Function,
    members: [
      { name: 'a', type: sint32, annotations: [] },
      { name: 'b', type: sint32, annotations: [] },
    ],
    item: sint32,
  })
  addFn.implementation = (a: number, b: number) => a + b

  const greetFn = TypeDescription.create({
    name: 'greet_fn',
    kind: TypeKind.Function,
    members: [{ name: 'name', type: stringType, annotations: [] }],
    item: stringType,
  })
  greetFn.implementation = (name: string) => `hello ${name}`

  const noopFn = TypeDescription.create({
    name: 'noop_fn',
    kind: TypeKind.Function,
    members: [],
    item: voidType,
  })
  noopFn.implementation = () => {}

  const failFn = TypeDescription.create({
    name: 'fail_fn',
    kind: TypeKind.Function,
    members: [],
    item: sint32,
  })
  failFn.implementation = () => {
    throw new Error('oops')
  }

  const failTypedFn = TypeDescription.create({
    name: 'fail_typed_fn',
    kind: TypeKind.Function,
    members: [],
    item: sint32,
  })
  failTypedFn.implementation = () => {
    throw new RpcException('typed oops', 'typed_error')
  }

  const echoFn = TypeDescription.create({
    name: 'echo_fn',
    kind: TypeKind.Function,
    members: [{ name: 's', type: stringType, annotations: [] }],
    item: stringType,
  })
  echoFn.implementation = (s: string) => s

  const customMsg = TypeDescription.create({
    name: 'custom_msg',
    kind: TypeKind.Message,
    members: [
      { name: 'value', type: uint64, annotations: [] },
      { name: 'text', type: stringType, annotations: [] },
    ],
  })

  const serviceType = TypeDescription.create({
    name: 'test_service',
    kind: TypeKind.Object,
    members: [
      { name: 'add', type: addFn, annotations: [] },
      { name: 'greet', type: greetFn, annotations: [] },
      { name: 'noop', type: noopFn, annotations: [] },
      { name: 'failing', type: failFn, annotations: [] },
      { name: 'failing_typed', type: failTypedFn, annotations: [] },
      { name: 'echo', type: echoFn, annotations: [] },
    ],
  })

  registry.registerType(runtimeErrorType)
  registry.registerType(typedErrorType)
  registry.registerType(customMsg)
  registry.registerType(serviceType)
  registry.assignMethodIds()

  const methodByName = new Map(registry.getMethods().map((m) => [m.memberName, m.methodId]))
  return {
    registry,
    methods: {
      addId: methodByName.get('add') ?? -1,
      greetId: methodByName.get('greet') ?? -1,
      noopId: methodByName.get('noop') ?? -1,
      failId: methodByName.get('failing') ?? -1,
      failTypedId: methodByName.get('failing_typed') ?? -1,
      echoId: methodByName.get('echo') ?? -1,
    },
  }
}

async function rpcRoundtrip(
  transfer: (from: SocketMessageChannelSocket, to: SocketMessageChannelSocket) => void,
  clientSock: SocketMessageChannelSocket,
  serverSock: SocketMessageChannelSocket,
  server: SocketRpcServer,
  client: SocketRpcClient
): Promise<void> {
  transfer(clientSock, serverSock)
  await server.channel().handleData()
  transfer(serverSock, clientSock)
  await client.channel().handleData()
}

describe('FlatSocketRpc (format: flat)', () => {
  it('call with int return', async () => {
    const { registry, methods } = createTestRegistry()
    const codecs = new CodecRegistry()
    const { s0, s1, transfer } = createLoopbackPair()
    const server = new SocketRpcServer(s1, registry, codecs, FLAT)
    const client = new SocketRpcClient(s0, registry, codecs, FLAT)

    const promise = client.call(methods.addId, 3, 5)
    await rpcRoundtrip(transfer, s0, s1, server, client)
    expect(await promise).to.equal(8)
  })

  it('call with string return', async () => {
    const { registry, methods } = createTestRegistry()
    const codecs = new CodecRegistry()
    const { s0, s1, transfer } = createLoopbackPair()
    const server = new SocketRpcServer(s1, registry, codecs, FLAT)
    const client = new SocketRpcClient(s0, registry, codecs, FLAT)

    const promise = client.call(methods.greetId, 'world')
    await rpcRoundtrip(transfer, s0, s1, server, client)
    expect(await promise).to.equal('hello world')
  })

  it('void call', async () => {
    const { registry, methods } = createTestRegistry()
    const codecs = new CodecRegistry()
    const { s0, s1, transfer } = createLoopbackPair()
    const server = new SocketRpcServer(s1, registry, codecs, FLAT)
    const client = new SocketRpcClient(s0, registry, codecs, FLAT)

    const promise = client.call(methods.noopId)
    await rpcRoundtrip(transfer, s0, s1, server, client)
    expect(await promise).to.equal(undefined)
  })

  it('error propagation (runtime_error)', async () => {
    const { registry, methods } = createTestRegistry()
    const codecs = new CodecRegistry()
    const { s0, s1, transfer } = createLoopbackPair()
    const server = new SocketRpcServer(s1, registry, codecs, FLAT)
    const client = new SocketRpcClient(s0, registry, codecs, FLAT)

    const promise = client.call(methods.failId)
    await rpcRoundtrip(transfer, s0, s1, server, client)
    try {
      await promise
      expect.fail('expected rejection')
    } catch (e) {
      expect(e).to.be.instanceOf(RpcException)
      expect((e as RpcException).message).to.equal('oops')
      expect((e as RpcException).typeName).to.equal('runtime_error')
    }
  })

  it('typed exception propagation', async () => {
    const { registry, methods } = createTestRegistry()
    const codecs = new CodecRegistry()
    const { s0, s1, transfer } = createLoopbackPair()
    const server = new SocketRpcServer(s1, registry, codecs, FLAT)
    const client = new SocketRpcClient(s0, registry, codecs, FLAT)

    const promise = client.call(methods.failTypedId)
    await rpcRoundtrip(transfer, s0, s1, server, client)
    try {
      await promise
      expect.fail('expected rejection')
    } catch (e) {
      expect(e).to.be.instanceOf(RpcException)
      expect((e as RpcException).message).to.equal('typed oops')
      expect((e as RpcException).typeName).to.equal('typed_error')
    }
  })

  it('invalid function id', async () => {
    const { registry } = createTestRegistry()
    const codecs = new CodecRegistry()
    const { s0, s1, transfer } = createLoopbackPair()
    const server = new SocketRpcServer(s1, registry, codecs, FLAT)
    const client = new SocketRpcClient(s0, registry, codecs, FLAT)

    // Client.call validates method ids locally; send raw request like C++ call(999).
    const sint32 = registry.getTypeByName('sint32')!
    const requestId = 0n
    const promise = new Promise((resolve, reject) => {
      ;(client as any).responseHandlers.set(requestId, {
        resolve,
        reject,
        returnType: sint32,
      })
    })
    ;(client as any).lastRequestId = 1n

    const w = client.channel().beginSend('rpc_request', {
      request_id: requestId,
      function_id: 999n,
    })
    w.writeRest()
    client.channel().commitSend()

    await rpcRoundtrip(transfer, s0, s1, server, client)
    try {
      await promise
      expect.fail('expected rejection')
    } catch (e) {
      expect(e).to.be.instanceOf(RpcException)
      expect((e as RpcException).message).to.equal('Function not found')
    }
  })

  it('multiple sequential calls', async () => {
    const { registry, methods } = createTestRegistry()
    const codecs = new CodecRegistry()
    const { s0, s1, transfer } = createLoopbackPair()
    const server = new SocketRpcServer(s1, registry, codecs, FLAT)
    const client = new SocketRpcClient(s0, registry, codecs, FLAT)

    for (let i = 0; i < 10; ++i) {
      const promise = client.call(methods.addId, i, i * 10)
      await rpcRoundtrip(transfer, s0, s1, server, client)
      expect(await promise).to.equal(i + i * 10)
    }
  })

  it('large string data', async () => {
    const { registry, methods } = createTestRegistry()
    const codecs = new CodecRegistry()
    const { s0, s1, transfer } = createLoopbackPair(LARGE_BUF)
    const server = new SocketRpcServer(s1, registry, codecs, FLAT)
    const client = new SocketRpcClient(s0, registry, codecs, FLAT)

    const large = 'B'.repeat(1024)
    const promise = client.call(methods.echoId, large)
    await rpcRoundtrip(transfer, s0, s1, server, client)
    expect(await promise).to.equal(large)
  })

  it('mixed with custom messages on same channel', async () => {
    const { registry, methods } = createTestRegistry()
    const codecs = new CodecRegistry()
    registerMessageCodecs(codecs, registry)

    const { s0, s1, transfer } = createLoopbackPair()
    const server = new SocketRpcServer(s1, registry, codecs, FLAT)
    const client = new SocketRpcClient(s0, registry, codecs, FLAT)

    server.registerMessageType('custom_msg')
    client.registerMessageType('custom_msg')

    let customReceived = false
    let customValue = 0n
    let customText = ''
    server.onMessage('custom_msg', (msg: unknown) => {
      customReceived = true
      const m = msg as { value: number | bigint, text: string }
      customValue = typeof m.value === 'bigint' ? m.value : BigInt(m.value)
      customText = m.text
    })

    client.sendMessage('custom_msg', { value: 42n, text: 'custom hello' })

    const rpcPromise = client.call(methods.addId, 10, 20)
    await rpcRoundtrip(transfer, s0, s1, server, client)

    expect(customReceived).to.be.true
    expect(customValue).to.equal(42n)
    expect(customText).to.equal('custom hello')
    expect(await rpcPromise).to.equal(30)
  })
})
