// Module Boundary: lsp/
// pccx-lsp: Phase 2 IntelliSense façade.
//
// Evolves in slices.  Landed so far:
//   A-slice — sync provider traits (CompletionProvider, HoverProvider,
//     LocationProvider), `LspMultiplexer`, `NoopBackend`.
//   B-slice — async trait companions, `BlockingBridge` (sync -> async
//     adapter via spawn_blocking), `SpawnConfig` + `LspSubprocess`
//     (process lifecycle only, no JSON-RPC yet).
//   C-slice fragment — `AsyncLspMultiplexer`.
//   C-slice proper — JSON-RPC wire framing (`encode_frame` /
//     `decode_frame` over `Content-Length: N\r\n\r\n<body>`) with
//     a `FrameError` taxonomy.  Pure byte layer.
//   D-slice — async framed IO (`write_frame` / `read_frame`) over
//     any `tokio::io::AsyncWrite` / `AsyncRead`.  This is the seam
//     that connects the codec to `LspSubprocess` stdio (or to an
//     in-memory `tokio::io::duplex` pair for tests).  The typed
//     `lsp-types` envelope + request/response correlation land in
//     the next slice.
//   M2.2 — `SvKeywordProvider` (IEEE 1800-2017 keyword completion)
//     and `SvHoverProvider` stub for SystemVerilog, wired through to
//     a `sv_completions` Tauri command for Monaco.
// What remains for Phase 2 proper: typed `lsp-types` envelope +
// request/response correlation, a concrete verible backend, and the
// tower-lsp adapter that serves the stack to Monaco.

pub mod isa_provider;
pub mod monaco_bridge;
pub mod sv_diagnostics;
pub mod sv_hover;
pub mod sv_provider;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::{Child, Command};

pub const LSP_FAÇADE_API_VERSION: u32 = 1;

/// File coordinate — matches the LSP `Position` shape so it translates
/// directly to `lsp-types::Position` when the tower-lsp adapter lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SourcePos {
    pub line: u32,
    pub character: u32,
}

/// A source range: two coordinates.  Again: LSP-shape-compatible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SourceRange {
    pub start: SourcePos,
    pub end: SourcePos,
}

/// Languages the Phase 2 multiplexer dispatches over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Language {
    SystemVerilog,   // verible
    Rust,            // rust-analyzer
    C,               // clangd
    Cpp,             // clangd
    Python,          // pylsp
    Sail,            // no LSP upstream; pccx-lsp provides basic syntax
    MyStMarkdown,    // prosemirror via tree-sitter-markdown
    RstDoc,          // esbonio
}

impl Language {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_ascii_lowercase().as_str() {
            "sv" | "svh" => Some(Self::SystemVerilog),
            "rs" => Some(Self::Rust),
            "c" | "h" => Some(Self::C),
            "cpp" | "cxx" | "hpp" | "hxx" => Some(Self::Cpp),
            "py" => Some(Self::Python),
            "sail" => Some(Self::Sail),
            "md" => Some(Self::MyStMarkdown),
            "rst" => Some(Self::RstDoc),
            _ => None,
        }
    }
}

/// Completion item.  Subset of `lsp-types::CompletionItem` — just the
/// fields pccx-ide renders in its dropdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Completion {
    pub label: String,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub insert_text: String,
    pub source: CompletionSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompletionSource {
    /// Came from an upstream language server (verible etc.).
    Lsp,
    /// Came from a fast cloud LLM predictor.
    AiFast,
    /// Came from a deep cloud LLM predictor (higher latency).
    AiDeep,
    /// Cached hit (keyed by AST hash).
    Cache,
}

/// Hover card — what pccx-ide renders when the user hovers a symbol.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hover {
    pub contents: String,
    pub range: Option<SourceRange>,
}

/// LSP diagnostic severity levels (values match LSP spec 1..=4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DiagnosticSeverity {
    Error = 1,
    Warning = 2,
    Information = 3,
    Hint = 4,
}

/// A single diagnostic message attached to a source range.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub range: SourceRange,
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub source: Option<String>,
}

// ─── Unstable plugin API (Phase 2 M2.1) ──────────────────────────────
//
// Backends land behind three trait objects so the IntelliSense pipeline
// can swap providers per-language per-query without a rebuild.

