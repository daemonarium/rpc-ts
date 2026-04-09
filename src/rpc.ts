/**
 * RPC message types matching C++ rpc.hpp.
 * Order of registration (rpc_request, rpc_response, rpc_error) must be preserved
 * for wire compatibility with cpp-rpc.
 */

import { TypeKind, TypeDescription, TypeRegistry } from './typeDescription.js'
import { CodecRegistry } from './codec.js'
import { serializeValueByType, deserializeValueByType, type JsonValue } from './valueSerialization.js'

export const RPC_REQUEST_TYPE = 'rpc_request'
export const RPC_RESPONSE_TYPE = 'rpc_response'
export const RPC_ERROR_TYPE = 'rpc_error'

export interface RpcRequest {
  request_id: bigint
  function_id: bigint
}

export interface RpcResponse {
  request_id: bigint
}

export interface RpcError {
  request_id: bigint
}

/**
 * Create TypeDescription for rpc_request (request_id: uint64, function_id: uint64).
 */
function createRpcRequestType(registry: TypeRegistry): TypeDescription {
  const uint64 = registry.getTypeByName('uint64')
  if (!uint64) throw new Error('Registry must have uint64 type')
  return TypeDescription.create({
    name: RPC_REQUEST_TYPE,
    kind: TypeKind.Message,
    members: [
      { name: 'request_id', type: uint64, annotations: [] },
      { name: 'function_id', type: uint64, annotations: [] }
    ]
  })
}

/**
 * Create TypeDescription for rpc_response (request_id: uint64).
 */
function createRpcResponseType(registry: TypeRegistry): TypeDescription {
  const uint64 = registry.getTypeByName('uint64')
  if (!uint64) throw new Error('Registry must have uint64 type')
  return TypeDescription.create({
    name: RPC_RESPONSE_TYPE,
    kind: TypeKind.Message,
    members: [
      { name: 'request_id', type: uint64, annotations: [] }
    ]
  })
}

/**
 * Create TypeDescription for rpc_error (request_id: uint64).
 */
function createRpcErrorType(registry: TypeRegistry): TypeDescription {
  const uint64 = registry.getTypeByName('uint64')
  if (!uint64) throw new Error('Registry must have uint64 type')
  return TypeDescription.create({
    name: RPC_ERROR_TYPE,
    kind: TypeKind.Message,
    members: [
      { name: 'request_id', type: uint64, annotations: [] }
    ]
  })
}

/**
 * Ensures rpc_request, rpc_response, rpc_error are in the registry (in that order).
 * Call before building SocketMessageChannel / SocketRpcClient / SocketRpcServer
 * so that RPC message type indices are 0, 1, 2 for wire compatibility with cpp-rpc.
 */
export function ensureRpcTypesInRegistry(registry: TypeRegistry): void {
  if (!registry.getTypeByName(RPC_REQUEST_TYPE)) {
    registry.registerType(createRpcRequestType(registry))
  }
  if (!registry.getTypeByName(RPC_RESPONSE_TYPE)) {
    registry.registerType(createRpcResponseType(registry))
  }
  if (!registry.getTypeByName(RPC_ERROR_TYPE)) {
    registry.registerType(createRpcErrorType(registry))
  }
}

/**
 * Registers codecs for rpc_request, rpc_response, rpc_error if not already present.
 * Call after ensureRpcTypesInRegistry when using SocketMessageChannel / SocketRpcClient / SocketRpcServer.
 */
export function ensureRpcCodecs(codecs: CodecRegistry, registry: TypeRegistry): void {
  for (const name of [RPC_REQUEST_TYPE, RPC_RESPONSE_TYPE, RPC_ERROR_TYPE]) {
    if (codecs.messages.has(name)) continue
    const type = registry.getTypeByName(name)
    if (!type) throw new Error(`RPC type ${name} not in registry; call ensureRpcTypesInRegistry first`)
    codecs.messages.register({
      name,
      serialize: (writer, value) => serializeValueByType(writer as any, registry, type, value as JsonValue),
      deserialize: (reader, output) => deserializeValueByType(reader as any, registry, type, output)
    })
  }
}
