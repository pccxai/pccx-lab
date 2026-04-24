# Changelog

All notable changes to `pccx-lsp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

SEMVER NOTE: pccx-lab is pre-1.0.  Every minor bump (`0.x.y` -> `0.{x+1}.0`)
may carry breaking public-API changes.

## [Unreleased]

### Added

- `LspMultiplexer` — per-`Language` registry of
  `(CompletionProvider, HoverProvider, LocationProvider)` trait-object
  triples.  Forwards queries to the registered triple; returns
  `LspError::NoBackend` for unregistered languages.  Partial /
  per-provider registration can be added later without breaking this
  API.  (Phase 2 M2.1, A-slice.)
- `NoopBackend` — reference backend implementing all three provider
  traits with empty-data answers.  Used by unit tests and as a safe
  default in pccx-ide before real backends register.
- Unit tests covering empty-init, unregistered-language rejection,
  full dispatch-through-noop, and register-replaces-existing
  semantics.

### Notes

- `tower-lsp` / `lsp-types` are **not** added as dependencies in this
  slice.  `tower_lsp::LanguageServer` is fully async while the
  `CompletionProvider` / `HoverProvider` / `LocationProvider` surface
  is sync; the tower-lsp adapter + sync-to-async bridge land together
  during Phase 2 proper (Weeks 6-9) so the scaffold stays free of
  runtime dependencies it does not yet exercise.

### Added (B-slice)

- Async provider trait companions: `AsyncCompletionProvider`,
  `AsyncHoverProvider`, `AsyncLocationProvider` — all object-safe via
  `#[async_trait]`.  Phase 2 M2.1 B-slice.
- `BlockingBridge<P>` — lifts any sync provider `P` into all the
  async traits it has a sync counterpart for, via
  `tokio::task::spawn_blocking`.  Lets in-process providers
  (`NoopBackend`, a future AST-hash cache) coexist with real LSP
  subprocesses inside a tokio-scheduled pipeline.
- `SpawnConfig` — declarative spec for launching an LSP server
  (program, args, working_dir, env) with a fluent builder API.
- `LspSubprocess` — owns a `tokio::process::Child` with piped stdio
  and `kill_on_drop(true)`.  `spawn` / `kill` / `wait` / `id` /
  `config` are the public lifecycle surface.  JSON-RPC pumping over
  stdio is intentionally deferred to the first concrete backend
  slice (verible) so spawn semantics can stabilise first.
- Workspace dependencies: `tokio` (with `process` / `io-util` /
  `rt-multi-thread` / `macros` / `time` features) and `async-trait`
  added to `[workspace.dependencies]`; `pccx-lsp` inherits both.
- Seven new tests: `SpawnConfig` fluent-builder semantics, trivial
  spawn/wait over `true`, kill-terminates `sleep 30`, and
  `BlockingBridge` delegates completion / hover / location correctly
  through `NoopBackend`.

### Added (C-slice proper — JSON-RPC wire framing)

- `encode_frame(body)` / `decode_frame(buf)` — pure byte-layer LSP
  JSON-RPC framing (HTTP-style `Content-Length: N\r\n\r\n<body>`
  envelope per the LSP spec).  No `tokio-util` / `framing` dep
  taken; incremental decode returns `(body, consumed)` so the caller
  drives its own read buffer.
- `FrameError` — `HeaderNotUtf8`, `MissingContentLength`,
  `BadContentLength(String)`, `ContentLengthTooLarge`.  Distinct from
  `LspError` because framing errors are recoverable at the transport
  level.
- `MAX_FRAME_BODY_BYTES` (64 MiB) hard cap against adversarial
  servers that claim huge `Content-Length`.
- 10 new tests: header shape, UTF-8 multi-byte body round-trip,
  partial-header / partial-body / two-frame-in-one-buffer slicing,
  missing / bad / oversized `Content-Length`, case-insensitive
  header keys, `Content-Type` coexistence.

### Added (C-slice fragment)

- `AsyncLspMultiplexer` — async counterpart to `LspMultiplexer`.
  Stores one `(AsyncCompletionProvider, AsyncHoverProvider,
  AsyncLocationProvider)` trait-object triple per `Language` and
  forwards async queries; unregistered languages return
  `LspError::NoBackend`.  Shape mirrors the sync multiplexer so
  callers migrating from sync to async rewrite only `.await` call
  sites.  Phase 2 M2.1 C-slice fragment.
- Four new tests: empty-init, unregistered-language rejection,
  dispatch through `BlockingBridge<NoopBackend>` triples for all
  four query kinds, and register-replaces-existing via a tagged
  local `AsyncCompletionProvider` impl.

### Added (D-slice — async framed IO)

- `write_frame(w, body)` — generic over `tokio::io::AsyncWrite +
  Unpin`.  Encodes the frame and flushes.
- `read_frame(r, buf)` — generic over `tokio::io::AsyncRead + Unpin`.
  Reads one complete frame, returning `Ok(None)` on clean EOF and
  `io::Error(UnexpectedEof)` on EOF mid-frame.  The caller-owned
  read buffer is drained incrementally so two back-to-back frames
  coming in one kernel read are decoded correctly across successive
  calls.
- Malformed-frame errors (`FrameError::*`) surface as `io::Error`
  with `ErrorKind::InvalidData` and the original `FrameError` in the
  source chain, matching idiomatic tokio patterns.
- Five new tokio tests covering `write_frame` + `read_frame`
  round-trip over `tokio::io::duplex`, clean-EOF -> `None`,
  mid-frame EOF -> `UnexpectedEof`, malformed-header ->
  `InvalidData`, and back-to-back frames preserved across reads.

### Deferred (to next slice)

- Typed `lsp-types` envelope over the framing layer (typed
  `Request<Params>` / `Response<R>` / `Notification<N>` +
  request/response correlation keyed by message id).
- An `LspChannel` that takes ownership of `LspSubprocess` stdio and
  drives a pump task (read loop + write channel) on top of
  `read_frame` / `write_frame`.
- Concrete verible backend and the M2.1 smoke test ("type `GEMM_` in
  a .sv file, receive verible completions").
- `tower-lsp` adapter for serving the stack to Monaco.

## [0.1.0] - 2026-04-24

### Added

- Initial release as part of the pccx-lab workspace.
- Phase 2 Language Server Protocol façade scaffold.
- `CompletionProvider`, `HoverProvider`, `LocationProvider` traits.
- `Language` enum covering SV / Rust / C / C++ / Python / Sail / MyST / RST.
- `SourcePos` / `SourceRange` / `Completion` / `Hover` types that line
  up with `lsp-types` so the tower-lsp adapter can cast directly.
- `CompletionSource` enum distinguishing Lsp / AiFast / AiDeep / Cache
  so pccx-ide can badge completions by provenance.