/// Returns completion candidates at a source position.  The real
/// implementations either (a) wrap an external LSP, (b) query the cloud LLM,
/// or (c) hit an AST-hash cache.
pub trait CompletionProvider {
    fn complete(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<Completion>, LspError>;

    fn name(&self) -> &'static str;
}

/// Returns hover documentation for a symbol at a source position.
pub trait HoverProvider {
    fn hover(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Option<Hover>, LspError>;

    fn name(&self) -> &'static str;
}

/// Returns a one-to-many list of source locations (definitions /
/// references).  Consumers choose which call site to emit.
pub trait LocationProvider {
    fn definitions(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<SourceRange>, LspError>;

    fn references(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<SourceRange>, LspError>;

    fn name(&self) -> &'static str;
}

/// Returns diagnostics for an entire file.  Called on open / save.
pub trait DiagnosticsProvider {
    fn diagnostics(
        &self,
        language: Language,
        file: &str,
        source: &str,
    ) -> Result<Vec<Diagnostic>, LspError>;

    fn name(&self) -> &'static str;
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum LspError {
    #[error("backend '{backend}' unavailable: {reason}")]
    BackendUnavailable { backend: String, reason: String },

    #[error("backend '{backend}' timed out after {ms} ms")]
    Timeout { backend: String, ms: u64 },

    #[error("language {lang:?} has no configured backend")]
    NoBackend { lang: Language },

    #[error("internal error: {0}")]
    Internal(String),
}

// ─── Multiplexer (Phase 2 M2.1, A-slice) ─────────────────────────────
//
// `LspMultiplexer` routes a query to the right set of providers per
// `Language`.  It is the call-site counterpart of `pccx_core::plugin`:
// where `PluginRegistry<P>` holds a concrete `Vec<P>` (one plugin kind
// per registry), the multiplexer holds three heterogeneous trait
// objects per language because a single editor interaction touches
// all three surfaces (complete / hover / locate) at once.
//
// The scaffold is intentionally minimal:
//   - no async (the tower-lsp adapter lands in Phase 2 proper and
//     wraps this type, not the other way around),
//   - no dynamic reload (callers that need it wrap in Mutex / RwLock
//     and swap backends between queries),
//   - all three providers per language register atomically; partial
//     registration can be added later without breaking this API.

/// Provider triple the multiplexer stores per registered language.
/// Kept as `Send + Sync` so the multiplexer can move across thread
/// boundaries when pccx-ide spawns its async LSP adapter in Phase 2
/// proper.
struct LanguageBackends {
    completion: Box<dyn CompletionProvider + Send + Sync>,
    hover: Box<dyn HoverProvider + Send + Sync>,
    location: Box<dyn LocationProvider + Send + Sync>,
}

/// Routes a query to the registered backend triple for its language.
/// Returns `LspError::NoBackend` for any language that was never
/// registered.
#[derive(Default)]
pub struct LspMultiplexer {
    backends: HashMap<Language, LanguageBackends>,
}

impl LspMultiplexer {
    /// Empty multiplexer with no languages registered.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers (or replaces) the provider triple for a language.
    pub fn register(
        &mut self,
        language: Language,
        completion: Box<dyn CompletionProvider + Send + Sync>,
        hover: Box<dyn HoverProvider + Send + Sync>,
        location: Box<dyn LocationProvider + Send + Sync>,
    ) {
        self.backends.insert(
            language,
            LanguageBackends {
                completion,
                hover,
                location,
            },
        );
    }

    /// True iff `language` has a registered provider triple.
    pub fn has(&self, language: Language) -> bool {
        self.backends.contains_key(&language)
    }

    /// Languages currently registered, in unspecified order.
    pub fn registered_languages(&self) -> Vec<Language> {
        self.backends.keys().copied().collect()
    }

    fn dispatch(&self, language: Language) -> Result<&LanguageBackends, LspError> {
        self.backends
            .get(&language)
            .ok_or(LspError::NoBackend { lang: language })
    }

    /// Forwards a completion query to the registered backend.
    pub fn complete(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<Completion>, LspError> {
        self.dispatch(language)?
            .completion
            .complete(language, file, pos, source)
    }

    /// Forwards a hover query to the registered backend.
    pub fn hover(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Option<Hover>, LspError> {
        self.dispatch(language)?
            .hover
            .hover(language, file, pos, source)
    }

    /// Forwards a go-to-definition query to the registered backend.
    pub fn definitions(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<SourceRange>, LspError> {
        self.dispatch(language)?
            .location
            .definitions(language, file, pos, source)
    }

    /// Forwards a references query to the registered backend.
    pub fn references(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<SourceRange>, LspError> {
        self.dispatch(language)?
            .location
            .references(language, file, pos, source)
    }
}

// ─── NoopBackend (Phase 2 M2.1, A-slice) ─────────────────────────────
//
// Reference backend used in unit tests and as a deliberate "no data"
// answer in pccx-ide before a real backend (verible, rust-analyzer,
// AI layer) has been registered for a language.  All three providers
// return empty results rather than errors — "I have nothing for you
// here" is a valid LSP answer and the editor should silently omit
// the affordance rather than surface a failure toast.

/// Empty-answer backend.  Implements all three provider traits and
/// always returns "no data".
pub struct NoopBackend;

impl CompletionProvider for NoopBackend {
    fn complete(
        &self,
        _language: Language,
        _file: &str,
        _pos: SourcePos,
        _source: &str,
    ) -> Result<Vec<Completion>, LspError> {
        Ok(Vec::new())
    }
    fn name(&self) -> &'static str {
        "noop"
    }
}

impl HoverProvider for NoopBackend {
    fn hover(
        &self,
        _language: Language,
        _file: &str,
        _pos: SourcePos,
        _source: &str,
    ) -> Result<Option<Hover>, LspError> {
        Ok(None)
    }
    fn name(&self) -> &'static str {
        "noop"
    }
}

impl LocationProvider for NoopBackend {
    fn definitions(
        &self,
        _language: Language,
        _file: &str,
        _pos: SourcePos,
        _source: &str,
    ) -> Result<Vec<SourceRange>, LspError> {
        Ok(Vec::new())
    }
    fn references(
        &self,
        _language: Language,
        _file: &str,
        _pos: SourcePos,
        _source: &str,
    ) -> Result<Vec<SourceRange>, LspError> {
        Ok(Vec::new())
    }
    fn name(&self) -> &'static str {
        "noop"
    }
}

// ─── Async provider traits (Phase 2 M2.1, B-slice) ───────────────────
//
// Async companions to the sync provider trio above.  Concrete backends
// that fan out to an external LSP subprocess (verible, rust-analyzer,
// clangd) must await IO; the sync surface stays for in-process /
// AI-cache providers that never await.  Object-safety is preserved
// via `#[async_trait]`, which boxes the returned future so a future
// async multiplexer can hold `Box<dyn AsyncCompletionProvider>` etc.

#[async_trait::async_trait]
pub trait AsyncCompletionProvider: Send + Sync {
    async fn complete(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<Completion>, LspError>;

    fn name(&self) -> &'static str;
}

#[async_trait::async_trait]
pub trait AsyncHoverProvider: Send + Sync {
    async fn hover(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Option<Hover>, LspError>;

    fn name(&self) -> &'static str;
}

#[async_trait::async_trait]
pub trait AsyncLocationProvider: Send + Sync {
    async fn definitions(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<SourceRange>, LspError>;

    async fn references(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<SourceRange>, LspError>;

    fn name(&self) -> &'static str;
}

// ─── BlockingBridge — sync -> async adapter (B-slice) ────────────────
//
// Lifts a sync provider into the async world via
// `tokio::task::spawn_blocking`.  Lets in-process providers
// (`NoopBackend`, a future AST-hash cache) live inside a
// tokio-scheduled pipeline next to real LSP subprocesses without
// forcing callers to juggle two shapes.

/// Sync-to-async adapter over any `P` that implements one or more of
/// the sync provider traits.  Holds `P` inside `Arc` so the bridge
/// is cheaply cloneable across tasks.
pub struct BlockingBridge<P> {
    inner: Arc<P>,
}

impl<P> BlockingBridge<P> {
    /// Wraps `inner` for async use.
    pub fn new(inner: P) -> Self {
        Self {
            inner: Arc::new(inner),
        }
    }
}

#[async_trait::async_trait]
impl<P> AsyncCompletionProvider for BlockingBridge<P>
where
    P: CompletionProvider + Send + Sync + 'static,
{
    async fn complete(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<Completion>, LspError> {
        let inner = self.inner.clone();
        let file = file.to_owned();
        let source = source.to_owned();
        tokio::task::spawn_blocking(move || inner.complete(language, &file, pos, &source))
            .await
            .map_err(|e| LspError::Internal(format!("spawn_blocking join: {e}")))?
    }

    fn name(&self) -> &'static str {
        "blocking-bridge"
    }
}

#[async_trait::async_trait]
impl<P> AsyncHoverProvider for BlockingBridge<P>
where
    P: HoverProvider + Send + Sync + 'static,
{
    async fn hover(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Option<Hover>, LspError> {
        let inner = self.inner.clone();
        let file = file.to_owned();
        let source = source.to_owned();
        tokio::task::spawn_blocking(move || inner.hover(language, &file, pos, &source))
            .await
            .map_err(|e| LspError::Internal(format!("spawn_blocking join: {e}")))?
    }

    fn name(&self) -> &'static str {
        "blocking-bridge"
    }
}

#[async_trait::async_trait]
impl<P> AsyncLocationProvider for BlockingBridge<P>
where
    P: LocationProvider + Send + Sync + 'static,
{
    async fn definitions(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<SourceRange>, LspError> {
        let inner = self.inner.clone();
        let file = file.to_owned();
        let source = source.to_owned();
        tokio::task::spawn_blocking(move || inner.definitions(language, &file, pos, &source))
            .await
            .map_err(|e| LspError::Internal(format!("spawn_blocking join: {e}")))?
    }

    async fn references(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<SourceRange>, LspError> {
        let inner = self.inner.clone();
        let file = file.to_owned();
        let source = source.to_owned();
        tokio::task::spawn_blocking(move || inner.references(language, &file, pos, &source))
            .await
            .map_err(|e| LspError::Internal(format!("spawn_blocking join: {e}")))?
    }

    fn name(&self) -> &'static str {
        "blocking-bridge"
    }
}

// ─── Subprocess spawner (Phase 2 M2.1, B-slice) ──────────────────────
//
// Declarative spec + handle for launching an LSP server as a child
// process.  JSON-RPC-over-stdio plumbing does NOT land in this slice;
// it arrives alongside the first concrete backend (verible) when the
// smoke test "type GEMM_ in a .sv file, receive verible completions"
// is wired up.  Shipping the lifecycle primitives first lets the
// future JSON-RPC pump bolt on without relitigating spawn / env /
// working_dir / kill semantics.

/// Declarative spec for how to spawn an LSP server.  Fluent helpers
/// keep construction readable for servers with many args.
#[derive(Debug, Clone)]
pub struct SpawnConfig {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub working_dir: Option<PathBuf>,
    pub env: Vec<(OsString, OsString)>,
}

impl SpawnConfig {
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            working_dir: None,
            env: Vec::new(),
        }
    }

    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn working_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.working_dir = Some(dir.into());
        self
    }

    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }
}

/// Running LSP child.  Wraps `tokio::process::Child` and owns its
/// stdio pipes.  The JSON-RPC codec attaches to those pipes in a
/// follow-on slice.
///
/// `kill_on_drop` is enabled so a panic inside the owning task will
/// not leave orphan LSP servers running on the user's box.
pub struct LspSubprocess {
    config: SpawnConfig,
    child: Child,
}

impl LspSubprocess {
    /// Spawn the server described by `config` with piped stdio.
    pub fn spawn(config: SpawnConfig) -> Result<Self, LspError> {
        let mut cmd = Command::new(&config.program);
        cmd.args(&config.args);
        if let Some(dir) = &config.working_dir {
            cmd.current_dir(dir);
        }
        for (k, v) in &config.env {
            cmd.env(k, v);
        }
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);
        let child = cmd.spawn().map_err(|e| LspError::BackendUnavailable {
            backend: config.program.to_string_lossy().into_owned(),
            reason: format!("spawn failed: {e}"),
        })?;
        Ok(Self { config, child })
    }

    pub fn config(&self) -> &SpawnConfig {
        &self.config
    }

    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    /// Terminates the child (SIGKILL on Unix) and awaits exit.
    pub async fn kill(&mut self) -> Result<(), LspError> {
        self.child
            .kill()
            .await
            .map_err(|e| LspError::Internal(format!("kill: {e}")))
    }

    /// Waits for the child to exit on its own.
    pub async fn wait(&mut self) -> Result<std::process::ExitStatus, LspError> {
        self.child
            .wait()
            .await
            .map_err(|e| LspError::Internal(format!("wait: {e}")))
    }
}

// ─── JSON-RPC wire framing (Phase 2 M2.1, C-slice proper) ────────────
//
// The Language Server Protocol ships every JSON-RPC message framed
// with HTTP-style headers:
//
//     Content-Length: <N>\r\n
//     [Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n]
//     \r\n
//     <N-byte JSON body>
//
// Content-Length is mandatory; Content-Type is optional and we ignore
// it on the decode side.  This slice lands the pure byte layer —
// `encode_frame` prepends the header, `decode_frame` parses the header
// + extracts one body from a byte buffer, returning the consumed-byte
// count so the caller can drain its read buffer incrementally.  The
// typed `lsp-types` envelope and the pump that attaches this codec
// to `LspSubprocess` stdio arrive in the next slice.

/// Parse errors specific to the JSON-RPC LSP frame layer.  Distinct
/// from `LspError` because framing errors are recoverable at the
/// transport level: the caller can drop the frame, log, and resume.
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("frame header is not valid UTF-8")]
    HeaderNotUtf8,

    #[error("Content-Length header is missing")]
    MissingContentLength,

    #[error("Content-Length header value '{0}' is not a valid non-negative integer")]
    BadContentLength(String),

    #[error("Content-Length {claimed} exceeds the 64 MiB hard cap — refusing to allocate")]
    ContentLengthTooLarge { claimed: usize },
}

/// Hard cap on a single LSP message body.  LSP does not specify one,
/// but 64 MiB is 200x the largest real-world LSP payload observed
/// (rust-analyzer's full workspace completion response on a 20k-file
/// tree) and protects us from an adversarial server claiming
/// `Content-Length: 9e18`.
pub const MAX_FRAME_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Frames a JSON body with the LSP header and returns the complete
/// bytes to write to the transport.
pub fn encode_frame(body: &[u8]) -> Vec<u8> {
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut out = Vec::with_capacity(header.len() + body.len());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(body);
    out
}

/// Attempts to decode one complete frame from the front of `buf`.
///
/// Returns:
/// - `Ok(Some((body, consumed)))` — `consumed` bytes from the start
///   of `buf` form one complete frame whose JSON body is `body`.
///   Caller drains `buf[..consumed]`.
/// - `Ok(None)` — not enough bytes yet (header incomplete OR body
///   short).  Caller reads more and retries.
/// - `Err(FrameError::…)` — header malformed; caller should drop the
///   bytes up to the next potential frame or abort the session.
pub fn decode_frame(buf: &[u8]) -> Result<Option<(Vec<u8>, usize)>, FrameError> {
    let Some(sep_pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
        return Ok(None);
    };
    let header_bytes = &buf[..sep_pos];
    let header_str = std::str::from_utf8(header_bytes).map_err(|_| FrameError::HeaderNotUtf8)?;

    let mut content_length: Option<usize> = None;
    for line in header_str.split("\r\n") {
        if let Some((key, val)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                let raw = val.trim();
                content_length = Some(
                    raw.parse::<usize>()
                        .map_err(|_| FrameError::BadContentLength(raw.to_string()))?,
                );
            }
            // Other headers (Content-Type in particular) are ignored;
            // the spec allows them but we never branch on them.
        }
    }

    let n = content_length.ok_or(FrameError::MissingContentLength)?;
    if n > MAX_FRAME_BODY_BYTES {
        return Err(FrameError::ContentLengthTooLarge { claimed: n });
    }

    let body_start = sep_pos + 4;
    let body_end = body_start + n;
    if buf.len() < body_end {
        return Ok(None);
    }
    Ok(Some((buf[body_start..body_end].to_vec(), body_end)))
}

// ─── Async framed IO (Phase 2 M2.1, D-slice) ─────────────────────────
//
// Thin wrappers that run `encode_frame` / `decode_frame` over any
// `tokio::io::AsyncWrite` / `AsyncRead`.  Generic over the IO type
// so they attach equally well to `LspSubprocess`'s child stdio
// (production) or to `tokio::io::duplex` pairs (tests without
// spawning processes).
//
// Error taxonomy: IO failures surface as `std::io::Error`; malformed
// frames are converted to `io::Error` with a distinct `InvalidData`
// kind carrying the underlying `FrameError` via the `io::Error`
// source chain.  Callers who need to discriminate can downcast via
// `.get_ref().and_then(|e| e.downcast_ref::<FrameError>())`.

fn frame_io_error(err: FrameError) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, err)
}

/// Writes a complete framed message to the transport and flushes it.
/// Calls `encode_frame` internally so callers only think about the
/// body.
pub async fn write_frame<W: AsyncWrite + Unpin>(
    w: &mut W,
    body: &[u8],
) -> std::io::Result<()> {
    let framed = encode_frame(body);
    w.write_all(&framed).await?;
    w.flush().await
}

/// Reads exactly one complete framed message from the transport.
///
/// Returns:
/// - `Ok(Some(body))` — one complete frame decoded.
/// - `Ok(None)` — the transport returned EOF before any byte of a
///   frame could be read (clean close; session over).
/// - `Err(io::Error)` — IO failure OR framing error (kind
///   `InvalidData`, with a `FrameError` in the source chain).
///
/// `buf` is the caller-owned read buffer; it is extended in place as
/// bytes arrive and is left with whatever bytes remain *after* the
/// decoded frame (i.e., if the stream sent two frames back-to-back,
/// the second one is preserved for the next `read_frame` call).
pub async fn read_frame<R: AsyncRead + Unpin>(
    r: &mut R,
    buf: &mut Vec<u8>,
) -> std::io::Result<Option<Vec<u8>>> {
    loop {
        // Try decoding whatever we already have.
        match decode_frame(buf) {
            Ok(Some((body, consumed))) => {
                buf.drain(..consumed);
                return Ok(Some(body));
            }
            Ok(None) => { /* need more bytes */ }
            Err(err) => return Err(frame_io_error(err)),
        }

        // Read more bytes.  One syscall at a time is fine — real
        // LSP traffic is tiny, and tokio batches the kernel reads.
        let mut tmp = [0u8; 4096];
        let n = r.read(&mut tmp).await?;
        if n == 0 {
            // Clean EOF.  If `buf` is non-empty we hit EOF mid-frame
            // — that's an unexpected close by the peer.
            return if buf.is_empty() {
                Ok(None)
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "transport closed mid-frame",
                ))
            };
        }
        buf.extend_from_slice(&tmp[..n]);
    }
}

