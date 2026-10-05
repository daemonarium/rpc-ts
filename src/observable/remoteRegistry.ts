/**
 * Port of cpp-rpc/src/observable/remote_registry.hpp.
 *
 * Owns RemoteObservables keyed by (function_id, serialized args) so they
 * survive idle (0 consumers). Resubscribe reuses the same object and
 * therefore maxTs / the retained view (delta resume). v1: no eviction.
 */

import type { MessageChannel } from '../MessageChannel.js'
import { RemoteObservable } from './remoteObservable.js'
import { stream_flags } from './streamProtocol.js'
import type { StreamMultiplexer, StreamStarter } from './streamMultiplexer.js'

export interface ObservationKey {
  functionId: bigint
  argsBytes: Uint8Array
}

export function serializeObservationArgs(args: unknown[]): Uint8Array {
  const json = JSON.stringify(args, (_k, v) => {
    if (typeof v === 'bigint') return { __bigint: v.toString() }
    if (v instanceof Uint8Array) return { __bin: Array.from(v) }
    return v
  })
  return new TextEncoder().encode(json)
}

export function observationKeyId(key: ObservationKey): string {
  let h2 = 0
  for (let i = 0; i < key.argsBytes.length; i++) {
    h2 = h2 * 131 + key.argsBytes[i]
  }
  return `${key.functionId.toString()}:${h2}:${key.argsBytes.length}`
}

function argsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export class RemoteRegistry<
  Starter extends StreamStarter = StreamStarter,
  Channel extends MessageChannel = MessageChannel
> {
  private readonly mux: StreamMultiplexer<Starter, Channel>
  private readonly entries: Array<{ key: ObservationKey, obs: RemoteObservable<Starter, Channel> }> = []

  constructor(mux: StreamMultiplexer<Starter, Channel>) {
    this.mux = mux
  }

  getOrCreate(
    functionId: bigint | number,
    flags: number = stream_flags.none,
    ...args: unknown[]
  ): RemoteObservable<Starter, Channel> {
    const fid = typeof functionId === 'bigint' ? functionId : BigInt(functionId)
    const key: ObservationKey = {
      functionId: fid,
      argsBytes: serializeObservationArgs(args),
    }
    for (const e of this.entries) {
      if (e.key.functionId === key.functionId && argsEqual(e.key.argsBytes, key.argsBytes)) {
        return e.obs
      }
    }
    const obs = new RemoteObservable<Starter, Channel>(this.mux, fid, flags, ...args)
    this.entries.push({ key, obs })
    return obs
  }

  size(): number {
    return this.entries.length
  }
}
