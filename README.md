# ts-rpc

Biblioteka TypeScript łącząca:

1. **serializację / deserializację** wartości według `TypeRegistry` (codecs + `valueSerialization`),
2. **RPC** i kanał wiadomości na sockecie (TS ↔ WASM / C++ `cpp-rpc`).

Warstwa typów (`serializeValueByType` / `deserializeValueByType`) nie zna formatu ani medium — woła wspólny kontrakt **`IWriter` / `IReader`**. Konkretny backend (compressed / flat / key) implementuje ten kontrakt.

---

## Formaty binarne

| | Compressed | Flat | Key |
|--|------------|------|-----|
| Status | legacy opt-in | **domyślny** (serializacja + message channel + RPC) — [flat-todo.md](flat-todo.md) | serializacja (+ circular), bez RPC — [key-todo.md](key-todo.md) |
| Liczby | varint / sortowalny float | fixed LE (jak C++) | jak compressed, w regionie **data** |
| Mapy | interleaved (`length` + pary) | SoA | throw |
| Ramki | `beginFrame` / `endFrame` / `saveOffset` = no-op | trailery checkpointów | no-op |
| Layout | strumień | strumień + trailery | `[data][meta][u8 meta_size]` |
| Odczyt | zawsze materialized | zawsze materialized (brak `flat_view` w TS) | materialized |

Specyfikacja wire flat: [../cpp-rpc/flat-format.md](../cpp-rpc/flat-format.md). Spec key: [../cpp-rpc/key-format.md](../cpp-rpc/key-format.md). Compressed / flat / key **nie są** kompatybilne bajtowo — nie mieszać na jednym sockecie.

Blob `TypeRegistry` / `rpc_description`: `[envelope u8][compressed body]` — `TypeRegistry.dataFormat` / `SerializationFormat` (`Compressed` | `Flat` | `Key`). Body registry zawsze compressed. Spec: [../cpp-rpc/type-registry-blob.md](../cpp-rpc/type-registry-blob.md).

---

## Goldeny vs cpp-rpc

Checked-in TSV (źródło prawdy = C++ generators w `cmake-build-debug/tests/` lub lokalnym `build/tests/`):

| Plik | Zawartość |
|------|-----------|
| [`tests/serialization_reference.tsv`](tests/serialization_reference.tsv) | skalarne compressed |
| [`tests/serialization_flat_reference.tsv`](tests/serialization_flat_reference.tsv) | skalarne flat LE |
| [`tests/serialization_complex_reference.tsv`](tests/serialization_complex_reference.tsv) | Person value/graph compressed+flat |

Regeneracja (wymaga reflection clang build; preferuj `cmake-build-debug`, albo `build/` jeśli tak masz skonfigurowane):

```bash
cmake --build cmake-build-debug --target generate_serialization_tsv generate_serialization_complex_tsv
./cmake-build-debug/tests/generate_serialization_tsv ts-rpc/tests/serialization_reference.tsv
./cmake-build-debug/tests/generate_serialization_tsv --flat ts-rpc/tests/serialization_flat_reference.tsv
./cmake-build-debug/tests/generate_serialization_complex_tsv ts-rpc/tests/serialization_complex_reference.tsv
```

Fixture Person: wspólny Rng w [`cpp-rpc/src/test/person_fixture.hpp`](../cpp-rpc/src/test/person_fixture.hpp) + port [`tests/personFixture.ts`](tests/personFixture.ts).

---

## Architektura

```
┌─────────────────────────────────────────────────────────┐
│  SocketRpc* / SocketMessageChannel / FlatSocketMessage… │
└────────────────────────────┬────────────────────────────┘
                             │ codecs + valueSerialization
┌────────────────────────────▼────────────────────────────┐
│  IWriter / IReader  (writerTypes.ts)                    │
└────────────────────────────┬────────────────────────────┘
         ┌───────────────────┼───────────────────┬──────────────────┐
         ▼                   ▼                   ▼                  ▼
   Writer / Reader   LocalCircularBuffer*   FlatWriter / …    KeyWriter / KeyReader /
   (ArrayBuffer)     (socket buffers)       FlatLocalCircular* KeyLocalCircular*
```

### Kontrakt `IWriter` / `IReader`

Obowiązkowe metody (używane przez `valueSerialization` i codecs):

- skalary: `writeU64`…`writeBool` / `readU64`…`readBool`
- `writeString` / `writeBinary` / `writeLength` (+ read)
- ramki: writer `beginFrame` / `endFrame` / `saveOffset`; reader `enterFrame` / `exitFrame` / `saveOffset`
- graf: `writePointer` / `writeRest` / `readPointer` / `readRest`
- `writeTyped` / `readTyped`
- **`writeMap` / `readMap`** — layout zależy od backendu:
  - compressed: `writeLength(n)` + interleaved key/value callbacks (jak C++ `stream_writer::write_map`)
  - flat: SoA wg `flat-format.md` (`FlatWriter` / `FlatReader` / circular)
  - key: throw (map/pointer/typed nieobsługiwane)

