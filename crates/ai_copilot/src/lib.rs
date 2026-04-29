// Module Boundary: ai_copilot/
// Depends on: core/ (via pccx-core crate)
//
// pccx-ai-copilot: LLM wrapper and extension registry for pccx-lab.
// Provides context compression and extension catalogue for the Tauri UI.

use serde::{Deserialize, Serialize};

// ─── Extension Registry ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Extension {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Approximate download size in megabytes.
    pub size_mb: u32,
    pub is_installed: bool,
    /// Extension category for display grouping.
    pub category: ExtensionCategory,
    /// Minimum pccx-lab version required.
    pub min_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionCategory {
    LocalLlm,
    HardwareAcceleration,
    CloudBridge,
    AnalysisPlugin,
    ExportPlugin,
}

impl std::fmt::Display for ExtensionCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LocalLlm              => write!(f, "Local LLM"),
            Self::HardwareAcceleration  => write!(f, "Hardware Acceleration"),
            Self::CloudBridge           => write!(f, "Cloud Bridge"),
            Self::AnalysisPlugin        => write!(f, "Analysis Plugin"),
            Self::ExportPlugin          => write!(f, "Export Plugin"),
        }
    }
}

/// Returns the full extension catalogue.
pub fn get_available_extensions() -> Vec<Extension> {
    vec![
        // ─── Local LLMs ──────────────────────────────────────────────────────
        Extension {
            id:           "llama-3-8b-q4".to_string(),
            name:         "Llama 3 (8B) — INT4 Quantised".to_string(),
            description:  "Local offline LLM for trace analysis and UVM generation. No data leaves the machine.".to_string(),
            size_mb:      4800,
            is_installed: false,
            category:     ExtensionCategory::LocalLlm,
            min_version:  "v0.3.0".to_string(),
        },
        Extension {
            id:           "qwen2-7b-q4".to_string(),
            name:         "Qwen2 (7B) — INT4 Quantised".to_string(),
            description:  "Multilingual local LLM with strong code generation. Supports Korean system-prompt.".to_string(),
            size_mb:      4200,
            is_installed: false,
            category:     ExtensionCategory::LocalLlm,
            min_version:  "v0.4.0".to_string(),
        },
        // ─── Hardware Acceleration ────────────────────────────────────────────
        Extension {
            id:           "onnx-cuda-ep".to_string(),
            name:         "ONNX Runtime (CUDA EP)".to_string(),
            description:  "GPU acceleration layer for local model inference via CUDA Execution Provider.".to_string(),
            size_mb:      320,
            is_installed: true,
            category:     ExtensionCategory::HardwareAcceleration,
            min_version:  "v0.2.0".to_string(),
        },
        Extension {
            id:           "vulkan-inference".to_string(),
            name:         "Vulkan Inference Backend".to_string(),
            description:  "Cross-platform GPU inference via Vulkan — works on AMD, Intel, and NVIDIA GPUs.".to_string(),
            size_mb:      85,
            is_installed: false,
            category:     ExtensionCategory::HardwareAcceleration,
            min_version:  "v0.4.0".to_string(),
        },
        // ─── Cloud Bridges ────────────────────────────────────────────────────
        Extension {
            id:           "gemini-cloud-bridge".to_string(),
            name:         "Cloud LLM Bridge".to_string(),
            description:  "Lightweight API bridge to cloud LLM. Requires outbound HTTPS access.".to_string(),
            size_mb:      2,
            is_installed: true,
            category:     ExtensionCategory::CloudBridge,
            min_version:  "v0.1.0".to_string(),
        },
        Extension {
            id:           "claude-cloud-bridge".to_string(),
            name:         "Deep Cloud LLM Bridge".to_string(),
            description:  "API bridge to a managed deep cloud LLM for superior code/SV generation.".to_string(),
            size_mb:      2,
            is_installed: false,
            category:     ExtensionCategory::CloudBridge,
            min_version:  "v0.4.0".to_string(),
        },
        // ─── Analysis Plugins ─────────────────────────────────────────────────
        Extension {
            id:           "roofline-analyzer".to_string(),
            name:         "Roofline Model Analyser".to_string(),
            description:  "Generates compute/memory roofline plots from .pccx traces to identify bottlenecks.".to_string(),
            size_mb:      8,
            is_installed: false,
            category:     ExtensionCategory::AnalysisPlugin,
            min_version:  "v0.4.0".to_string(),
        },
        // ─── Export Plugins ───────────────────────────────────────────────────
        Extension {
            id:           "vcd-exporter".to_string(),
            name:         "VCD Wave Exporter".to_string(),
            description:  "Exports .pccx traces to Value Change Dump (.vcd) format for GTKWave / Verdi.".to_string(),
            size_mb:      3,
            is_installed: false,
            category:     ExtensionCategory::ExportPlugin,
            min_version:  "v0.4.0".to_string(),
        },
        Extension {
            id:           "chrome-trace-exporter".to_string(),
            name:         "Chrome Trace Exporter".to_string(),
            description:  "Converts .pccx events to chrome://tracing JSON for familiar GPU profiler UI.".to_string(),
            size_mb:      1,
            is_installed: false,
            category:     ExtensionCategory::ExportPlugin,
            min_version:  "v0.4.0".to_string(),
        },
    ]
}

