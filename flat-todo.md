# Flat format — TODO implementacji (ts-rpc)

Wire layout i semantyka: [cpp-rpc/flat-format.md](../cpp-rpc/flat-format.md) (jedyna specyfikacja formatu).

Cel: pełna zgodność bajtowa z C++ flat (serializacja → message channel → RPC), **zawsze materialized**. Brak `flat_view` / zero-copy w TS — w JS/TS nie ma sensu (brak taniego borrow z bufora WASM/heap bez materializacji obiektów).

Compressed pozostaje domyślny i bez zmian zachowania. Flat jest osobnym formatem (niekompatybilny bajtowo).

---

## Założenia (zamrożone)

- [x] Layout flat = C++ (`flat-format.md`): LE fixed, trailery ramek, i32 delta pointer, mapy SoA
- [x] Top-level message wire = C++ flat message:
  `[len 4B][type u32 LE][encoded_size_0][frame 0]…[0 sentinel][payload]`
- [x] TS zawsze materializuje wartości (`TypedValue` / plain objects) — **bez** `flat_view`
- [x] Zero-copy / `flat_view` / `flat_map_view` / random-access seek — **poza scope**
- [x] Ewolucja schematu — poza scope
- [x] Compressed i flat nie mieszają się na jednym sockecie

---

## Stan wyjściowy (compressed)

Obecny kod (do zachowania jako compressed path):

| Plik | Rola |
|------|------|
| `src/writer.ts` / `src/reader.ts` | ArrayBuffer writer/reader (varint) |
| `src/LocalCircularBufferWriter.ts` / `…Reader.ts` | circular poke/peek (varint) |
| `src/ModuleCircularBufferWriter.ts` / `…Reader.ts` | WASM module buffers (varint) |
| `src/valueSerialization.ts` | schema-driven serialize/deserialize; już woła `beginFrame`/`endFrame`/`saveOffset` (dziś no-op) |
| `src/SocketMessageChannel.ts` | `[len][type u64 varint][body][writeRest][payload]` |
| `src/SocketRpcServer.ts` / `SocketRpcClient.ts` | RPC na `SocketMessageChannel` |

Uwaga: mapy w `valueSerialization` idą przez `writeMap`/`readMap` (compressed = interleaved). Flat wymaga SoA w implementacji flat writer/reader.

---

## Pliki docelowe

- [x] `src/writerTypes.ts` — wspólny interfejs `IWriter` / `IReader` (kontrakt używany przez `valueSerialization`, codecs, channel)
- [ ] `src/flatEncoding.ts` — LE helpers, `offsetWidth` / `packFormat` / `unpackWidth`, trailer size
- [ ] `src/flatWriter.ts` — flat writer na rosnącym `Uint8Array` (odpowiednik `flat_stream_writer` / buffer writer)
- [ ] `src/flatReader.ts` — flat reader na `Uint8Array` / `ArrayBufferView` (materialized, skip trailera)
- [ ] `src/flatLocalCircularBufferWriter.ts` — flat poke writer na `LocalCircularBuffer`
- [ ] `src/flatLocalCircularBufferReader.ts` — flat peek reader na circular
- [ ] (opcjonalnie) `src/flatModuleCircularBufferWriter.ts` / `…Reader.ts` — jeśli Module* potrzebują flat pod WASM
- [ ] `src/flatMessageChannel.ts` — albo templatyzacja `SocketMessageChannel` policy flat
- [x] Eksporty `IWriter`/`IReader` w `src/index.ts` (Faza 0); flat eksporty — Faza 1+
- [x] Testy kontraktu: `tests/writerReaderContract.test.ts` (Faza 0)
- [ ] Testy flat: `tests/flatSerialization.test.ts`, `tests/flatMessageChannel.test.ts`, `tests/flatSocketRpc.test.ts`
- [x] `README.md` — architektura + kontrakt (Faza 0)
- [ ] Ten plik — odhaczać w trakcie

---

## Faza 0 — wspólny kontrakt (refactor przed flat) — **DONE**

Minimalny refactor, żeby compressed i flat współdzieliły `valueSerialization` bez `as any`.

- [x] Wyciągnąć `IWriter` / `IReader` z metod używanych dziś przez `valueSerialization` + codecs:
  - skalary: `writeU64`…`writeBool` / `readU64`…`readBool`
  - `writeString` / `writeBinary` / `writeLength` (+ read)
  - `beginFrame` / `endFrame` / `saveOffset`
  - `enterFrame` / `exitFrame` / `saveOffset` (reader)
  - `writePointer` / `writeRest` / `readPointer` / `readRest`
  - `writeTyped` / `readTyped`
  - **`writeMap` / `readMap`** (callbacki key/value)