`ModuleCircularBufferWriter` / `Reader` to niskopoziomowe poke/peek (nie pełny kontrakt) — używane do surowego I/O, nie przez `valueSerialization`.

---

## Message / RPC

- [`SocketMessageChannel`](src/SocketMessageChannel.ts) — compressed: `[len 4B LE][type u64 varint][body][writeRest][payload]`
- [`FlatSocketMessageChannel`](src/FlatSocketMessageChannel.ts) — flat: `[len][type u32 LE][encoded_size_0][root][writeRest…][sentinel 0][payload]` (wspólne framing: [`socketMessageFraming.ts`](src/socketMessageFraming.ts))
- [`SocketRpcServer`](src/SocketRpcServer.ts) / [`SocketRpcClient`](src/SocketRpcClient.ts) — domyślnie flat; compressed opt-in: `new SocketRpcServer(socket, registry, codecs, { format: 'compressed' })`
- Nazwa [`SocketMessageChannel`](src/SocketMessageChannel.ts) = ścieżka **compressed**; flat = `FlatSocketMessageChannel`
- C++ opt-in compressed USER: `WAOS_MODULE_RPC_COMPRESSED` ([`module.hpp`](../cpp-rpc/src/utils/module.hpp))
- [`MessageChannel`](src/MessageChannel.ts) — węższy interfejs (`registerMessageType` / `onMessage` / `sendMessage` / `tryQueueMessage` / `isWritable` / `onWritable`). `tryQueueMessage` zwraca `false` gdy kanał pełen (C++ `try_queue_message`, bez flusha). [`SocketMessageChannelBase`](src/socketMessageFraming.ts) implementuje go; [`SocketRpcClient`](src/SocketRpcClient.ts) to pass-through — jeden obiekt spełnia **Starter + Channel**.

---

## Observable

Port [`../cpp-rpc/src/observable/`](../cpp-rpc/src/observable/) w [`src/observable/`](src/observable/). Kernel-independent: transport to dowolny `MessageChannel` (LocalSocket, później WS / SockJS). „Remote” = across a message channel, nie „across the network”.

| Warstwa | Plik | C++ |
|---------|------|-----|
| LWW + lifecycle | [`observable.ts`](src/observable/observable.ts) | `observable.hpp` |
| Consumer + ring + Promise backpressure | [`consumerOutput.ts`](src/observable/consumerOutput.ts), [`ringBuffer.ts`](src/observable/ringBuffer.ts) | `consumer_output.hpp`, `ring_buffer.hpp` |
| Demux `stream_*` | [`streamMultiplexer.ts`](src/observable/streamMultiplexer.ts) | `stream_multiplexer.hpp` |
| Wire → Observable | [`remoteObservable.ts`](src/observable/remoteObservable.ts) | `remote_observable.hpp` |
| Observable → wire | [`streamPublisher.ts`](src/observable/streamPublisher.ts), [`streamRelayConsumer.ts`](src/observable/streamRelayConsumer.ts) | `stream_publisher.hpp`, `stream_relay_consumer.hpp` |
| Cache po `(function_id, args)` | [`remoteRegistry.ts`](src/observable/remoteRegistry.ts) | `remote_registry.hpp` |

Backpressure: `onChange` zwraca `ObservablePromise` (resolved = sync, pending = czekaj); na kanale `tryQueueMessage` + `onWritable`. `SocketRpcClient` = Starter (`call`) + Channel w jednym, jak C++ `StreamMultiplexer(client, client, pid, socket)`.

Adapter kernelowy (opcjonalny): [`../ts-kernel/src/KernelStreamEndpoint.ts`](../ts-kernel/src/KernelStreamEndpoint.ts) — para `(pid, socket)` jako `MessageChannel`. Rdzeń w `ts-rpc` działa bez kernela (`MockChannel` w testach).

---

## Testy

```bash
cd ts-rpc && npm test
# z roota monorepo:
npm test -w @wa-os/ts-rpc
npm run gate   # pełny gate — [TESTING.md](../TESTING.md)
```

Pokrycie m.in.: golden compressed vs C++, flat skalarne, Person value/graph cross-lang (`serializationComplex.test.ts`), circular buffer, message channel (compressed + flat), RPC compressed + flat (`flatSocketRpc.test.ts`), kontrakt `IWriter`/`IReader`, flat LE smoke (`flatSerialization.test.ts`), observable (port `observable_ut.cpp` / `remote_observable_ut.cpp`).