// ─── Context Compression ──────────────────────────────────────────────────────

/// Compresses NPU trace statistics into a concise LLM prompt context string.
///
/// The output is designed to be prepended to any user query to give the LLM
/// enough context to reason about the trace without the full event list.
pub fn compress_context(cycles: u64, bottlenecks: usize) -> String {
    let bottleneck_desc = match bottlenecks {
        0 => "No significant DMA bottleneck intervals detected.".to_string(),
        1 => "1 high-occupancy DMA bottleneck interval detected.".to_string(),
        n => format!("{n} high-occupancy DMA bottleneck intervals detected."),
    };

    format!(
        "NPU trace: {cycles} total simulation cycles across a 32×32 systolic MAC array \
        with 32 cores at 1 GHz (est. {est_us:.1} µs wall-time). \
        {bottleneck_desc} \
        AXI bus contention visible during simultaneous multi-core DMA. \
        Peak theoretical: 2.05 TOPS.",
        cycles  = cycles,
        est_us  = cycles as f64 / 1000.0, // 1 GHz → µs
        bottleneck_desc = bottleneck_desc,
    )
}

/// Generates a UVM sequence stub for the given bottleneck mitigation strategy.
///
/// Supported strategies (case-sensitive):
/// * `l2_prefetch`        — stagger DMA reads by AXI tx overhead
/// * `barrier_reduction`  — wavefront barrier instead of global sync
/// * `dma_double_buffer`  — ping-pong compute / DMA across tile boundary
/// * `systolic_pipeline_warmup` — pre-roll the MAC array before first tile
/// * `weight_fifo_preload`      — fill HP weight FIFOs during setup window
/// * anything else                → `generic_opt_seq` placeholder
pub fn generate_uvm_sequence(strategy: &str) -> String {
    let (class_name, body) = match strategy {
        "l2_prefetch" => (
            "l2_prefetch_seq",
            "// Stagger DMA requests by AXI transaction overhead (15 cycles)\n\
             foreach (cores[i]) begin\n\
               start_item(new dma_read_item(base_addr + i * stride, burst_len));\n\
               finish_item();\n\
               repeat(15) @(posedge clk);\n\
             end",
        ),
        "barrier_reduction" => (
            "barrier_reduction_seq",
            "// Use wavefront barrier instead of global sync\n\
             for (int i = 0; i < NUM_CORES; i += WAVEFRONT_WIDTH) begin\n\
               fork foreach_wavefront(i, WAVEFRONT_WIDTH); join_none\n\
             end\n\
             wait fork;",
        ),
        "dma_double_buffer" => (
            "dma_double_buffer_seq",
            "// Ping-pong compute vs DMA across adjacent tile boundaries so\n\
             // the MAC array never starves waiting on the next read.\n\
             int buf = 0;\n\
             foreach (tiles[t]) begin\n\
               fork\n\
                 begin  // DMA: read tile (t+1) into the idle buffer\n\
                   if (t + 1 < tiles.size())\n\
                     issue_dma_read(tile_addr[t+1], burst_len, buf ^ 1);\n\
                 end\n\
                 begin  // Compute: run MACs over tile t from the active buffer\n\
                   run_gemm_tile(buf, tile_m, tile_n, tile_k);\n\
                 end\n\
               join\n\
               buf ^= 1;\n\
             end",
        ),
        "systolic_pipeline_warmup" => (
            "systolic_pipeline_warmup_seq",
            "// Pre-roll the systolic array with dummy zero weights so the\n\
             // pipeline's fill latency is amortised before the first real\n\
             // tile arrives. Drains the MAC stall fraction on cold start.\n\
             for (int r = 0; r < PIPELINE_DEPTH; r++) begin\n\
               start_item(new weight_item('0, '0));\n\
               finish_item();\n\
               @(posedge clk);\n\
             end\n\
             dispatch_first_tile();",
        ),
        "weight_fifo_preload" => (
            "weight_fifo_preload_seq",
            "// While the host is still staging feature maps, use the HP\n\
             // lanes (HP0 upper / HP1 lower for W4A8) to front-load weight\n\
             // FIFOs so GEMM_weight_dispatcher has valid pairs the moment\n\
             // activation fetch completes.\n\
             fork\n\
               preload_fifo(.port(HP0), .chan(UPPER), .n_words(PREFETCH_DEPTH));\n\
               preload_fifo(.port(HP1), .chan(LOWER), .n_words(PREFETCH_DEPTH));\n\
             join",
        ),
        _ => (
            "generic_opt_seq",
            "// TODO: implement optimisation-specific sequence",
        ),
    };

    format!(
        "class {class_name} extends uvm_sequence;\n\
         `uvm_object_utils({class_name})\n\
         \n\
         task body();\n\
           {body}\n\
         endtask\n\
         endclass : {class_name}",
        class_name = class_name,
        body = body,
    )
}

