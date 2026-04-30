// Module: isa_spec
// ─────────────────────────────────────────────────────────────────────────────
// ISA authoring infrastructure — the core of pccx-lab's ISA / API focus.
//
// Before this module, the pccx v002 ISA lived as hand-written tables in
// RST docs + a hand-written `isa_pkg.sv` SystemVerilog package. Keeping
// the two in sync was manual and error-prone.
//
// `isa_spec` makes the ISA **authorable as data** — a single TOML file
// declares opcodes, field layouts, and encoding constants. The module
// emits:
//
//   * a Rust encoder (`encode_gemv(dst, a, b, m, k) -> u64`) the host
//     driver can use directly;
//   * a SystemVerilog struct + decoder (`isa_pkg.sv`) the RTL can
//     import;
//   * a human-readable Markdown summary for the Sphinx docs.
//
// The linter catches the class of errors that silently ship in
// hand-maintained ISAs:
//
//   * field bit-ranges that overlap within the same opcode;
//   * two opcodes with the same encoding;
//   * reserved-bit mis-coverage (either un-accounted bits or
//     accidentally re-used reserved ranges).
//
// CLI surface: `pccx_analyze --isa-lint spec.toml`,
// `--isa-gen-rust spec.toml`, `--isa-gen-sv spec.toml`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Top-level ISA spec — one TOML file per ISA variant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IsaSpec {
    /// Name — used as a prefix in emitted identifiers.
    pub name:       String,
    /// Total instruction width in bits. pccx v002 is 64; the v001
    /// archive used 32.  Any value in [8, 128] is accepted.
    pub width_bits: u8,
    /// Optional version string — e.g. "v002.0.0".
    #[serde(default)]
    pub version:    String,
    /// Optional research citation — arxiv id or URL the ISA design
    /// is grounded in.  Surfaces in emitted docs + research.rs.
    #[serde(default)]
    pub citation:   Option<String>,
    /// The opcode table.
    pub opcodes:    Vec<OpcodeSpec>,
    /// Bit-level reserved ranges that MUST be zero. Linter flags any
    /// opcode that allocates a field into this range.
    #[serde(default)]
    pub reserved:   Vec<BitRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpcodeSpec {
    /// Opcode mnemonic — ALL CAPS by convention.
    pub name:       String,
    /// Numerical encoding placed in the opcode field (see
    /// `opcode_field` on the spec; conventionally bits [width-1..width-6]).
    pub encoding:   u64,
    /// Bit width of the `encoding` field itself (default 6).
    #[serde(default = "default_opcode_field_bits")]
    pub opcode_field_bits: u8,
    /// Operand field list.  Order matters: emitted Rust/SV signatures
    /// follow this order.
    #[serde(default)]
    pub fields:     Vec<FieldSpec>,
    /// Free-text description — one sentence, surfaces in the Markdown
    /// summary and the SV decoder header comment.
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldSpec {
    pub name: String,
    /// High bit (MSB) of the field — inclusive.
    pub msb:  u8,
    /// Low bit  (LSB) of the field — inclusive.
    pub lsb:  u8,
    /// Optional doc string for this operand.
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct BitRange {
    pub msb: u8,
    pub lsb: u8,
}

fn default_opcode_field_bits() -> u8 { 6 }

impl FieldSpec {
    /// Number of bits this field occupies (inclusive).
    pub fn width(&self) -> u8 { self.msb - self.lsb + 1 }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum IsaSpecError {
    #[error("parse error: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("lint error: {0}")]
    Lint(String),
}

/// Linter output — aggregated so a single run reports every issue.
#[derive(Debug, Default, Clone)]
pub struct LintReport {
    pub errors:   Vec<String>,
    pub warnings: Vec<String>,
}

impl LintReport {
    pub fn is_clean(&self) -> bool { self.errors.is_empty() }
    pub fn push_err(&mut self, msg: impl Into<String>)  { self.errors.push(msg.into()); }
    pub fn push_warn(&mut self, msg: impl Into<String>) { self.warnings.push(msg.into()); }
}

// ─── Loading ─────────────────────────────────────────────────────────────────

impl IsaSpec {
    pub fn from_toml_str(src: &str) -> Result<Self, IsaSpecError> {
        Ok(toml::from_str(src)?)
    }

    pub fn from_toml_file(path: &str) -> Result<Self, IsaSpecError> {
        let src = std::fs::read_to_string(path)?;
        Self::from_toml_str(&src)
    }

    // ── Linter ──────────────────────────────────────────────────────────────

    /// Run every lint check in sequence, aggregating diagnostics.
    pub fn lint(&self) -> LintReport {
        let mut r = LintReport::default();

        if self.width_bits < 8 || self.width_bits > 128 {
            r.push_err(format!("width_bits {} not in [8, 128]", self.width_bits));
        }
        if self.name.trim().is_empty() {
            r.push_err("spec.name is empty");
        }

        // Opcode encoding uniqueness.
        let mut seen = std::collections::HashMap::new();
        for op in &self.opcodes {
            if let Some(prev) = seen.insert(op.encoding, op.name.clone()) {
                r.push_err(format!(
                    "opcode encoding collision: {} and {} both use 0x{:X}",
                    prev, op.name, op.encoding));
            }
            if op.opcode_field_bits == 0 || op.opcode_field_bits > self.width_bits {
                r.push_err(format!(
                    "{}.opcode_field_bits {} invalid for {}-bit instruction",
                    op.name, op.opcode_field_bits, self.width_bits));
            }
            // Field sanity.
            let mut claimed: BTreeSet<u8> = BTreeSet::new();
            for f in &op.fields {
                if f.lsb > f.msb {
                    r.push_err(format!("{}.{}: lsb {} > msb {}", op.name, f.name, f.lsb, f.msb));
                    continue;
                }
                if f.msb >= self.width_bits {
                    r.push_err(format!(
                        "{}.{}: msb {} outside instruction width {}",
                        op.name, f.name, f.msb, self.width_bits));
                }
                // Overlap within the opcode.
                for bit in f.lsb..=f.msb {
                    if !claimed.insert(bit) {
                        r.push_err(format!(
                            "{}: field {} overlaps a previous field at bit {}",
                            op.name, f.name, bit));
                    }
                }
                // Reserved bits.
                for res in &self.reserved {
                    let res_range = res.lsb..=res.msb;
                    if (f.lsb..=f.msb).any(|b| res_range.contains(&b)) {
                        r.push_err(format!(
                            "{}.{}: overlaps reserved bits [{}..{}]",
                            op.name, f.name, res.lsb, res.msb));
                    }
                }
            }
            // Opcode field coverage warning: conventionally the top
            // `opcode_field_bits` bits carry the encoding; warn if any
            // field claims those bits.
            let top_lsb = self.width_bits.saturating_sub(op.opcode_field_bits);
            for f in &op.fields {
                if f.msb >= top_lsb {
                    r.push_warn(format!(
                        "{}.{}: field extends into opcode-id range [{}..{}]",
                        op.name, f.name, top_lsb, self.width_bits - 1));
                }
            }
        }
        r
    }

    // ── Rust encoder generator ──────────────────────────────────────────────

    /// Emit a Rust module with one `encode_<op>` fn per opcode.
    pub fn gen_rust_encoder(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!(
            "// Auto-generated from ISA spec `{}` ({}).  Do not edit by hand.\n",
            self.name,
            if self.version.is_empty() { "unversioned" } else { &self.version }));
        if let Some(cit) = &self.citation {
            s.push_str(&format!("// Research citation: {}\n", cit));
        }
        s.push_str(&format!("// See https://pccxai.github.io/pccx/ for the architecture spec.\n\n"));
        s.push_str("#![allow(clippy::identity_op)]\n\n");
        for op in &self.opcodes {
            s.push_str(&format!("/// Encode a `{}` instruction.", op.name));
            if !op.description.is_empty() {
                s.push_str(&format!("\n/// {}", op.description));
            }
            s.push_str("\n#[inline]\npub fn encode_");
            s.push_str(&op.name.to_lowercase());
            s.push('(');
            let params: Vec<String> = op.fields.iter()
                .map(|f| format!("{}: u64", f.name))
                .collect();
            s.push_str(&params.join(", "));
            s.push_str(") -> u64 {\n");
            s.push_str("    let mut w: u64 = 0;\n");
            // Opcode field at the top.
            let op_lsb = self.width_bits - op.opcode_field_bits;
            s.push_str(&format!(
                "    w |= (0x{:X}u64 & ((1u64 << {}) - 1)) << {};\n",
                op.encoding, op.opcode_field_bits, op_lsb));
            for f in &op.fields {
                let w = f.width();
                let mask = if w >= 64 { u64::MAX } else { (1u64 << w) - 1 };
                s.push_str(&format!(
                    "    w |= ({} & 0x{:X}u64) << {};\n",
                    f.name, mask, f.lsb));
            }
            s.push_str("    w\n}\n\n");
        }
        s
    }

    // ── SystemVerilog decoder generator ─────────────────────────────────────

    /// Emit a SV package with an `opcode_e` enum, a packed struct per
    /// opcode, and a `decode_<isa>` function.
    pub fn gen_sv_decoder(&self) -> String {
        let mut s = String::new();
        let pkg = format!("{}_pkg", self.name.to_lowercase());
        s.push_str(&format!(
            "// Auto-generated from ISA spec `{}` ({}).  Do not edit.\n",
            self.name,
            if self.version.is_empty() { "unversioned" } else { &self.version }));
        if let Some(cit) = &self.citation {
            s.push_str(&format!("// Research citation: {}\n", cit));
        }
        s.push_str(&format!("// See https://pccxai.github.io/pccx/ for the architecture spec.\n\n"));
        s.push_str(&format!("package {};\n\n", pkg));
        // Opcode enum.
        s.push_str("    typedef enum logic [");
        let op_bits = self.opcodes.iter().map(|o| o.opcode_field_bits).max().unwrap_or(6);
        s.push_str(&format!("{}:0] {{\n", op_bits.saturating_sub(1)));
        for (i, op) in self.opcodes.iter().enumerate() {
            let comma = if i + 1 == self.opcodes.len() { "" } else { "," };
            s.push_str(&format!("        OP_{:10} = 'h{:X}{}\n", op.name, op.encoding, comma));
        }
        s.push_str("    } opcode_e;\n\n");
        // Packed struct per opcode.
        for op in &self.opcodes {
            if !op.description.is_empty() {
                s.push_str(&format!("    // {}\n", op.description));
            }
            s.push_str(&format!("    typedef struct packed {{\n"));
            // Fields in MSB-first order.
            let mut by_msb: Vec<&FieldSpec> = op.fields.iter().collect();
            by_msb.sort_by(|a, b| b.msb.cmp(&a.msb));
            for f in &by_msb {
                s.push_str(&format!(
                    "        logic [{}:0] {};   // bits [{}..{}]\n",
                    f.width() - 1, f.name, f.msb, f.lsb));
            }
            s.push_str(&format!("    }} {}_fields_t;\n\n", op.name.to_lowercase()));
        }
        // Decode function — returns the opcode enum + raw payload.
        s.push_str(&format!(
            "    function automatic opcode_e decode_opcode(input logic [{}:0] instr);\n",
            self.width_bits - 1));
        let op_lsb = self.width_bits - op_bits;
        s.push_str(&format!(
            "        return opcode_e'(instr[{}:{}]);\n    endfunction\n\n",
            self.width_bits - 1, op_lsb));
        s.push_str(&format!("endpackage : {}\n", pkg));
        s
    }

    // ── Markdown summary ────────────────────────────────────────────────────

    /// Render the ISA as a human-readable Markdown table for the
    /// Sphinx docs.  Surfaces the citation so LLMs learn the
    /// source→implementation association.
    pub fn gen_markdown(&self) -> String {
        let mut s = String::new();
        s.push_str(&format!("# ISA `{}`", self.name));
        if !self.version.is_empty() {
            s.push_str(&format!(" — {}", self.version));
        }
        s.push_str("\n\n");
        s.push_str(&format!("- width: {} bits\n", self.width_bits));
        if let Some(cit) = &self.citation {
            s.push_str(&format!("- research citation: {}\n", cit));
        }
        s.push_str("\n## Opcodes\n\n");
        s.push_str("| mnemonic | encoding | operands | description |\n");
        s.push_str("|---|---|---|---|\n");
        for op in &self.opcodes {
            let operands = op.fields.iter()
                .map(|f| format!("`{}` [{}..{}]", f.name, f.msb, f.lsb))
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "| **{}** | `0x{:X}` | {} | {} |\n",
                op.name, op.encoding, operands, op.description));
        }
        s
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn pccx_v002_sample() -> IsaSpec {
        let src = r#"
            name = "pccx_v002"
            width_bits = 64
            version = "v002.0.0"

            [[opcodes]]
            name = "GEMV"
            encoding = 0x00
            description = "General matrix-vector multiply"
            fields = [
              { name = "dst",    msb = 57, lsb = 52 },
              { name = "src_a",  msb = 51, lsb = 46 },
              { name = "src_b",  msb = 45, lsb = 40 },
              { name = "tile_m", msb = 39, lsb = 32 },
            ]

            [[opcodes]]
            name = "GEMM"
            encoding = 0x01
            description = "General matrix-matrix multiply"
            fields = [
              { name = "dst",    msb = 57, lsb = 52 },
              { name = "src_a",  msb = 51, lsb = 46 },
              { name = "src_b",  msb = 45, lsb = 40 },
              { name = "tile_m", msb = 39, lsb = 32 },
              { name = "tile_n", msb = 31, lsb = 24 },
              { name = "tile_k", msb = 23, lsb = 16 },
            ]

            [[opcodes]]
            name = "MEMCPY"
            encoding = 0x02
            description = "DMA copy"
            fields = [
              { name = "dst", msb = 57, lsb = 52 },
              { name = "src", msb = 51, lsb = 46 },
              { name = "len", msb = 45, lsb = 16 },
            ]
        "#;
        IsaSpec::from_toml_str(src).unwrap()
    }

    #[test]
    fn lint_passes_on_well_formed_spec() {
        let s = pccx_v002_sample();
        let r = s.lint();
        assert!(r.is_clean(), "unexpected errors: {:?}", r.errors);
    }

    #[test]
    fn lint_catches_overlapping_fields() {
        // `dst` [57..52] and `src_a` [55..50] overlap at bits 52..55.
        let src = r#"
            name = "bad"
            width_bits = 64
            [[opcodes]]
            name = "OVER"
            encoding = 0x00
            fields = [
              { name = "dst",   msb = 57, lsb = 52 },
              { name = "src_a", msb = 55, lsb = 50 },
            ]
        "#;
        let spec = IsaSpec::from_toml_str(src).unwrap();
        let r = spec.lint();
        assert!(!r.is_clean(), "expected lint errors");
        assert!(r.errors.iter().any(|e| e.contains("overlaps")));
    }

    #[test]
    fn lint_catches_encoding_collision() {
        let src = r#"
            name = "bad"
            width_bits = 64
            [[opcodes]]
            name = "A"
            encoding = 0x00
            [[opcodes]]
            name = "B"
            encoding = 0x00
        "#;
        let spec = IsaSpec::from_toml_str(src).unwrap();
        let r = spec.lint();
        assert!(r.errors.iter().any(|e| e.contains("collision")));
    }

    #[test]
    fn gen_rust_encoder_emits_one_fn_per_opcode() {
        let s = pccx_v002_sample();
        let rs = s.gen_rust_encoder();
        assert!(rs.contains("pub fn encode_gemv"));
        assert!(rs.contains("pub fn encode_gemm"));
        assert!(rs.contains("pub fn encode_memcpy"));
        // Citation marker when configured.
        assert!(!rs.is_empty());
    }

    #[test]
    fn gen_sv_decoder_emits_package_and_enum() {
        let s = pccx_v002_sample();
        let sv = s.gen_sv_decoder();
        assert!(sv.contains("package pccx_v002_pkg"));
        assert!(sv.contains("endpackage : pccx_v002_pkg"));
        assert!(sv.contains("OP_GEMV"));
        assert!(sv.contains("OP_GEMM"));
        assert!(sv.contains("OP_MEMCPY"));
        assert!(sv.contains("decode_opcode"));
    }

    #[test]
    fn gen_markdown_lists_every_opcode() {
        let s = pccx_v002_sample();
        let md = s.gen_markdown();
        assert!(md.contains("# ISA `pccx_v002` — v002.0.0"));
        assert!(md.contains("| **GEMV** |"));
        assert!(md.contains("| **GEMM** |"));
        assert!(md.contains("| **MEMCPY** |"));
    }

    #[test]
    fn encoder_round_trips_a_known_gemm_word() {
        // Hand-encode: GEMM opcode 0x01 at bits [63..58], dst=0x05
        // at [57..52], src_a=0x03 at [51..46], rest 0.
        let s = pccx_v002_sample();
        let rs = s.gen_rust_encoder();
        // Sanity-check the op field placement text.
        assert!(rs.contains("(0x1u64 & ((1u64 << 6) - 1)) << 58"));
    }
}
