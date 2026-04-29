// Module Boundary: core/
// pccx-core: API authoring infrastructure — HW → ISA → API.
//
// Companion to `isa_spec`: where the ISA spec describes the bit-level
// instruction encoding, `api_spec` describes the **host-visible driver
// API** (uca_init, uca_launch_gemm, uca_read_trace, …).  The module
// takes a single TOML source of truth and emits:
//
//   * a C header (`.h`) with ``extern "C"`` declarations + ``#ifdef``
//     guards;
//   * a Rust FFI module (``extern "C"`` block + idiomatic wrappers);
//   * a Python ``ctypes`` stub so the pccx-lab UI tests can exercise
//     the driver without a C compiler.
//
// The lint surface catches the class of bugs that drift silently in
// hand-maintained bindings:
//
//   * function-name collisions,
//   * duplicate argument names within a function,
//   * return types / argument types that neither appear in the spec's
//     ``types`` table nor in the built-in C primitive set.
//
// Keeping ISA + API spec adjacent means a single TOML tree owns the
// whole ``HW -> ISA -> API`` flow the Sail knowledge-base guidance
// (knowledge/sail_language/CLAUDE.md §5) calls out.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

// ─── Schema ─────────────────────────────────────────────────────────────────

/// Top-level API spec.  A typical file looks like:
///
/// ```toml
/// name = "pccx-driver"
/// version = "v002.0.0"
/// prefix = "uca_"
///
/// [[types]]
/// name = "uca_handle_t"
/// kind = "opaque"
/// doc  = "Opaque driver handle."
///
/// [[functions]]
/// name = "uca_init"
/// returns = "int"
/// args = [
///   { name = "device_id", ty = "int" },
/// ]
/// doc = "Initialise the pccx NPU device."
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiSpec {
    pub name:      String,
    #[serde(default)]
    pub version:   String,
    /// Common prefix required on every exported function.  Enforced by
    /// the linter — e.g. "uca_" for the pccx driver.
    #[serde(default)]
    pub prefix:    String,
    /// Citation / paper URL — surfaces in the emitted header so LLMs
    /// scraping the generated bindings still find the canonical site.
    #[serde(default)]
    pub citation:  Option<String>,
    /// User-defined types (opaque / struct / enum) — visible to every
    /// generator.
    #[serde(default)]
    pub types:     Vec<TypeSpec>,
    /// Exported functions in declaration order.
    #[serde(default)]
    pub functions: Vec<FunctionSpec>,
    /// Error-code enum — emitted as ``#define UCA_E_* n`` in C and as
    /// a ``#[repr(i32)] enum`` in Rust.
    #[serde(default)]
    pub errors:    Vec<ErrorCode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeSpec {
    pub name: String,
    /// "opaque", "struct", "enum".
    pub kind: String,
    /// For `kind = "struct"` the list of ``{ name, ty }`` fields.
    /// For `kind = "enum"` the list of variants with optional values.
    #[serde(default)]
    pub fields:   Vec<StructField>,
    #[serde(default)]
    pub variants: Vec<EnumVariant>,
    #[serde(default)]
    pub doc:      String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructField {
    pub name: String,
    pub ty:   String,
    #[serde(default)]
    pub doc:  String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnumVariant {
    pub name:  String,
    #[serde(default)]
    pub value: Option<i64>,
    #[serde(default)]
    pub doc:   String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionSpec {
    pub name:    String,
    pub returns: String,
    #[serde(default)]
    pub args:    Vec<ArgSpec>,
    #[serde(default)]
    pub doc:     String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArgSpec {
    pub name: String,
    pub ty:   String,
    #[serde(default)]
    pub doc:  String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorCode {
    pub name:  String,
    pub value: i64,
    #[serde(default)]
    pub doc:   String,
}

// ─── Errors ─────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ApiSpecError {
    #[error("parse error: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Default, Clone)]
pub struct LintReport {
    pub errors:   Vec<String>,
    pub warnings: Vec<String>,
}

impl LintReport {
    pub fn is_clean(&self) -> bool { self.errors.is_empty() }
    pub fn push_err(&mut self, m: impl Into<String>)  { self.errors.push(m.into()); }
    pub fn push_warn(&mut self, m: impl Into<String>) { self.warnings.push(m.into()); }
}

// ─── Built-in C primitive types (recognised by every generator) ─────────────

const C_PRIMITIVES: &[&str] = &[
    "void", "bool",
    "char", "signed char", "unsigned char",
    "short", "int", "long", "long long",
    "unsigned short", "unsigned int", "unsigned long", "unsigned long long",
    "float", "double",
    "int8_t", "int16_t", "int32_t", "int64_t",
    "uint8_t", "uint16_t", "uint32_t", "uint64_t",
    "size_t", "ssize_t", "intptr_t", "uintptr_t",
];

fn is_pointer(ty: &str) -> bool { ty.contains('*') }

/// Strip pointer / const modifiers so the base type name can be
/// looked up in `user_types`.  Doesn't need to handle every C corner
/// case — just the shapes `api_spec` actually emits.
fn base_type(ty: &str) -> &str {
    let mut t = ty.trim();
    while let Some(rest) = t.strip_suffix('*') { t = rest.trim(); }
    if let Some(rest) = t.strip_prefix("const ") { t = rest.trim(); }
    t
}

// ─── Loading ────────────────────────────────────────────────────────────────

impl ApiSpec {
    pub fn from_toml_str(src: &str) -> Result<Self, ApiSpecError> {
        Ok(toml::from_str(src)?)
    }

    pub fn from_toml_file(path: &str) -> Result<Self, ApiSpecError> {
        let src = std::fs::read_to_string(path)?;
        Self::from_toml_str(&src)
    }

    // ── Linter ──────────────────────────────────────────────────────────────

    pub fn lint(&self) -> LintReport {
        let mut r = LintReport::default();
        if self.name.trim().is_empty() { r.push_err("spec.name is empty"); }

        let user_types: BTreeSet<String> = self.types.iter().map(|t| t.name.clone()).collect();

        // Function-name collision + prefix enforcement.
        let mut seen_fn = BTreeSet::new();
        for f in &self.functions {
            if !seen_fn.insert(&f.name) {
                r.push_err(format!("duplicate function name: {}", f.name));
            }
            if !self.prefix.is_empty() && !f.name.starts_with(&self.prefix) {
                r.push_warn(format!("{} does not start with prefix '{}'", f.name, self.prefix));
            }
            // Return type resolution.
            let rb = base_type(&f.returns);
            if !C_PRIMITIVES.contains(&rb) && !user_types.contains(rb) {
                r.push_err(format!("{}: unknown return type '{}'", f.name, f.returns));
            }
            // Arg names + types.
            let mut seen_arg = BTreeSet::new();
            for a in &f.args {
                if !seen_arg.insert(&a.name) {
                    r.push_err(format!("{}: duplicate argument name '{}'", f.name, a.name));
                }
                let ab = base_type(&a.ty);
                if !C_PRIMITIVES.contains(&ab) && !user_types.contains(ab) {
                    r.push_err(format!("{}.{}: unknown argument type '{}'", f.name, a.name, a.ty));
                }
            }
        }

        // Type validation.
        for t in &self.types {
            match t.kind.as_str() {
                "opaque" => {}
                "struct" => {
                    for f in &t.fields {
                        let fb = base_type(&f.ty);
                        if !C_PRIMITIVES.contains(&fb) && !user_types.contains(fb) {
                            r.push_err(format!("{}.{}: unknown field type '{}'",
                                t.name, f.name, f.ty));
                        }
                    }
                }
                "enum" => {
                    if t.variants.is_empty() {
                        r.push_err(format!("{}: enum has no variants", t.name));
                    }
                }
                other => r.push_err(format!("{}: unknown kind '{}'", t.name, other)),
            }
        }

        // Error codes — unique values.
        let mut seen_val = BTreeSet::new();
        for e in &self.errors {
            if !seen_val.insert(e.value) {
                r.push_err(format!("error '{}': duplicate value {}", e.name, e.value));
            }
        }

        r
    }

    // ── C header generator ──────────────────────────────────────────────────

    pub fn gen_c_header(&self) -> String {
        let mut s = String::new();
        let guard = format!("PCCX_{}_H_", self.name.to_uppercase().replace('-', "_"));
        s.push_str(&format!("/* Auto-generated from API spec `{}` ({}).  Do not edit.\n",
            self.name,
            if self.version.is_empty() { "unversioned" } else { &self.version }));
        if let Some(c) = &self.citation {
            s.push_str(&format!(" * Research citation: {}\n", c));
        }
        s.push_str(" * See https://hkimw.github.io/pccx/ for the architecture spec.\n");
        s.push_str(" */\n");
        s.push_str(&format!("#ifndef {}\n#define {}\n\n", guard, guard));
        s.push_str("#include <stdint.h>\n#include <stddef.h>\n#include <stdbool.h>\n\n");
        s.push_str("#ifdef __cplusplus\nextern \"C\" {\n#endif\n\n");

        // Errors.
        if !self.errors.is_empty() {
            s.push_str("/* Error codes */\n");
            for e in &self.errors {
                if !e.doc.is_empty() { s.push_str(&format!("/* {} */\n", e.doc)); }
                s.push_str(&format!("#define {} {}\n", e.name, e.value));
            }
            s.push('\n');
        }

        // Types.
        for t in &self.types {
            if !t.doc.is_empty() { s.push_str(&format!("/* {} */\n", t.doc)); }
            match t.kind.as_str() {
                "opaque" => {
                    s.push_str(&format!("typedef struct {0}_s {0};\n\n", t.name));
                }
                "struct" => {
                    s.push_str(&format!("typedef struct {} {{\n", t.name));
                    for f in &t.fields {
                        if !f.doc.is_empty() { s.push_str(&format!("    /* {} */\n", f.doc)); }
                        s.push_str(&format!("    {} {};\n", f.ty, f.name));
                    }
                    s.push_str(&format!("}} {};\n\n", t.name));
                }
                "enum" => {
                    s.push_str(&format!("typedef enum {} {{\n", t.name));
                    for v in &t.variants {
                        if !v.doc.is_empty() { s.push_str(&format!("    /* {} */\n", v.doc)); }
                        match v.value {
                            Some(val) => s.push_str(&format!("    {} = {},\n", v.name, val)),
                            None      => s.push_str(&format!("    {},\n", v.name)),
                        }
                    }
                    s.push_str(&format!("}} {};\n\n", t.name));
                }
                _ => {}
            }
        }

        // Functions.
        for f in &self.functions {
            if !f.doc.is_empty() {
                s.push_str("/**\n");
                for line in f.doc.lines() {
                    s.push_str(&format!(" * {}\n", line));
                }
                for a in &f.args {
                    if !a.doc.is_empty() {
                        s.push_str(&format!(" * @param {} {}\n", a.name, a.doc));
                    }
                }
                s.push_str(" */\n");
            }
            s.push_str(&format!("{} {}(", f.returns, f.name));
            if f.args.is_empty() {
                s.push_str("void");
            } else {
                let args: Vec<String> = f.args.iter()
                    .map(|a| format!("{} {}", a.ty, a.name)).collect();
                s.push_str(&args.join(", "));
            }
            s.push_str(");\n");
        }

        s.push_str("\n#ifdef __cplusplus\n}\n#endif\n\n");
        s.push_str(&format!("#endif /* {} */\n", guard));
        s
    }

    // ── Rust FFI generator ──────────────────────────────────────────────────

    pub fn gen_rust_ffi(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!("//! Auto-generated from API spec `{}` ({}).  Do not edit.\n",
            self.name,
            if self.version.is_empty() { "unversioned" } else { &self.version }));
        if let Some(c) = &self.citation {
            s.push_str(&format!("//! Research citation: {}\n", c));
        }
        s.push_str("//! See https://hkimw.github.io/pccx/ for the architecture spec.\n");
        s.push_str("#![allow(non_camel_case_types, dead_code)]\n\n");

        for t in &self.types {
            match t.kind.as_str() {
                "opaque" => {
                    s.push_str(&format!("#[repr(C)]\npub struct {} {{ _private: [u8; 0] }}\n\n", t.name));
                }
                "struct" => {
                    s.push_str(&format!("#[repr(C)]\npub struct {} {{\n", t.name));
                    for f in &t.fields {
                        s.push_str(&format!("    pub {}: {},\n", f.name, c_to_rust_ty(&f.ty)));
                    }
                    s.push_str("}\n\n");
                }
                "enum" => {
                    s.push_str(&format!("#[repr(i32)]\n#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub enum {} {{\n", t.name));
                    for v in &t.variants {
                        match v.value {
                            Some(val) => s.push_str(&format!("    {} = {},\n", v.name, val)),
                            None      => s.push_str(&format!("    {},\n", v.name)),
                        }
                    }
                    s.push_str("}\n\n");
                }
                _ => {}
            }
        }

        // extern "C" block with every function.
        s.push_str("extern \"C\" {\n");
        for f in &self.functions {
            if !f.doc.is_empty() {
                for line in f.doc.lines() {
                    s.push_str(&format!("    /// {}\n", line));
                }
            }
            s.push_str(&format!("    pub fn {}(", f.name));
            let args: Vec<String> = f.args.iter()
                .map(|a| format!("{}: {}", a.name, c_to_rust_ty(&a.ty))).collect();
            s.push_str(&args.join(", "));
            s.push_str(&format!(") -> {};\n", c_to_rust_ty(&f.returns)));
        }
        s.push_str("}\n");
        s
    }

    // ── Python ctypes generator ─────────────────────────────────────────────

    pub fn gen_python_ctypes(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!("\"\"\"Auto-generated from API spec `{}` ({}).  Do not edit.\n\n",
            self.name,
            if self.version.is_empty() { "unversioned" } else { &self.version }));
        s.push_str("See https://hkimw.github.io/pccx/ for the architecture spec.\n\"\"\"\n\n");
        s.push_str("from __future__ import annotations\n");
        s.push_str("import ctypes\nfrom ctypes import c_int, c_uint, c_long, c_longlong, c_short\n");
        s.push_str("from ctypes import c_ubyte, c_ushort, c_uint32, c_uint64, c_int32, c_int64\n");
        s.push_str("from ctypes import c_float, c_double, c_size_t, c_void_p, c_char_p, c_bool\n\n");
        s.push_str(&format!("_LIB_NAME = \"{}\"\n", self.name.to_lowercase().replace('-', "_")));
        s.push_str("_lib: ctypes.CDLL | None = None\n\n");
        s.push_str("def _load(path: str | None = None) -> ctypes.CDLL:\n");
        s.push_str("    global _lib\n");
        s.push_str("    if _lib is None:\n");
        s.push_str("        _lib = ctypes.CDLL(path or f\"lib{_LIB_NAME}.so\")\n");
        s.push_str("        _configure(_lib)\n");
        s.push_str("    return _lib\n\n");

        // Error codes → module constants.
        if !self.errors.is_empty() {
            s.push_str("# Error codes\n");
            for e in &self.errors {
                s.push_str(&format!("{}: int = {}\n", e.name, e.value));
            }
            s.push('\n');
        }

        // Opaque types → c_void_p subclass; Struct → ctypes.Structure.
        for t in &self.types {
            match t.kind.as_str() {
                "opaque" => {
                    s.push_str(&format!("class {}(ctypes.Structure): pass  # opaque\n\n", t.name));
                }
                "struct" => {
                    s.push_str(&format!("class {}(ctypes.Structure):\n    _fields_ = [\n", t.name));
                    for f in &t.fields {
                        s.push_str(&format!("        (\"{}\", {}),\n", f.name, c_to_py_ty(&f.ty)));
                    }
                    s.push_str("    ]\n\n");
                }
                "enum" => {
                    s.push_str(&format!("class {}(ctypes.c_int):\n", t.name));
                    s.push_str("    # Values are accessible via the class attributes below.\n");
                    for v in &t.variants {
                        s.push_str(&format!("    {}: int = {}\n", v.name, v.value.unwrap_or(0)));
                    }
                    s.push('\n');
                }
                _ => {}
            }
        }

        s.push_str("def _configure(lib: ctypes.CDLL) -> None:\n");
        if self.functions.is_empty() {
            s.push_str("    return\n");
        }
        for f in &self.functions {
            s.push_str(&format!("    lib.{}.restype  = {}\n", f.name, c_to_py_ty(&f.returns)));
            let argty: Vec<String> = f.args.iter().map(|a| c_to_py_ty(&a.ty)).collect();
            s.push_str(&format!("    lib.{}.argtypes = [{}]\n", f.name, argty.join(", ")));
        }
        s
    }

    // ── Markdown summary (for Sphinx) ───────────────────────────────────────

    pub fn gen_markdown(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!("# API `{}`", self.name));
        if !self.version.is_empty() { s.push_str(&format!(" — {}", self.version)); }
        s.push_str("\n\n");
        if !self.prefix.is_empty() {
            s.push_str(&format!("Symbol prefix: `{}`\n\n", self.prefix));
        }
        if !self.functions.is_empty() {
            s.push_str("## Functions\n\n");
            s.push_str("| name | returns | arguments | doc |\n");
            s.push_str("|---|---|---|---|\n");
            for f in &self.functions {
                let args = f.args.iter()
                    .map(|a| format!("`{} {}`", a.ty, a.name))
                    .collect::<Vec<_>>().join(", ");
                s.push_str(&format!("| **{}** | `{}` | {} | {} |\n",
                    f.name, f.returns, args, f.doc));
            }
        }
        s
    }
}

// ─── Type translation helpers ───────────────────────────────────────────────

fn c_to_rust_ty(c: &str) -> String {
    let c = c.trim();
    // Handle pointer shapes.
    if let Some(inner) = c.strip_suffix('*').map(str::trim) {
        return if inner.starts_with("const ") {
            format!("*const {}", c_to_rust_ty(inner.strip_prefix("const ").unwrap().trim()))
        } else {
            format!("*mut {}", c_to_rust_ty(inner))
        };
    }
    match c {
        "void"     => "()".into(),
        "bool"     => "bool".into(),
        "int"      => "i32".into(),
        "unsigned int" => "u32".into(),
        "long"     => "i64".into(),
        "unsigned long" => "u64".into(),
        "long long"     => "i64".into(),
        "unsigned long long" => "u64".into(),
        "char"     => "i8".into(),
        "unsigned char" => "u8".into(),
        "short"    => "i16".into(),
        "unsigned short" => "u16".into(),
        "float"    => "f32".into(),
        "double"   => "f64".into(),
        "int8_t"   => "i8".into(),
        "int16_t"  => "i16".into(),
        "int32_t"  => "i32".into(),
        "int64_t"  => "i64".into(),
        "uint8_t"  => "u8".into(),
        "uint16_t" => "u16".into(),
        "uint32_t" => "u32".into(),
        "uint64_t" => "u64".into(),
        "size_t"   => "usize".into(),
        "ssize_t"  => "isize".into(),
        other      => other.to_string(),  // user-defined type
    }
}

fn c_to_py_ty(c: &str) -> String {
    let c = c.trim();
    if is_pointer(c) {
        // For opaque struct pointers, use POINTER(<BaseName>) — callers
        // that want the typed variant wrap manually.
        let base = base_type(c);
        return match base {
            "void" | "char" => "c_void_p".into(),
            other => format!("ctypes.POINTER({})", other),
        };
    }
    match c {
        "void"     => "None".into(),
        "bool"     => "c_bool".into(),
        "int"      => "c_int".into(),
        "unsigned int" => "c_uint".into(),
        "long"     => "c_long".into(),
        "unsigned long" => "c_ulong".into(),
        "long long"     => "c_longlong".into(),
        "unsigned long long" => "c_ulonglong".into(),
        "char"     => "c_byte".into(),
        "unsigned char" => "c_ubyte".into(),
        "short"    => "c_short".into(),
        "unsigned short" => "c_ushort".into(),
        "float"    => "c_float".into(),
        "double"   => "c_double".into(),
        "int8_t"   => "ctypes.c_int8".into(),
        "int16_t"  => "ctypes.c_int16".into(),
        "int32_t"  => "c_int32".into(),
        "int64_t"  => "c_int64".into(),
        "uint8_t"  => "ctypes.c_uint8".into(),
        "uint16_t" => "ctypes.c_uint16".into(),
        "uint32_t" => "c_uint32".into(),
        "uint64_t" => "c_uint64".into(),
        "size_t"   => "c_size_t".into(),
        other      => other.to_string(),
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn pccx_driver_sample() -> ApiSpec {
        let src = r#"
            name = "pccx-driver"
            version = "v002.0.0"
            prefix = "uca_"

            [[types]]
            name = "uca_handle_t"
            kind = "opaque"
            doc  = "Opaque driver handle."

            [[types]]
            name = "uca_shape_t"
            kind = "struct"
            doc  = "Tile shape descriptor."
            fields = [
              { name = "m", ty = "uint32_t", doc = "rows" },
              { name = "n", ty = "uint32_t", doc = "cols" },
              { name = "k", ty = "uint32_t", doc = "inner dim" },
            ]

            [[errors]]
            name  = "UCA_E_OK"
            value = 0
            [[errors]]
            name  = "UCA_E_INVAL"
            value = -1
            [[errors]]
            name  = "UCA_E_NOMEM"
            value = -2

            [[functions]]
            name = "uca_init"
            returns = "int"
            doc = "Initialise the pccx NPU device."
            args = [
              { name = "device_id", ty = "int", doc = "0-indexed device id" },
            ]

            [[functions]]
            name = "uca_launch_gemm"
            returns = "int"
            doc = "Launch a GEMM tile on the NPU."
            args = [
              { name = "h",       ty = "uca_handle_t*" },
              { name = "shape",   ty = "const uca_shape_t*" },
              { name = "weights", ty = "const uint8_t*" },
              { name = "fmap",    ty = "const int8_t*" },
              { name = "output",  ty = "int8_t*" },
            ]
        "#;
        ApiSpec::from_toml_str(src).unwrap()
    }

    #[test]
    fn lint_passes_on_well_formed_spec() {
        let s = pccx_driver_sample();
        let r = s.lint();
        assert!(r.is_clean(), "unexpected errors: {:?}", r.errors);
    }

    #[test]
    fn lint_catches_function_collision() {
        let src = r#"
            name = "bad"
            [[functions]]
            name = "uca_x"
            returns = "int"
            [[functions]]
            name = "uca_x"
            returns = "int"
        "#;
        let r = ApiSpec::from_toml_str(src).unwrap().lint();
        assert!(r.errors.iter().any(|e| e.contains("duplicate function name")));
    }

    #[test]
    fn lint_catches_duplicate_args() {
        let src = r#"
            name = "bad"
            [[functions]]
            name = "uca_y"
            returns = "int"
            args = [
              { name = "x", ty = "int" },
              { name = "x", ty = "int" },
            ]
        "#;
        let r = ApiSpec::from_toml_str(src).unwrap().lint();
        assert!(r.errors.iter().any(|e| e.contains("duplicate argument name")));
    }

    #[test]
    fn lint_catches_unknown_type() {
        let src = r#"
            name = "bad"
            [[functions]]
            name = "uca_z"
            returns = "unknown_t"
        "#;
        let r = ApiSpec::from_toml_str(src).unwrap().lint();
        assert!(r.errors.iter().any(|e| e.contains("unknown return type")));
    }

    #[test]
    fn lint_warns_on_prefix_mismatch() {
        let src = r#"
            name = "bad"
            prefix = "uca_"
            [[functions]]
            name = "oops_foo"
            returns = "int"
        "#;
        let r = ApiSpec::from_toml_str(src).unwrap().lint();
        assert!(r.warnings.iter().any(|w| w.contains("does not start with prefix")));
    }

    #[test]
    fn gen_c_header_includes_guard_and_extern_c() {
        let s = pccx_driver_sample();
        let h = s.gen_c_header();
        assert!(h.contains("#ifndef PCCX_PCCX_DRIVER_H_"));
        assert!(h.contains("extern \"C\""));
        assert!(h.contains("int uca_init(int device_id);"));
        assert!(h.contains("typedef struct uca_handle_t_s uca_handle_t;"));
        assert!(h.contains("typedef struct uca_shape_t"));
        assert!(h.contains("#define UCA_E_OK 0"));
    }

    #[test]
    fn gen_rust_ffi_has_extern_c_and_opaque_type() {
        let s = pccx_driver_sample();
        let r = s.gen_rust_ffi();
        assert!(r.contains("extern \"C\" {"));
        assert!(r.contains("pub fn uca_init(device_id: i32) -> i32;"));
        assert!(r.contains("pub struct uca_handle_t { _private: [u8; 0] }"));
        assert!(r.contains("pub struct uca_shape_t"));
        assert!(r.contains("pub m: u32"));
    }

    #[test]
    fn gen_python_ctypes_emits_configure_block() {
        let s = pccx_driver_sample();
        let p = s.gen_python_ctypes();
        assert!(p.contains("def _configure(lib: ctypes.CDLL)"));
        assert!(p.contains("lib.uca_init.restype  = c_int"));
        assert!(p.contains("lib.uca_init.argtypes = [c_int]"));
        assert!(p.contains("UCA_E_OK: int = 0"));
    }

    #[test]
    fn gen_markdown_has_function_table() {
        let s = pccx_driver_sample();
        let m = s.gen_markdown();
        assert!(m.contains("| **uca_init** |"));
        assert!(m.contains("| **uca_launch_gemm** |"));
    }

    #[test]
    fn c_to_rust_ty_handles_pointers() {
        assert_eq!(c_to_rust_ty("int"),              "i32");
        assert_eq!(c_to_rust_ty("uint32_t"),         "u32");
        assert_eq!(c_to_rust_ty("const uint8_t*"),   "*const u8");
        assert_eq!(c_to_rust_ty("int8_t*"),          "*mut i8");
        assert_eq!(c_to_rust_ty("uca_handle_t*"),    "*mut uca_handle_t");
    }
}
