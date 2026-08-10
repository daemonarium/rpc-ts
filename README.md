# ts-rpc

Biblioteka TypeScript łącząca:

1. **serializację / deserializację** wartości według `TypeRegistry` (codecs + `valueSerialization`),
2. **RPC** i kanał wiadomości na sockecie (TS ↔ WASM / C++ `cpp-rpc`).

Warstwa typów (`serializeValueByType` / `deserializeValueByType`) nie zna formatu ani medium — woła wspólny kontrakt **`IWriter` / `IReader`**. Konkretny backend (compressed / flat) implementuje ten kontrakt.

---

## Formaty binarne

| | Compressed | Flat |
|--|------------|------|
| Status | zaimplementowany (domyślny) | serializacja + message channel + RPC — [flat-todo.md](flat-todo.md) |
| Liczby | varint / sortowalny float | fixed LE (jak C++) |
| Mapy | interleaved (`length` + pary) | SoA |
| Ramki | `beginFrame` / `endFrame` / `saveOffset` = no-op | trailery checkpointów |
| Odczyt | zawsze materialized | zawsze materialized (brak `flat_view` w TS) |

Specyfikacja wire flat: [../cpp-rpc/flat-format.md](../cpp-rpc/flat-format.md). Compressed i flat **nie są** kompatybilne bajtowo — nie mieszać na jednym sockecie.

Blob `TypeRegistry` / `rpc_description`: `[envelope u8][compressed body]` — `TypeRegistry.dataFormat` / `SerializationFormat` (`Compressed` | `Flat` | `Key`). Body registry zawsze compressed. Spec: [../cpp-rpc/type-registry-blob.md](../cpp-rpc/type-registry-blob.md).

---

## Goldeny vs cpp-rpc

Checked-in TSV (źródło prawdy = C++ generators w `build/tests/`):

| Plik | Zawartość |
|------|-----------|
| [`tests/serialization_reference.tsv`](tests/serialization_reference.tsv) | skalarne compressed |
| [`tests/serialization_flat_reference.tsv`](tests/serialization_flat_reference.tsv) | skalarne flat LE |
| [`tests/serialization_complex_reference.tsv`](tests/serialization_complex_reference.tsv) | Person value/graph compressed+flat |

Regeneracja (wymaga reflection clang build, katalog `build/`):

```bash
cmake --build build --target generate_serialization_tsv generate_serialization_complex_tsv
./build/tests/generate_serialization_tsv ts-rpc/tests/serialization_reference.tsv
./build/tests/generate_serialization_tsv --flat ts-rpc/tests/serialization_flat_reference.tsv
./build/tests/generate_serialization_complex_tsv ts-rpc/tests/serialization_complex_reference.tsv
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
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
   Writer / Reader   LocalCircularBuffer*   FlatWriter / FlatReader /
   (ArrayBuffer)     (socket buffers)       FlatLocalCircularBuffer*
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

`ModuleCircularBufferWriter` / `Reader` to niskopoziomowe poke/peek (nie pełny kontrakt) — używane do surowego I/O, nie przez `valueSerialization`.

---

## Message / RPC

- [`SocketMessageChannel`](src/SocketMessageChannel.ts) — compressed: `[len 4B LE][type u64 varint][body][writeRest][payload]`
- [`FlatSocketMessageChannel`](src/FlatSocketMessageChannel.ts) — flat: `[len][type u32 LE][encoded_size_0][root][writeRest…][sentinel 0][payload]` (wspólne framing: [`socketMessageFraming.ts`](src/socketMessageFraming.ts))
- [`SocketRpcServer`](src/SocketRpcServer.ts) / [`SocketRpcClient`](src/SocketRpcClient.ts) — domyślnie compressed; flat opt-in: `new SocketRpcServer(socket, registry, codecs, { format: 'flat' })` (to samo dla client)

---

## Testy

```bash
cd ts-rpc && npm test
```

Pokrycie m.in.: golden compressed vs C++, flat skalarne, Person value/graph cross-lang (`serializationComplex.test.ts`), circular buffer, message channel (compressed + flat), RPC compressed + flat (`flatSocketRpc.test.ts`), kontrakt `IWriter`/`IReader`, flat LE smoke (`flatSerialization.test.ts`).
