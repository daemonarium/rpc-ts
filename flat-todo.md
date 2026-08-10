# Flat format — TODO implementacji (ts-rpc)

Wire layout i semantyka: [cpp-rpc/flat-format.md](../cpp-rpc/flat-format.md) (jedyna specyfikacja formatu).

Cel: pełna zgodność bajtowa z C++ flat (serializacja → message channel → RPC), **zawsze materialized**. Brak `flat_view` / zero-copy w TS — w JS/TS nie ma sensu (brak taniego borrow z bufora WASM/heap bez materializacji obiektów).

Compressed pozostaje dostępny jako opt-in (`{ format: 'compressed' }`). Flat jest **domyślnym** formatem SocketRpc / TypeRegistry.dataFormat.

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

## Compressed path (zachowany)

Historyczna ścieżka compressed (nadal w repo jako opt-in `{ format: 'compressed' }`):

| Plik | Rola |
|------|------|
| `src/writer.ts` / `src/reader.ts` | ArrayBuffer writer/reader (varint) |
| `src/LocalCircularBufferWriter.ts` / `…Reader.ts` | circular poke/peek (varint) |
| `src/ModuleCircularBufferWriter.ts` / `…Reader.ts` | WASM module buffers (varint) |
| `src/valueSerialization.ts` | schema-driven serialize/deserialize; `beginFrame`/`endFrame`/`saveOffset` (no-op na compressed) |
| `src/SocketMessageChannel.ts` | compressed framing: `[len][type u64 varint][body][writeRest][payload]` |
| `src/SocketRpcServer.ts` / `SocketRpcClient.ts` | domyślnie flat; compressed przez `SocketMessageChannel` |

Mapy: compressed = interleaved; flat = SoA (`flat-format.md`). Cutover procesów / default flat: [TESTING.md](../TESTING.md).

---

## Pliki docelowe

- [x] `src/writerTypes.ts` — wspólny interfejs `IWriter` / `IReader` (kontrakt używany przez `valueSerialization`, codecs, channel)
- [x] `src/flatEncoding.ts` — LE helpers, `offsetWidth` / `packFormat` / `unpackWidth`, trailer size
- [x] `src/flatWriter.ts` / `flatWriterBase.ts` — flat writer na rosnącym `Uint8Array`
- [x] `src/flatReader.ts` / `flatReaderBase.ts` — flat reader na `Uint8Array` / `ArrayBufferView` (materialized, skip trailera)
- [x] `src/flatLocalCircularBufferWriter.ts` — flat poke writer na `LocalCircularBuffer`
- [x] `src/flatLocalCircularBufferReader.ts` — flat peek reader na circular
- [ ] (opcjonalnie) `src/flatModuleCircularBufferWriter.ts` / `…Reader.ts` — jeśli Module* potrzebują flat pod WASM
- [x] `src/FlatSocketMessageChannel.ts` — framing + flat body policy (`socketMessageFraming.ts`)
- [x] Eksporty `IWriter`/`IReader` + flat + `FlatSocketMessageChannel` + `RpcWireFormat` w `src/index.ts`
- [x] Testy kontraktu: `tests/writerReaderContract.test.ts` (Faza 0)
- [x] Testy flat: `flatSerialization.test.ts` (1), `flatMessageChannel.test.ts` (2), `flatSocketRpc.test.ts` (3)
- [x] `README.md` — architektura + kontrakt + status flat (serializacja / channel / RPC)
- [x] Ten plik — checklist cutoveru zamknięta (opcjonalne Module circular flat nadal otwarte)

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

## Faza 1 — serializacja flat (ArrayBuffer) — **DONE**

Cel: roundtrip wartości flat TS↔TS i zgodność bajtowa z C++ (bez socketa).

### 1.1 Encoding helpers

- [x] `flatEncoding.ts`: `storeLe` / `loadLe` (u8…u64, f32, f64)
- [x] `offsetWidth(maxCp)` → 1/2/4; `packFormat` / `unpackWidth`
- [x] (opcjonalnie) `isFlatVariable` / `flatFixedSize` — niepotrzebne (schema w TypeRegistry / valueSerialization)

### 1.2 FlatWriter

