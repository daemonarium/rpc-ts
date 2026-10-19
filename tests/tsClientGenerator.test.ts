import { expect } from 'chai'
import {
  TypeKind,
  TypeDescription,
  TypeRegistry,
  serializeTypeRegistry,
  deserializeTypeRegistry,
  isMemberObservable,
  isMemberStreamable,
  generateTsClient,
  glueCodeGenerators,
  type TypedValue,
} from '../src/index.js'

function observableAnnotation(): TypedValue {
  return { _type: 'observable_annotation' }
}

function streamableAnnotation(): TypedValue {
  return { _type: 'streamable_annotation' }
}

function buildClientRegistry(): TypeRegistry {
  const registry = new TypeRegistry()
  const void_ = registry.getTypeByName('void')!
  const string_ = registry.getTypeByName('string')!
  const uint8 = registry.getTypeByName('uint8')!
  const uint32 = registry.getTypeByName('uint32')!
  const uint64 = registry.getTypeByName('uint64')!
  const binary = registry.getTypeByName('binary')!

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

  const ping = TypeDescription.create({
    name: 'observable_db.ping',
    kind: TypeKind.Function,
    members: [
      { name: 'msg', type: string_, annotations: [] },
    ],
    item: string_,
  })

  const tableWatch = TypeDescription.create({
    name: 'observable_db.table_watch',
    kind: TypeKind.Function,
    members: [
      { name: 'stream', type: streamHandle, annotations: [] },
      { name: 'table_id', type: uint8, annotations: [] },
      { name: 'lower_id', type: binary, annotations: [] },
    ],
    item: void_,
  })

  const tableScan = TypeDescription.create({
    name: 'observable_db.table_scan',
    kind: TypeKind.Function,
    members: [
      { name: 'stream', type: streamHandle, annotations: [] },
      { name: 'table_id', type: uint8, annotations: [] },
      { name: 'limit', type: uint64, annotations: [] },
    ],
    item: void_,
  })

  const api = TypeDescription.create({
    name: 'observable_db',
    kind: TypeKind.Object,
    members: [
      { name: 'ping', type: ping, annotations: [] },
      { name: 'table_watch', type: tableWatch, annotations: [observableAnnotation()] },
      { name: 'table_scan', type: tableScan, annotations: [streamableAnnotation()] },
    ],
  })

  registry.registerType(streamHandle)
  registry.registerType(ping)
  registry.registerType(tableWatch)
  registry.registerType(tableScan)
  registry.registerType(api)
  return registry
}

function methodSignature(code: string, name: string): string {
  const match = code.match(new RegExp(`  ${name}\\([^)]*\\)`))
  expect(match, `missing method ${name}`).to.exist
  return match![0]
}

describe('TS Client generator', () => {
  it('is registered as a glue-code language', () => {
    expect(glueCodeGenerators.map((g) => g.name)).to.include('TS Client')
  })

  it('round-trips annotations then still classifies methods', () => {
    const restored = deserializeTypeRegistry(serializeTypeRegistry(buildClientRegistry()))
    const api = restored.getTypes().find((t) => t.name === 'observable_db')
    expect(api).to.exist
    const watch = api!.members.find((m) => m.name === 'table_watch')!
    const scan = api!.members.find((m) => m.name === 'table_scan')!
    const ping = api!.members.find((m) => m.name === 'ping')!
    expect(isMemberObservable(watch)).to.equal(true)
    expect(isMemberStreamable(scan)).to.equal(true)
    expect(isMemberObservable(ping)).to.equal(false)
    expect(isMemberStreamable(ping)).to.equal(false)
  })

  it('keeps the original methods and adds a RemoteReference extra', () => {
    const code = generateTsClient(buildClientRegistry(), { className: 'ObservableDbClient' })
    expect(code).to.include('export class ObservableDbClient')
    expect(code).to.match(/ping\(msg: string\): Promise<string>/)
    expect(code).to.match(/table_watch\(/)
    expect(code).to.match(/table_watch\([^)]*\): RemoteReference/)
    expect(code).to.match(/table_scan\(/)
    expect(code).to.match(/table_scan_stream\(/)
    expect(code).to.not.match(/table_watch_observable\(/)
    expect(code).to.not.match(/table_watch_stream\(/)
    expect(code).to.not.match(/ping_observable\(/)
    expect(code).to.not.match(/ping_stream\(/)
    expect(code).to.not.match(/table_scan_observable\(/)
  })

  it('omits stream_handle from generated reference methods', () => {
    const code = generateTsClient(buildClientRegistry())
    const originalWatch = methodSignature(code, 'table_watch')
    expect(originalWatch).to.include('stream: stream_handle')
    expect(originalWatch).to.include('table_id: number')
    expect(code).to.match(/table_watch\(table_id: number/)
    expect(code).to.match(/table_scan_stream\(table_id: number/)
    const extraScan = methodSignature(code, 'table_scan_stream')
    expect(extraScan).to.not.include('stream_handle')
  })

  it('emits RemoteRegistry.getOrCreate with the method id and remaining args', () => {
    const code = generateTsClient(buildClientRegistry())
    expect(code).to.include('import { SocketRpcClient, RemoteReference, RemoteRegistry, StreamMultiplexer, type MessageChannel } from \'@daemonarium/rpc\'')
    expect(code).to.include('streamChannel?: MessageChannel')
    expect(code).to.include('new StreamMultiplexer(rpcClient, streamChannel, returnPid, returnSocket)')
    expect(code).to.include('this.rpcClient.call(')
    expect(code).to.match(/return this\.remoteRegistry\.getOrCreate\(1, \.\.\.args\)/)
    expect(code).to.match(/table_scan_stream\([\s\S]*?return this\.remoteRegistry\.getOrCreate\(2, table_id, limit\)/)
  })

  it('accepts a custom import path', () => {
    const code = generateTsClient(buildClientRegistry(), { importPath: '../src/index.js' })
    expect(code).to.include("from '../src/index.js'")
  })
})
