import { expect } from 'chai'

import {
  CodecRegistry,
  LocalSocket,
  SocketMessageChannel,
  SocketRpcServer,
  RawRpcServer,
  Reader,
  Writer,
  TypeDescription,
  TypeKind,
  TypeRegistry,
  ensureRpcCodecs,
  ensureRpcTypesInRegistry,
  RPC_REQUEST_TYPE,
  RPC_RESPONSE_TYPE,
  RPC_ERROR_TYPE,
  type SocketMessageChannelSocket
} from '../src/index.js'
import { serializeValueByType, deserializeValueByType, type JsonValue } from '../src/valueSerialization.js'

const BUF_SIZE = 4096
const SOCKET_OPTS = {
  inputBufferSize: BUF_SIZE,
  outputBufferSize: BUF_SIZE,
  flushThreshold: BUF_SIZE,
  dataEventThreshold: 0,
  drainEventThreshold: BUF_SIZE,
  flags: 0
}

function createLoopbackPair(): {
  s0: SocketMessageChannelSocket
  s1: SocketMessageChannelSocket
  transfer: (from: SocketMessageChannelSocket, to: SocketMessageChannelSocket) => void
} {
  const s0 = new LocalSocket(10, SOCKET_OPTS) as SocketMessageChannelSocket
  const s1 = new LocalSocket(11, SOCKET_OPTS) as SocketMessageChannelSocket
  const tmp = new Uint8Array(4096)
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
  sumId: number
  pingId: number
  failId: number
}

function createTestRegistry(): { registry: TypeRegistry, methods: TestMethods, runtimeErrorType: TypeDescription } {
  const registry = new TypeRegistry()
  const uint32 = registry.getTypeByName('uint32')
  const voidType = registry.getTypeByName('void')
  const stringType = registry.getTypeByName('string')
  if (!uint32 || !voidType || !stringType) {
    throw new Error('Missing builtin types')
  }

  const runtimeErrorType = TypeDescription.create({
    name: 'runtime_error',
    kind: TypeKind.Exception,
    members: [{ name: 'what', type: stringType, annotations: [] }]
  })

  const sumFn = TypeDescription.create({
    name: 'sum_fn',
    kind: TypeKind.Function,
    members: [{ name: 'value', type: uint32, annotations: [] }],
    item: uint32
  })
  sumFn.implementation = (value: number) => value + 41

  const pingFn = TypeDescription.create({
    name: 'ping_fn',
    kind: TypeKind.Function,
    members: [],
    item: voidType
  })
  pingFn.implementation = () => {}

  const failFn = TypeDescription.create({
    name: 'fail_fn',
    kind: TypeKind.Function,
    members: [],
    item: uint32
  })
  failFn.implementation = () => {
    throw new Error('boom')
  }

  const serviceType = TypeDescription.create({
    name: 'test_service',
    kind: TypeKind.Object,
    members: [
      { name: 'sum', type: sumFn, annotations: [] },
      { name: 'ping', type: pingFn, annotations: [] },
      { name: 'fail', type: failFn, annotations: [] }
    ]
  })

  registry.registerType(runtimeErrorType)
  registry.registerType(serviceType)
  registry.assignMethodIds()

  const methodByName = new Map(registry.getMethods().map((method) => [method.memberName, method.methodId]))
  return {
    registry,
    runtimeErrorType,
    methods: {
      sumId: methodByName.get('sum') ?? -1,
      pingId: methodByName.get('ping') ?? -1,
      failId: methodByName.get('fail') ?? -1
    }
  }
}

function registerRuntimeErrorCodec(
  channel: SocketMessageChannel,
  registry: TypeRegistry,
  runtimeErrorType: TypeDescription
): void {
  channel.registerExceptionType(
    runtimeErrorType.name,
    (writer, value) => serializeValueByType(writer as any, registry, runtimeErrorType, value as JsonValue),
    (reader) => {
      let result: unknown
      deserializeValueByType(reader as any, registry, runtimeErrorType, (value) => {
        result = value
      })
      return result
    }
  )
}