- [x] Fixed LE skalary (`writeU8`…`writeU64`, `writeI*`, `writeF32`/`F64` IEEE LE, `writeBool`)
- [x] `writeString` / `writeBinary` / `writeLength` = u32 LE + bytes
- [x] Frame: `beginFrame` / `saveOffset` / `endFrame` → trailer `[format][cps…][format]` gdy K>0; brak trailera gdy K==0
- [x] `writePointer` — i32 LE delta (0 / &lt;0 / &gt;0), jak compressed semantyka
- [x] `writeRest` — **per-frame prefix**: dla każdego pending `[encoded_size=N+1 u32 LE][frame N B]`; na końcu grafu **nie** dopisuje sentinel (sentinel jest warstwą message — patrz Faza 2)
- [x] `writeTyped` / register — index **u32 LE**
- [x] `writeException` — index u32 LE (+ exception codec)
- [x] `writeMap` — SoA wg `flat-format.md` (sort kluczy po `memcmp` zserializowanych bajtów)
- [x] `pokeU32(abs, val)` — back-patch `encoded_size` w `writeRest`

### 1.3 FlatReader

- [x] Fixed LE skalary + string/binary/length
- [x] `enterFrame` / `exitFrame` — skip trailera (`checkpoint_count` jak C++ stream reader)
- [x] `saveOffset` — inkrement licznika checkpointów w ramce
- [x] `readPointer` / `readRest` — konsumuje per-frame `encoded_size` przed każdym deferred body
- [x] `readTyped` — index u32 LE
- [x] `readMap` — SoA (offs → keys → values → val_off trailer)
- [x] `isIndexed()` = `false` dla ArrayBuffer / circular stream readera

### 1.4 valueSerialization na flat

- [x] `serializeValueByType` / `deserializeValueByType` działają z `FlatWriter`/`FlatReader` bez branchy formatu
- [x] Mapa: wyłącznie przez `writeMap`/`readMap` (SoA na flat, interleaved na compressed)
- [x] UDT: `beginFrame` … pola … `endFrame` + `saveOffset` po UDT
- [x] Pointer: deferred body — compressed `writeTyped`; flat `serializeValueByType` bez type index (`deferredPointerUsesTypeIndex`)

### 1.5 Testy serializacji

- [x] Skalary + string/binary — golden LE hex + roundtrip
- [x] UDT z trailerami (mixed fixed/variable)
- [x] `vector` fixed vs variable (K=0 vs K>0)
- [x] Mapa SoA (empty, string→int); kolejność = memcmp keys
- [x] Graf pointer (null, cycle a↔b) + `writeRest`/`readRest`
- [x] Typed index u32 LE
- [x] Cross medium: ArrayBuffer ↔ circular parity
- [x] Cross-dump C++↔TS: skalarne flat TSV + Person value/graph compressed+flat (`serialization_complex_reference.tsv`, `person_fixture.hpp`)

### 1.6 Circular flat (lokalny)

- [x] `FlatLocalCircularBufferWriter` — poke + grow; wspólna baza `FlatWriterBase`
- [x] `FlatLocalCircularBufferReader` — peek + cursor; `setReadOffset` / `getReadOffset`
- [x] Wspólny core: `FlatWriterBase` / `FlatReaderBase` + sink/source hooks
- [x] Testy grow / roundtrip Person+map na circular + parity z ArrayBuffer

- [ ] (opcjonalnie) Module circular flat — tylko jeśli WASM path ma iść flatem; inaczej odłożyć

---

## Faza 2 — message channel flat — **DONE**

Cel: length-prefixed messages zgodne z C++ `flat_materialized_codec` + framing (bez zero-copy codec).

### 2.1 Framing / policy

- [x] Wydzielić z `SocketMessageChannel` wspólne: length prefix, flush, drain, dispatch table, `onMessage`, payload size (`socketMessageFraming.ts`)
- [x] Policy **compressed** (obecne zachowanie):
  - send: `writeU64(typeIndex)` + serialize + `writeRest`
  - recv: `readU64()` + deserialize + `readRest`; `payloadSize = msgLen - offset`