/// Lists every supported UVM strategy. Useful for UI pickers that want to
/// enumerate options without hard-coding the match arms.
pub fn list_uvm_strategies() -> Vec<&'static str> {
    vec![
        "l2_prefetch",
        "barrier_reduction",
        "dma_double_buffer",
        "systolic_pipeline_warmup",
        "weight_fifo_preload",
    ]
}

// ─── Unstable plugin API (Phase 1 M1.2) ──────────────────────────────
//
// Scaffolds for the Phase 2 IntelliSense + Phase 5 agent orchestration
// work.  Today `pccx-ai-copilot` ships only static helpers for the
// Tauri UI; these traits give Phase 2/5 implementations a stable place
// to land without churning the crate interface.
//
// SEMVER NOTE: unstable until pccx-lab v0.3.

/// Compresses long context (chat history, trace summary, doc excerpt)
/// into a token-budgeted snippet suitable for feeding back into an LLM
/// prompt.  Deterministic compressors (head/tail) and learned
/// compressors (LLMLingua-style) both implement this trait.
pub trait ContextCompressor {
    /// Returns a snippet whose token count is <= `target_tokens`
    /// (approximate; implementations decide the tokeniser).
    fn compress(&self, input: &str, target_tokens: usize) -> String;
    fn name(&self) -> &'static str;
}

/// Runs a single subagent task with the given prompt and context,
/// returning the subagent's reply or a propagated error.
/// Used by pccx-ide / pccx-remote to drive log analysis, research,
/// doc drafting patterns in parallel.
pub trait SubagentRunner {
    fn run(&self, task: &str, context: &str) -> anyhow::Result<String>;
    fn name(&self) -> &'static str;
}

#[cfg(test)]
mod uvm_tests {
    use super::*;

    #[test]
    fn test_every_strategy_produces_valid_stub() {
        for s in list_uvm_strategies() {
            let body = generate_uvm_sequence(s);
            assert!(body.starts_with("class "),        "strategy {s}: no class header");
            assert!(body.contains("uvm_object_utils"), "strategy {s}: missing uvm_object_utils");
            assert!(body.contains("task body();"),     "strategy {s}: missing task body()");
            assert!(body.contains("endclass"),         "strategy {s}: missing endclass");
            assert!(!body.contains("generic_opt_seq"), "strategy {s} must produce a real stub");
        }
    }

    #[test]
    fn test_unknown_strategy_falls_back_to_generic() {
        let body = generate_uvm_sequence("totally_fake_strategy");
        assert!(body.contains("generic_opt_seq"));
        assert!(body.contains("TODO"));
    }

    #[test]
    fn test_class_names_distinct() {
        let mut seen = std::collections::HashSet::new();
        for s in list_uvm_strategies() {
            let body = generate_uvm_sequence(s);
            let first_line = body.lines().next().unwrap();
            assert!(seen.insert(first_line.to_string()),
                "duplicate class header: {first_line}");
        }
    }
}