- [x] `Writer` / `Reader` / `LocalCircularBuffer*` implementują interfejs; `beginFrame`/`endFrame`/`saveOffset` nadal no-op (compressed)
- [x] Compressed `writeMap`/`readMap` = interleaved layout (pary key+value w pętli)
- [x] `valueSerialization`: `Map` przez `writeMap`/`readMap`; `reader.saveOffset` po variable (mirror C++ `deserialize.hpp`)
- [x] Typy `Serializer`/`Deserializer` w `codec.ts` oparte o `IWriter`/`IReader`
- [x] Regresja: istniejące testy + `writerReaderContract.test.ts` (43 passing)
- [x] `README.md` utworzony

---

## Faza 1 — serializacja flat (ArrayBuffer)

Cel: roundtrip wartości flat TS↔TS i zgodność bajtowa z C++ (bez socketa).

### 1.1 Encoding helpers

- [ ] `flatEncoding.ts`: `storeLe` / `loadLe` (u8…u64, f32, f64)
- [ ] `offsetWidth(maxCp)` → 1/2/4; `packFormat` / `unpackWidth`
- [ ] (opcjonalnie) `isFlatVariable` / `flatFixedSize` — jeśli potrzebne do testów trailera

### 1.2 FlatWriter

- [ ] Fixed LE skalary (`writeU8`…`writeU64`, `writeI*`, `writeF32`/`F64` IEEE LE, `writeBool`)
- [ ] `writeString` / `writeBinary` / `writeLength` = u32 LE + bytes
- [ ] Frame: `beginFrame` / `saveOffset` / `endFrame` → trailer `[format][cps…][format]` gdy K>0; brak trailera gdy K==0
- [ ] `writePointer` — i32 LE delta (0 / &lt;0 / &gt;0), jak compressed semantyka
- [ ] `writeRest` — **per-frame prefix**: dla każdego pending `[encoded_size=N+1 u32 LE][frame N B]`; na końcu grafu **nie** dopisuje sentinel (sentinel jest warstwą message — patrz Faza 2); dla samego value roundtrip wystarczy body jak w C++ `write_rest` flat writer
- [ ] `writeTyped` / register — index **u32 LE**
- [ ] `writeException` / `writeMessage` — index u32 LE (jeśli używane poza channel)
- [ ] `writeMap` — SoA wg `flat-format.md` (sort kluczy po `memcmp` zserializowanych bajtów)
- [ ] `pokeU32(abs, val)` — potrzebne do back-patch `encoded_size` w `writeRest` / message header

### 1.3 FlatReader

- [ ] Fixed LE skalary + string/binary/length
- [ ] `enterFrame` / `exitFrame` — skip trailera (K z schematu / `checkpoint_count` jak C++ stream reader)
- [ ] `saveOffset` — inkrement licznika checkpointów w ramce
- [ ] `readPointer` / `readRest` — konsumuje per-frame `encoded_size` przed każdym deferred body (jak C++ flat `read_rest`)
- [ ] `readTyped` / exception / message — index u32 LE
- [ ] `readMap` — SoA (offs → keys → values → val_off trailer)
- [ ] `isIndexed()` = `false` dla prostego ArrayBuffer readera (brak seek; zawsze sequential materialize)

### 1.4 valueSerialization na flat

- [ ] Upewnić się, że `serializeValueByType` / `deserializeValueByType` działają z `FlatWriter`/`FlatReader` bez branchy formatu (tylko przez interfejs)
- [ ] Mapa: wyłącznie przez `writeMap`/`readMap` (SoA na flat, interleaved na compressed)
- [ ] UDT: `beginFrame` … pola … `endFrame` + `saveOffset` po UDT (już jest)
- [ ] Pointer: `writePointer` + `writeTyped` w later; bez `save_offset` na uchwycie

### 1.5 Testy serializacji

- [ ] Skalary + string/binary — bajty = C++ flat golden (lub roundtrip vs hex z `serialization_flat_ut`)
- [ ] UDT z trailerami (mixed fixed/variable)
- [ ] `vector` fixed vs variable (K=0 vs K>0)
- [ ] Mapa SoA (empty, string→int, nested UDT); kolejność = memcmp keys
- [ ] Graf `shared_ptr` (null, tree, cycle a↔b) + `writeRest`/`readRest`
- [ ] Typed / exception / message index u32
- [ ] Cross: opcjonalnie dump C++ → odczyt TS i odwrotnie (fixture pliki lub wspólne golden)

### 1.6 Circular flat (lokalny)

Potrzebne pod message channel (socket używa circular).

- [ ] `FlatLocalCircularBufferWriter` — `writeRaw` przez poke + grow; `currentPos` / `pokeU32`; reszta logiki jak `FlatWriter` (współdzielona baza / composition)
- [ ] `FlatLocalCircularBufferReader` — peek + cursor; skip trailera; `setReadOffset` / `getReadOffset`
- [ ] Unikać czwartej pełnej kopii: wspólny core flat + medium hooks (jak C++ `flat_writer_base` / `flat_reader_base`, w TS przez composition lub bazową klasę)
- [ ] Testy wrap / short space / roundtrip Person na circular