- [x] Policy **flat**:
  - send: `writeU32(typeIndex)` + placeholder `encoded_size_0` + serialize root + `writeRest` (sub-frames z prefixami) + `writeU32(0)` sentinel; back-patch `encoded_size_0`; potem length + flush
  - recv: `readU32(typeIndex)` + `readU32(encoded_size_0)` + deserialize root + `readRest` + `readU32(sentinel==0)`; `payloadSize = msgLen - offset`
- [x] Alias / API:
  - `SocketMessageChannel` = compressed (backward compatible)
  - `FlatSocketMessageChannel` — osobna klasa

### 2.2 Root / shared graph na message

Zgodnie z C++ flat message:

- [x] Root nie jest `writePointer` — plain serialize w frame 0 (RPC/message structs)
- [x] Sub-frames tylko z `writeRest` (homogeniczny typed graph; flat pointer bez type index)
- [x] Payload surowy po sentinel — handler dostaje `payloadSize`; odczyt payloadu przez reader channela

### 2.3 Testy message

- [x] Ping/Pong roundtrip flat (LocalSocket loopback)
- [x] Payload dołączony do wiadomości
- [x] Wiele typów w dispatch table (kolejność indexów = rejestracja)
- [x] Graf w body wiadomości (vector pointer + cycle)
- [x] Layout golden (typeIndex / encoded_size_0 / sentinel); opcjonalny TSV z C++ generatora — odłożony

---

## Faza 3 — RPC flat — **DONE**

Cel: `SocketRpcServer` / `SocketRpcClient` na flat message channel. Control messages zawsze materialized (i tak jedyny model w TS).

### 3.1 Wiring

- [x] `SocketRpcServer` / `SocketRpcClient`: opcjonalne `{ format?: 'compressed' | 'flat' }`
- [x] `ensureRpcCodecs` / rejestracja `rpc_request` / `rpc_response` / `rpc_error` bez zmian semantyki
- [x] Exception types — `writeException` / `readException` (flat: u32 LE index) + `valueSerialization`
- [x] Domyślnie flat; compressed opt-in `{ format: 'compressed' }`

### 3.2 Testy RPC

- [x] call int / string / void / error / typed exception (`tests/flatSocketRpc.test.ts`)
- [x] sequential calls, large string
- [x] user `onMessage` obok RPC na tym samym flat channel
- [ ] Cross-language: TS flat RPC ↔ C++ (poza zakresem tej fazy — brak żywego harnessu)

---

## Poza scope (świadomie)

- [ ] `flat_view` / zero-copy field access w TS
- [ ] `flat_map_view` / binary search bez materializacji
- [ ] `flat_zero_copy_codec` odpowiednik (handler dostaje view zamiast obiektu)
- [ ] Random-access `enterIndexedFrame` / seek po checkpointach w TS readerze
- [ ] Ewolucja schematu / field id
- [x] Automatyczna migracja istniejących serwisów na flat (default flat w ts-rpc; procesy C++ na `flat_socket_rpc_*`; compressed via `WAOS_MODULE_RPC_COMPRESSED` / `{ format: 'compressed' }`)

---

## Kolejność wdrożenia (checklist wykonawcza)

1. [x] Faza 0 — `IWriter`/`IReader` + `writeMap`/`readMap` compressed + regresja + README
2. [x] Faza 1.1–1.3 — `flatEncoding` + `FlatWriter`/`FlatReader`
3. [x] Faza 1.4–1.5 — valueSerialization + testy serializacji
4. [x] Faza 1.6 — circular flat local
5. [x] Faza 2 — flat message channel + testy
6. [x] Faza 3 — flat RPC + testy TS↔TS (cross C++ live poza zakresem)
7. [x] Eksporty flat w `index.ts` (kontrakt IWriter, channel, `RpcWireFormat`)

---

## Kryteria „done”

- [x] Checkboxy Faz 0–3 odhaczone (poza opcjonalnymi Module* i cross-C++ live)
- [x] Istniejące testy compressed zielone bez regresji
- [x] Nowe testy flat: serializacja + message + RPC zielone
- [x] Dokumentacja: ten plik aktualny; wire = `cpp-rpc/flat-format.md`
- [x] Format danych w blobie type_registry (`SerializationFormat` / envelope) — [type-registry-blob.md](../cpp-rpc/type-registry-blob.md)