// ─── Async multiplexer (Phase 2 M2.1, C-slice fragment) ──────────────
//
// Async counterpart to `LspMultiplexer`.  Holds one triple of async
// trait objects per `Language` and forwards async queries.  The shape
// mirrors the sync multiplexer exactly so callers that migrate from
// the sync surface rewrite only their `.await` call sites.
//
// Independent from the JSON-RPC codec and the concrete verible
// backend — those land in later slices.  Shipping the async
// multiplexer now lets pccx-ide prototype the async call graph
// against `BlockingBridge<NoopBackend>` triples before any real LSP
// server is attached.

/// Provider triple the async multiplexer stores per registered
/// language.  The `AsyncCompletionProvider` / `AsyncHoverProvider` /
/// `AsyncLocationProvider` supertraits carry `Send + Sync`, so the
/// `Box<dyn …>` types below are `Send + Sync` even without explicit
/// markers; the markers stay for symmetry with `LanguageBackends`
/// and to keep the declaration readable.
struct AsyncLanguageBackends {
    completion: Box<dyn AsyncCompletionProvider + Send + Sync>,
    hover: Box<dyn AsyncHoverProvider + Send + Sync>,
    location: Box<dyn AsyncLocationProvider + Send + Sync>,
}

/// Routes an async query to the registered backend triple for its
/// language.  Returns `LspError::NoBackend` for unregistered
/// languages.
#[derive(Default)]
pub struct AsyncLspMultiplexer {
    backends: HashMap<Language, AsyncLanguageBackends>,
}

