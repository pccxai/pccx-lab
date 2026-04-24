// Module Boundary: verification/
// pccx-verification: end-to-end golden-model diff + robust config reader.
//
// Two sub-modules live here:
//   * `golden_diff`    — NVIDIA-report §6.2 end-to-end correctness gate.
//   * `robust_reader`  — 4-level (Strict / Warn / Fix / Lenient) TOML
//                        and JSON robustness policy used by the config
//                        readers in `isa_spec` / `api_spec`.

pub mod golden_diff;
pub mod robust_reader;