- [ ] (opcjonalnie) Module circular flat — tylko jeśli WASM path ma iść flatem; inaczej odłożyć

---

## Faza 2 — message channel flat

Cel: length-prefixed messages zgodne z C++ `flat_materialized_codec` + framing (bez zero-copy codec).

### 2.1 Framing / policy

- [ ] Wydzielić z `SocketMessageChannel` wspólne: length prefix, flush, drain, dispatch table, `onMessage`, payload size
- [ ] Policy **compressed** (obecne zachowanie):
  - send: `writeU64(typeIndex)` + serialize + `writeRest`
  - recv: `readU64()` + deserialize + `readRest`; `payloadSize = msgLen - offset`
- [ ] Policy **flat**:
  - send: `writeU32(typeIndex)` + placeholder `encoded_size_0` + serialize root + `writeRest` (sub-frames z prefixami) + `writeU32(0)` sentinel; back-patch `encoded_size_0`; potem length + flush
  - recv: `readU32(typeIndex)` + `readU32(encoded_size_0)` + deserialize root + `readRest` + `readU32(sentinel==0)`; `payloadSize = msgLen - offset`
- [ ] Alias / API:
  - `SocketMessageChannel` = compressed (backward compatible), **albo** factory `createSocketMessageChannel(socket, codecs, 'compressed'|'flat')`
  - `FlatSocketMessageChannel` jeśli osobna klasa czytelniejsza

### 2.2 Root / shared graph na message

Zgodnie z C++ flat message:

- [ ] Root nie jest `writePointer` — serialize body + mark root w `writtenPointers` gdy root to shared graph (jeśli TS modeluje pointer root); dla zwykłych message objects (RPC structs) — plain serialize w frame 0
- [ ] Sub-frames tylko z `writeRest` (homogeniczny typed graph)
- [ ] Payload surowy po sentinel — handler dostaje `payloadSize`; odczyt payloadu przez reader channela

### 2.3 Testy message

- [ ] Ping/Pong roundtrip flat (LocalSocket loopback)
- [ ] Payload dołączony do wiadomości
- [ ] Wiele typów w dispatch table (kolejność indexów = rejestracja)
- [ ] Graf w body wiadomości (jeśli typ ma pointery)
- [ ] Zgodność z C++: TS flat channel ↔ C++ `socket_message_framing<flat_materialized_codec>` (opcjonalnie natywny helper / golden frame)

---

## Faza 3 — RPC flat

Cel: `SocketRpcServer` / `SocketRpcClient` na flat message channel. Control messages zawsze materialized (i tak jedyny model w TS).

### 3.1 Wiring

- [ ] `SocketRpcServer` / `SocketRpcClient`: przyjąć format lub gotowy channel (`'compressed' | 'flat'`)
- [ ] `ensureRpcCodecs` / rejestracja `rpc_request` / `rpc_response` / `rpc_error` bez zmian semantyki
- [ ] Exception types — serialize/deserialize przez `valueSerialization` na flat writer/reader
- [ ] Domyślnie compressed (istniejący kod); flat opt-in

### 3.2 Testy RPC

- [ ] call int / string / void / error / typed exception
- [ ] sequential calls, large string
- [ ] user `onMessage` obok RPC na tym samym flat channel
- [ ] Cross-language: TS flat RPC ↔ C++ `socket_rpc_server<flat_materialized_codec>` / client (loopback lub fixture)

---

## Poza scope (świadomie)

- [ ] `flat_view` / zero-copy field access w TS
- [ ] `flat_map_view` / binary search bez materializacji
- [ ] `flat_zero_copy_codec` odpowiednik (handler dostaje view zamiast obiektu)
- [ ] Random-access `enterIndexedFrame` / seek po checkpointach w TS readerze
- [ ] Ewolucja schematu / field id
- [ ] Automatyczna migracja istniejących serwisów na flat (opt-in per socket)

---

## Kolejność wdrożenia (checklist wykonawcza)

1. [x] Faza 0 — `IWriter`/`IReader` + `writeMap`/`readMap` compressed + regresja + README
2. [ ] Faza 1.1–1.3 — `flatEncoding` + `FlatWriter`/`FlatReader`
3. [ ] Faza 1.4–1.5 — valueSerialization + testy serializacji
4. [ ] Faza 1.6 — circular flat local
5. [ ] Faza 2 — flat message channel + testy
6. [ ] Faza 3 — flat RPC + testy (+ cross C++ jeśli infrastruktura gotowa)
7. [ ] Eksporty flat w `index.ts` (kontrakt IWriter już wyeksportowany w Fazie 0)

---

## Kryteria „done”

- [ ] Wszystkie checkboxy Faz 0–3 odhaczone (poza opcjonalnymi Module* i cross-C++ jeśli brak harnessu)
- [ ] Istniejące testy compressed zielone bez regresji
- [ ] Nowe testy flat: serializacja + message + RPC zielone
- [ ] Dokumentacja: ten plik aktualny; wire = `cpp-rpc/flat-format.md`