impl AsyncLspMultiplexer {
    /// Empty multiplexer with no languages registered.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers (or replaces) the async provider triple for a
    /// language.
    pub fn register(
        &mut self,
        language: Language,
        completion: Box<dyn AsyncCompletionProvider + Send + Sync>,
        hover: Box<dyn AsyncHoverProvider + Send + Sync>,
        location: Box<dyn AsyncLocationProvider + Send + Sync>,
    ) {
        self.backends.insert(
            language,
            AsyncLanguageBackends {
                completion,
                hover,
                location,
            },
        );
    }

    /// True iff `language` has a registered async provider triple.
    pub fn has(&self, language: Language) -> bool {
        self.backends.contains_key(&language)
    }

    /// Languages currently registered, in unspecified order.
    pub fn registered_languages(&self) -> Vec<Language> {
        self.backends.keys().copied().collect()
    }

    fn dispatch(&self, language: Language) -> Result<&AsyncLanguageBackends, LspError> {
        self.backends
            .get(&language)
            .ok_or(LspError::NoBackend { lang: language })
    }

    /// Forwards a completion query to the registered backend.
    pub async fn complete(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<Completion>, LspError> {
        self.dispatch(language)?
            .completion
            .complete(language, file, pos, source)
            .await
    }

    /// Forwards a hover query to the registered backend.
    pub async fn hover(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Option<Hover>, LspError> {
        self.dispatch(language)?
            .hover
            .hover(language, file, pos, source)
            .await
    }

    /// Forwards a go-to-definition query to the registered backend.
    pub async fn definitions(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<SourceRange>, LspError> {
        self.dispatch(language)?
            .location
            .definitions(language, file, pos, source)
            .await
    }

    /// Forwards a references query to the registered backend.
    pub async fn references(
        &self,
        language: Language,
        file: &str,
        pos: SourcePos,
        source: &str,
    ) -> Result<Vec<SourceRange>, LspError> {
        self.dispatch(language)?
            .location
            .references(language, file, pos, source)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_from_extension_maps_sv_and_svh() {
        assert_eq!(Language::from_extension("sv"), Some(Language::SystemVerilog));
        assert_eq!(Language::from_extension("SVH"), Some(Language::SystemVerilog));
        assert_eq!(Language::from_extension("unknown"), None);
    }

    #[test]
    fn language_from_extension_handles_c_family() {
        assert_eq!(Language::from_extension("c"), Some(Language::C));
        assert_eq!(Language::from_extension("h"), Some(Language::C));
        assert_eq!(Language::from_extension("cpp"), Some(Language::Cpp));
        assert_eq!(Language::from_extension("hpp"), Some(Language::Cpp));
    }

    #[test]
    fn completion_source_variants_serialize_round_trip() {
        for s in [
            CompletionSource::Lsp,
            CompletionSource::AiFast,
            CompletionSource::AiDeep,
            CompletionSource::Cache,
        ] {
            let j = serde_json::to_string(&s).unwrap();
            let back: CompletionSource = serde_json::from_str(&j).unwrap();
            assert_eq!(s, back);
        }
    }

    #[test]
    fn api_version_is_one() {
        assert_eq!(LSP_FAÇADE_API_VERSION, 1);
    }

    // ─── Multiplexer + NoopBackend (M2.1 A-slice) ────────────────

    fn origin() -> SourcePos {
        SourcePos {
            line: 0,
            character: 0,
        }
    }

    #[test]
    fn noop_backend_returns_empty_completions() {
        let out = NoopBackend
            .complete(Language::SystemVerilog, "foo.sv", origin(), "")
            .expect("noop completion");
        assert!(out.is_empty());
    }

    #[test]
    fn noop_backend_returns_none_for_hover() {
        let out = NoopBackend
            .hover(Language::Rust, "foo.rs", origin(), "")
            .expect("noop hover");
        assert!(out.is_none());
    }

    #[test]
    fn noop_backend_returns_empty_definitions_and_references() {
        let defs = NoopBackend
            .definitions(Language::Python, "a.py", origin(), "")
            .expect("noop defs");
        let refs = NoopBackend
            .references(Language::Python, "a.py", origin(), "")
            .expect("noop refs");
        assert!(defs.is_empty());
        assert!(refs.is_empty());
    }

    #[test]
    fn multiplexer_starts_empty() {
        let m = LspMultiplexer::new();
        assert!(!m.has(Language::SystemVerilog));
        assert!(m.registered_languages().is_empty());
    }

    #[test]
    fn multiplexer_rejects_unregistered_language_with_no_backend() {
        let m = LspMultiplexer::new();
        let err = m
            .complete(Language::Rust, "x.rs", origin(), "")
            .expect_err("unregistered must error");
        match err {
            LspError::NoBackend { lang } => assert_eq!(lang, Language::Rust),
            other => panic!("expected NoBackend, got {other:?}"),
        }
    }

    #[test]
    fn multiplexer_dispatches_to_registered_noop_backend() {
        let mut m = LspMultiplexer::new();
        m.register(
            Language::SystemVerilog,
            Box::new(NoopBackend),
            Box::new(NoopBackend),
            Box::new(NoopBackend),
        );

        assert!(m.has(Language::SystemVerilog));
        assert_eq!(m.registered_languages(), vec![Language::SystemVerilog]);

        assert!(m
            .complete(Language::SystemVerilog, "t.sv", origin(), "")
            .unwrap()
            .is_empty());
        assert!(m
            .hover(Language::SystemVerilog, "t.sv", origin(), "")
            .unwrap()
            .is_none());
        assert!(m
            .definitions(Language::SystemVerilog, "t.sv", origin(), "")
            .unwrap()
            .is_empty());
        assert!(m
            .references(Language::SystemVerilog, "t.sv", origin(), "")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn multiplexer_register_replaces_existing_triple() {
        // A completion provider tagged with a stable id so we can
        // confirm the second register() call wins.
        struct TaggedCompletion {
            id: &'static str,
        }
        impl CompletionProvider for TaggedCompletion {
            fn complete(
                &self,
                _: Language,
                _: &str,
                _: SourcePos,
                _: &str,
            ) -> Result<Vec<Completion>, LspError> {
                Ok(vec![Completion {
                    label: self.id.into(),
                    detail: None,
                    documentation: None,
                    insert_text: self.id.into(),
                    source: CompletionSource::Lsp,
                }])
            }
            fn name(&self) -> &'static str {
                "tagged"
            }
        }

        let mut m = LspMultiplexer::new();
        m.register(
            Language::Rust,
            Box::new(TaggedCompletion { id: "first" }),
            Box::new(NoopBackend),
            Box::new(NoopBackend),
        );
        m.register(
            Language::Rust,
            Box::new(TaggedCompletion { id: "second" }),
            Box::new(NoopBackend),
            Box::new(NoopBackend),
        );

        let out = m.complete(Language::Rust, "x.rs", origin(), "").unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].label, "second");
    }

    // ─── SpawnConfig / LspSubprocess / BlockingBridge (B-slice) ───

    #[test]
    fn spawn_config_fluent_builds_correctly() {
        let cfg = SpawnConfig::new("verible-verilog-lsp")
            .arg("--rules_config_search")
            .arg("--rules=")
            .env("RUST_LOG", "off")
            .working_dir("/tmp");
        assert_eq!(cfg.program, OsString::from("verible-verilog-lsp"));
        assert_eq!(cfg.args.len(), 2);
        assert_eq!(cfg.args[0], OsString::from("--rules_config_search"));
        assert_eq!(cfg.args[1], OsString::from("--rules="));
        assert_eq!(
            cfg.env,
            vec![(OsString::from("RUST_LOG"), OsString::from("off"))]
        );
        assert_eq!(
            cfg.working_dir.as_deref(),
            Some(std::path::Path::new("/tmp"))
        );
    }

    #[test]
    fn spawn_config_args_extends_via_iter() {
        let cfg = SpawnConfig::new("rust-analyzer").args(["--version", "--verbose"]);
        assert_eq!(cfg.args.len(), 2);
        assert_eq!(cfg.args[0], OsString::from("--version"));
        assert_eq!(cfg.args[1], OsString::from("--verbose"));
    }

    #[tokio::test]
    async fn lsp_subprocess_spawns_and_waits_for_trivial_command() {
        // `true` is in PATH on every supported host and exits 0
        // immediately.  Proves spawn + wait end-to-end.
        let mut sp = LspSubprocess::spawn(SpawnConfig::new("true")).expect("spawn true");
        assert!(sp.id().is_some());
        let status = sp.wait().await.expect("wait succeeds");
        assert!(status.success(), "`true` must exit 0");
    }

    #[tokio::test]
    async fn lsp_subprocess_kill_terminates_long_running_child() {
        // `sleep 30` would outlive any sane test run; kill() must
        // terminate it and wait() must then report non-success.
        let mut sp =
            LspSubprocess::spawn(SpawnConfig::new("sleep").arg("30")).expect("spawn sleep");
        sp.kill().await.expect("kill succeeds");
        let status = sp.wait().await.expect("wait after kill");
        assert!(
            !status.success(),
            "killed process must not report success"
        );
    }

    #[tokio::test]
    async fn blocking_bridge_completion_delegates_to_sync_noop() {
        let bridge = BlockingBridge::new(NoopBackend);
        let out = bridge
            .complete(Language::SystemVerilog, "f.sv", origin(), "")
            .await
            .expect("async completion via bridge");
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn blocking_bridge_hover_delegates_to_sync_noop() {
        let bridge = BlockingBridge::new(NoopBackend);
        let out = bridge
            .hover(Language::Rust, "f.rs", origin(), "")
            .await
            .expect("async hover via bridge");
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn blocking_bridge_location_delegates_to_sync_noop() {
        let bridge = BlockingBridge::new(NoopBackend);
        let defs = bridge
            .definitions(Language::Python, "f.py", origin(), "")
            .await
            .expect("async defs via bridge");
        let refs = bridge
            .references(Language::Python, "f.py", origin(), "")
            .await
            .expect("async refs via bridge");
        assert!(defs.is_empty());
        assert!(refs.is_empty());
    }

    // ─── AsyncLspMultiplexer (C-slice fragment) ───

    #[test]
    fn async_multiplexer_starts_empty() {
        let m = AsyncLspMultiplexer::new();
        assert!(!m.has(Language::SystemVerilog));
        assert!(m.registered_languages().is_empty());
    }

    #[tokio::test]
    async fn async_multiplexer_rejects_unregistered_language_with_no_backend() {
        let m = AsyncLspMultiplexer::new();
        let err = m
            .complete(Language::Rust, "x.rs", origin(), "")
            .await
            .expect_err("unregistered must error");
        match err {
            LspError::NoBackend { lang } => assert_eq!(lang, Language::Rust),
            other => panic!("expected NoBackend, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn async_multiplexer_dispatches_through_blocking_bridge_noop() {
        let mut m = AsyncLspMultiplexer::new();
        m.register(
            Language::SystemVerilog,
            Box::new(BlockingBridge::new(NoopBackend)),
            Box::new(BlockingBridge::new(NoopBackend)),
            Box::new(BlockingBridge::new(NoopBackend)),
        );

        assert!(m.has(Language::SystemVerilog));
        assert_eq!(m.registered_languages(), vec![Language::SystemVerilog]);

        assert!(m
            .complete(Language::SystemVerilog, "t.sv", origin(), "")
            .await
            .unwrap()
            .is_empty());
        assert!(m
            .hover(Language::SystemVerilog, "t.sv", origin(), "")
            .await
            .unwrap()
            .is_none());
        assert!(m
            .definitions(Language::SystemVerilog, "t.sv", origin(), "")
            .await
            .unwrap()
            .is_empty());
        assert!(m
            .references(Language::SystemVerilog, "t.sv", origin(), "")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn async_multiplexer_register_replaces_existing_triple() {
        // Tagged async provider — second register() wins.
        struct TaggedAsync {
            id: &'static str,
        }
        #[async_trait::async_trait]
        impl AsyncCompletionProvider for TaggedAsync {
            async fn complete(
                &self,
                _: Language,
                _: &str,
                _: SourcePos,
                _: &str,
            ) -> Result<Vec<Completion>, LspError> {
                Ok(vec![Completion {
                    label: self.id.into(),
                    detail: None,
                    documentation: None,
                    insert_text: self.id.into(),
                    source: CompletionSource::Lsp,
                }])
            }
            fn name(&self) -> &'static str {
                "tagged-async"
            }
        }

        let mut m = AsyncLspMultiplexer::new();
        m.register(
            Language::Rust,
            Box::new(TaggedAsync { id: "first" }),
            Box::new(BlockingBridge::new(NoopBackend)),
            Box::new(BlockingBridge::new(NoopBackend)),
        );
        m.register(
            Language::Rust,
            Box::new(TaggedAsync { id: "second" }),
            Box::new(BlockingBridge::new(NoopBackend)),
            Box::new(BlockingBridge::new(NoopBackend)),
        );

        let out = m
            .complete(Language::Rust, "x.rs", origin(), "")
            .await
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].label, "second");
    }

    // ─── JSON-RPC wire framing (C-slice proper) ───

    #[test]
    fn encode_frame_prepends_content_length_header() {
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
        let framed = encode_frame(body);
        let expected = format!("Content-Length: {}\r\n\r\n", body.len());
        assert!(framed.starts_with(expected.as_bytes()));
        assert_eq!(&framed[expected.len()..], body);
    }

    #[test]
    fn encode_frame_empty_body_has_content_length_zero() {
        let framed = encode_frame(b"");
        assert_eq!(framed, b"Content-Length: 0\r\n\r\n");
    }

    #[test]
    fn decode_roundtrips_a_typical_lsp_request() {
        let body = br#"{"jsonrpc":"2.0","id":7,"method":"textDocument/completion"}"#;
        let framed = encode_frame(body);
        let (parsed, consumed) = decode_frame(&framed)
            .expect("decode ok")
            .expect("one complete frame");
        assert_eq!(parsed, body);
        assert_eq!(consumed, framed.len());
    }

    #[test]
    fn decode_roundtrips_utf8_body_with_multibyte_chars() {
        // Mixed 2-byte (ü), 3-byte (안녕 / 漢字) codepoints to catch
        // any accidental byte / character confusion in the decoder.
        let body = "ü 안녕 漢字 {\"a\":1}".as_bytes();
        let framed = encode_frame(body);
        let (parsed, consumed) = decode_frame(&framed).unwrap().unwrap();
        assert_eq!(parsed, body);
        assert_eq!(consumed, framed.len());
    }

    #[test]
    fn decode_returns_none_on_partial_header() {
        // Separator "\r\n\r\n" is not yet present.
        let partial = b"Content-Length: 42\r";
        assert!(decode_frame(partial).unwrap().is_none());
    }

    #[test]
    fn decode_returns_none_on_partial_body() {
        let body = br#"{"ok":true}"#;
        let mut framed = encode_frame(body);
        let short_by = 3;
        framed.truncate(framed.len() - short_by);
        assert!(decode_frame(&framed).unwrap().is_none());
    }

    #[test]
    fn decode_consumes_exactly_one_frame_when_buffer_has_a_second() {
        let b1 = br#"{"id":1}"#;
        let b2 = br#"{"id":2}"#;
        let mut concat = encode_frame(b1);
        concat.extend_from_slice(&encode_frame(b2));
        let (parsed, consumed) = decode_frame(&concat).unwrap().unwrap();
        assert_eq!(parsed, b1);
        assert_eq!(&concat[consumed..consumed + encode_frame(b2).len()], &encode_frame(b2)[..]);
    }

    #[test]
    fn decode_rejects_header_missing_content_length() {
        let malformed = b"Content-Type: application/vscode-jsonrpc\r\n\r\n{}";
        let err = decode_frame(malformed).unwrap_err();
        assert!(matches!(err, FrameError::MissingContentLength));
    }

    #[test]
    fn decode_rejects_non_numeric_content_length() {
        let malformed = b"Content-Length: abc\r\n\r\n{}";
        let err = decode_frame(malformed).unwrap_err();
        assert!(matches!(err, FrameError::BadContentLength(ref s) if s == "abc"));
    }

    #[test]
    fn decode_accepts_content_type_alongside_content_length() {
        let body = br#"{}"#;
        let mut framed = Vec::new();
        framed.extend_from_slice(b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n");
        framed.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
        framed.extend_from_slice(body);
        let (parsed, _) = decode_frame(&framed).unwrap().unwrap();
        assert_eq!(parsed, body);
    }

    #[test]
    fn decode_header_lookup_is_case_insensitive() {
        let body = br#"{}"#;
        let mut framed = Vec::new();
        framed.extend_from_slice(format!("content-LENGTH: {}\r\n\r\n", body.len()).as_bytes());
        framed.extend_from_slice(body);
        let (parsed, _) = decode_frame(&framed).unwrap().unwrap();
        assert_eq!(parsed, body);
    }

    #[test]
    fn decode_rejects_oversized_content_length() {
        let claim = MAX_FRAME_BODY_BYTES + 1;
        let header = format!("Content-Length: {claim}\r\n\r\n");
        let err = decode_frame(header.as_bytes()).unwrap_err();
        assert!(matches!(err, FrameError::ContentLengthTooLarge { claimed } if claimed == claim));
    }

    // ─── Async framed IO (D-slice) ───

    #[tokio::test]
    async fn write_frame_then_read_frame_roundtrips_body() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let body = br#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#.to_vec();

        write_frame(&mut client, &body).await.expect("write");
        drop(client); // signal EOF so the reader's next call sees a clean close.

        let mut buf = Vec::new();
        let got = read_frame(&mut server, &mut buf)
            .await
            .expect("read")
            .expect("one frame");
        assert_eq!(got, body);
        assert!(buf.is_empty(), "buffer fully drained");
    }

    #[tokio::test]
    async fn read_frame_returns_none_on_clean_eof() {
        let (client, mut server) = tokio::io::duplex(64);
        drop(client); // immediate EOF, nothing written.

        let mut buf = Vec::new();
        let got = read_frame(&mut server, &mut buf).await.expect("read ok");
        assert!(got.is_none(), "clean EOF maps to None");
    }

    #[tokio::test]
    async fn read_frame_errors_unexpected_eof_mid_frame() {
        let (mut client, mut server) = tokio::io::duplex(64);
        // Write a half-frame header, then close.
        client.write_all(b"Content-Length: 42\r\n").await.unwrap();
        drop(client);

        let mut buf = Vec::new();
        let err = read_frame(&mut server, &mut buf).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof);
    }

    #[tokio::test]
    async fn read_frame_maps_malformed_header_to_invalid_data() {
        let (mut client, mut server) = tokio::io::duplex(64);
        client
            .write_all(b"Content-Length: bogus\r\n\r\n{}")
            .await
            .unwrap();
        drop(client);

        let mut buf = Vec::new();
        let err = read_frame(&mut server, &mut buf).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn read_frame_back_to_back_preserves_second_frame_in_buf() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let b1 = br#"{"id":1}"#.to_vec();
        let b2 = br#"{"id":2}"#.to_vec();
        write_frame(&mut client, &b1).await.unwrap();
        write_frame(&mut client, &b2).await.unwrap();
        drop(client);

        let mut buf = Vec::new();
        let got1 = read_frame(&mut server, &mut buf).await.unwrap().unwrap();
        assert_eq!(got1, b1);
        let got2 = read_frame(&mut server, &mut buf).await.unwrap().unwrap();
        assert_eq!(got2, b2);
        let got_eof = read_frame(&mut server, &mut buf).await.unwrap();
        assert!(got_eof.is_none());
    }
}
