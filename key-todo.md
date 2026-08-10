# Key format — TODO (ts-rpc)

Szczegóły wire: [../cpp-rpc/key-format.md](../cpp-rpc/key-format.md). C++ checklist: [../cpp-rpc/key-todo.md](../cpp-rpc/key-todo.md).

## Zamrożony layout

- [x] `[data][meta][u8 meta_size]` (max 255 B meta, else throw)
- [x] Skalary w data = encoding compressed (`compressedEncoding.ts`)
- [x] Lengths / string lens w meta (uvarint32)
- [x] Throw: map, pointer, typed
- [x] Array / UDT / string / binary / enum via `valueSerialization`

## Pliki

- [x] `src/compressedEncoding.ts` (shared with Writer/Reader)
- [x] `src/keyWriter.ts` / `src/keyReader.ts`
- [x] `src/keyLocalCircularBufferWriter.ts` / `src/keyLocalCircularBufferReader.ts`
- [x] `tests/keySerialization.test.ts`
- [x] `tests/keyCircular.test.ts`
- [x] Eksporty w `src/index.ts` + README

## Poza zakresem

- [ ] Message channel / RPC `format: 'key'`
- [ ] Lex string / tuple escape
- [ ] Debugger decode key blobów na strumieniu RPC
