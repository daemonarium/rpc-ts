# ts-rpc

Biblioteka TypeScript łącząca:

1. **serializację / deserializację** wartości według `TypeRegistry` (codecs + `valueSerialization`),
2. **RPC** i kanał wiadomości na sockecie (TS ↔ WASM / C++ `cpp-rpc`).

Warstwa typów (`serializeValueByType` / `deserializeValueByType`) nie zna formatu ani medium — woła wspólny kontrakt **`IWriter` / `IReader`**. Konkretny backend (compressed / flat) implementuje ten kontrakt.

---

## Formaty binarne

| | Compressed | Flat |
|--|------------|------|
| Status | zaimplementowany (domyślny) | serializacja zaimplementowana (ArrayBuffer + circular); message/RPC — Fazy 2–3 — [flat-todo.md](flat-todo.md) |
| Liczby | varint / sortowalny float | fixed LE (jak C++) |
| Mapy | interleaved (`length` + pary) | SoA |
| Ramki | `beginFrame` / `endFrame` / `saveOffset` = no-op | trailery checkpointów |
| Odczyt | zawsze materialized | zawsze materialized (brak `flat_view` w TS) |

Specyfikacja wire flat: [../cpp-rpc/flat-format.md](../cpp-rpc/flat-format.md). Compressed i flat **nie są** kompatybilne bajtowo — nie mieszać na jednym sockecie.

---

## Architektura

```
┌─────────────────────────────────────────────────────────┐
│  SocketRpcServer / SocketRpcClient / SocketMessageChannel│
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

- [`SocketMessageChannel`](src/SocketMessageChannel.ts) — length-prefixed frames: `[len 4B LE][type u64 varint][body][writeRest][payload]` (compressed)
- [`SocketRpcServer`](src/SocketRpcServer.ts) / [`SocketRpcClient`](src/SocketRpcClient.ts) — RPC na tym kanale; typy `rpc_request` / `rpc_response` / `rpc_error`

Flat message/RPC: Fazy 2–3 w [flat-todo.md](flat-todo.md).

---

## Testy

```bash
cd ts-rpc && npm test
```

Pokrycie m.in.: golden compressed vs C++, circular buffer, message channel, RPC, kontrakt `IWriter`/`IReader` (`writerReaderContract.test.ts`), flat LE / SoA / pointer (`flatSerialization.test.ts`).