describe('SocketRpcServer protocol compatibility', () => {
  it('sends rpc_response without legacy success byte for non-void returns', async () => {
    const { registry, methods, runtimeErrorType } = createTestRegistry()
    const codecs = new CodecRegistry()
    ensureRpcTypesInRegistry(registry)
    ensureRpcCodecs(codecs, registry)

    const { s0, s1, transfer } = createLoopbackPair()
    const server = new SocketRpcServer(s1, registry, codecs)
    const clientChannel = new SocketMessageChannel(s0, codecs)
    clientChannel.registerMessageType(RPC_REQUEST_TYPE)
    clientChannel.registerMessageType(RPC_RESPONSE_TYPE)
    clientChannel.registerMessageType(RPC_ERROR_TYPE)
    registerRuntimeErrorCodec(clientChannel, registry, runtimeErrorType)

    let responseValue: number | undefined
    let responsePayloadSize = -1
    clientChannel.onMessage(RPC_RESPONSE_TYPE, (_msg: unknown, payloadSize: number) => {
      responsePayloadSize = payloadSize
      let value: unknown
      deserializeValueByType(clientChannel.getReader() as any, registry, registry.getTypeByName('uint32')!, (v) => {
        value = v
      })
      clientChannel.getReader().readRest()
      responseValue = value as number
    })

    const requestWriter = clientChannel.beginSend(RPC_REQUEST_TYPE, {
      request_id: 77n,
      function_id: BigInt(methods.sumId)
    })
    serializeValueByType(requestWriter as any, registry, registry.getTypeByName('uint32')!, 9)
    requestWriter.writeRest()
    clientChannel.commitSend()

    transfer(s0, s1)
    await server.channel().handleData()
    transfer(s1, s0)
    await clientChannel.handleData()

    expect(responseValue).to.equal(50)
    expect(responsePayloadSize).to.be.greaterThan(0)
  })

  it('sends rpc_response with empty payload for void', async () => {
    const { registry, methods, runtimeErrorType } = createTestRegistry()
    const codecs = new CodecRegistry()
    ensureRpcTypesInRegistry(registry)
    ensureRpcCodecs(codecs, registry)

    const { s0, s1, transfer } = createLoopbackPair()
    const server = new SocketRpcServer(s1, registry, codecs)
    const clientChannel = new SocketMessageChannel(s0, codecs)
    clientChannel.registerMessageType(RPC_REQUEST_TYPE)
    clientChannel.registerMessageType(RPC_RESPONSE_TYPE)
    clientChannel.registerMessageType(RPC_ERROR_TYPE)
    registerRuntimeErrorCodec(clientChannel, registry, runtimeErrorType)

    let responsePayloadSize = -1
    clientChannel.onMessage(RPC_RESPONSE_TYPE, (_msg: unknown, payloadSize: number) => {
      responsePayloadSize = payloadSize
    })

    clientChannel.sendMessage(RPC_REQUEST_TYPE, {
      request_id: 90n,
      function_id: BigInt(methods.pingId)
    })

    transfer(s0, s1)
    await server.channel().handleData()
    transfer(s1, s0)
    await clientChannel.handleData()

    expect(responsePayloadSize).to.equal(0)
  })

  it('sends rpc_error with serialized exception on failure and unknown method', async () => {
    const { registry, methods, runtimeErrorType } = createTestRegistry()
    const codecs = new CodecRegistry()
    ensureRpcTypesInRegistry(registry)
    ensureRpcCodecs(codecs, registry)

    const { s0, s1, transfer } = createLoopbackPair()
    const server = new SocketRpcServer(s1, registry, codecs)
    const clientChannel = new SocketMessageChannel(s0, codecs)
    clientChannel.registerMessageType(RPC_REQUEST_TYPE)
    clientChannel.registerMessageType(RPC_RESPONSE_TYPE)
    clientChannel.registerMessageType(RPC_ERROR_TYPE)
    registerRuntimeErrorCodec(clientChannel, registry, runtimeErrorType)

    const errors: Array<{ requestId: number | bigint, message: string }> = []
    clientChannel.onMessage(RPC_ERROR_TYPE, (msg: unknown) => {
      const requestId = (msg as { request_id: number | bigint }).request_id
      const exc = clientChannel.getReader().readException()
      clientChannel.getReader().readRest()
      const message = (exc.value as { what?: string }).what ?? String(exc.value)
      errors.push({ requestId, message })
    })

    clientChannel.sendMessage(RPC_REQUEST_TYPE, {
      request_id: 100n,
      function_id: BigInt(methods.failId)
    })
    clientChannel.sendMessage(RPC_REQUEST_TYPE, {
      request_id: 101n,
      function_id: 999999n
    })

    transfer(s0, s1)
    await server.channel().handleData()
    transfer(s1, s0)
    await clientChannel.handleData()

    expect(errors).to.have.length(2)
    expect(BigInt(errors[0].requestId)).to.equal(100n)
    expect(errors[0].message).to.equal('boom')
    expect(BigInt(errors[1].requestId)).to.equal(101n)
    expect(errors[1].message).to.equal('Function not found')
  })
})

describe('RawRpcServer legacy protocol', () => {
  it('keeps legacy response format (request_id + success flag + payload)', async () => {
    const { registry, methods } = createTestRegistry()
    const codecs = new CodecRegistry()
    const server = new RawRpcServer(registry, () => {}, () => {})

    const requestWriter = new Writer(codecs, 256)
    requestWriter.writeU64(12n)
    requestWriter.writeU64(BigInt(methods.sumId))
    requestWriter.writeU32(5)
    requestWriter.writeRest()

    const requestReader = new Reader(requestWriter.toArrayBuffer(), codecs)
    const responseWriter = new Writer(codecs, 256)

    await server.handleCall(requestReader, responseWriter)

    const responseReader = new Reader(responseWriter.toArrayBuffer(), codecs)
    expect(responseReader.readU64()).to.equal(12)
    expect(responseReader.readBool()).to.equal(true)
    expect(responseReader.readU32()).to.equal(46)
    responseReader.readRest()
  })
})
