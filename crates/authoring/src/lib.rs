// Module Boundary: authoring/
// pccx-authoring: ISA + driver-API declarative specs (TOML-driven).
//
// Two companion modules:
//   * `isa_spec` — opcode / field / encoding declarations; emits SV
//                  package + doc tables from a single TOML source.
//   * `api_spec` — host-visible driver API (uca_init, uca_launch_gemm,
//                  uca_read_trace, …); emits C header + Rust FFI.
//
// Roadmap: Phase 5D (Model-to-ISA-API compiler) consumes these specs
// as ground truth for auto-generating model-specific driver code.

pub mod isa_spec;
pub mod api_spec;
pub mod sv_parser;
pub mod block_diagram;

// ─── Unstable plugin API (Phase 1 M1.2) ──────────────────────────────
//
// `IsaCompiler` / `ApiCompiler` let Phase 5D swap codegen backends
// (SV pkg, C header, Rust FFI, DSL interpreter for Sail refinement,
// etc.) without touching the parse/lint core.  Each implementation
// consumes a validated spec and emits the bytes of one target file.
//
// SEMVER NOTE: unstable until pccx-lab v0.3.

/// One output artefact from a compiler run — a named file's bytes.
#[derive(Debug, Clone)]
pub struct CompilerArtefact {
    /// Relative path suggestion (e.g. `hw/rtl/.../isa_pkg.sv`).
    pub path: String,
    /// File contents.
    pub bytes: Vec<u8>,
    /// Human-readable summary the IDE shows next to the output.
    pub summary: String,
}

/// Takes an `IsaSpec` and emits one target file (SV pkg / docs / Rust).
pub trait IsaCompiler {
    fn compile(
        &self,
        spec: &isa_spec::IsaSpec,
    ) -> Result<CompilerArtefact, isa_spec::IsaSpecError>;

    /// Stable backend name (`"sv-pkg"`, `"rst-table"`, `"rust-ffi"`).
    fn target(&self) -> &'static str;
}

/// Takes an `ApiSpec` and emits one target file (C header / Rust FFI /
/// OpenAPI / Python binding).
pub trait ApiCompiler {
    fn compile(
        &self,
        spec: &api_spec::ApiSpec,
    ) -> Result<CompilerArtefact, api_spec::ApiSpecError>;

    /// Stable backend name (`"c-header"`, `"rust-ffi"`, `"openapi"`).
    fn target(&self) -> &'static str;
}
