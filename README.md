# rpc

TypeScript serialization and RPC over a socket message channel. The wire format matches [daemonarium/rpc-cpp](https://github.com/daemonarium/rpc-cpp). Three binary formats share one `IWriter` / `IReader` contract: flat (default), compressed (legacy), and key (database keys). An observable stream multiplexer carries live and scan streams.

The npm package is `@daemonarium/rpc`. This repository is `daemonarium/rpc-ts`.

## Install

```
npm i @daemonarium/rpc
```

Wasm modules built with `daemonarium/rpc-cpp` speak the same bytes.

## One import

```ts
import {
  SocketRpcServer,
  SocketRpcClient,
  TypeRegistry,
  FlatWriter,
  FlatReader,
} from '@daemonarium/rpc'
```

## Codegen

`rpc-codegen` reads a wasm module's `rpc_description` and emits a typed client.

```
npx rpc-codegen module.wasm -l "TS Client" -s 0
```

Languages: `C++ Types`, `C++ Client`, `C++ Server`, `TS Type Registry`, `TS Server`, `TS Client`.

## Formats

The byte layouts live with the C++ library:

- [Flat](https://github.com/daemonarium/rpc-cpp/blob/main/docs/flat-format.md)
- [Compressed](https://github.com/daemonarium/rpc-cpp/blob/main/docs/compressed-format.md)
- [Key](https://github.com/daemonarium/rpc-cpp/blob/main/docs/key-format.md)
- [Type registry blob](https://github.com/daemonarium/rpc-cpp/blob/main/docs/type-registry-blob.md)

Flat, compressed, and key are not byte-compatible. Do not mix them on one socket.

## Observable

`RemoteReference.observable()` is a live stream. `stream(since)` reuses the live stream when one is already active, otherwise it scans from `since`. `fetch(since)` always starts a new scan. A full channel returns `false` from `tryQueueMessage` and resumes on `onWritable`. The map of writers, readers, and the multiplexer is in [docs/architecture.md](docs/architecture.md).

## Build and test

```
npm install
npm run build
npm test
```

## License

MIT. The only runtime dependency is `yargs`.
