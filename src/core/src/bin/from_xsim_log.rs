/// pccx-from-xsim-log: Convert a Xilinx `xsim` simulation log into a `.pccx`
/// trace the pccx-lab UI can load.
///
/// The parser is intentionally minimal: it scans the `xsim` stdout for the
/// standard self-checking-testbench messages and synthesises an `NpuTrace`
/// whose event stream represents the RTL activity covered by the run.
///
/// Recognised patterns (emitted by the pccx-FPGA testbenches):
///   * `PASS: <N> cycles, ...`                 -> N × MAC_COMPUTE on core 0
///   * `FAIL: <E> mismatches over <N> cycles.` -> N × MAC_COMPUTE + E × SYSTOLIC_STALL
///
/// Usage:
///   pccx-from-xsim-log --log <xsim.log> --output <out.pccx> \
///                      [--core-id <u32>] [--testbench <name>]
use pccx_core::hw_model::HardwareModel;
use pccx_core::pccx_format::{
    fnv1a_64, ArchConfig, PayloadConfig, PccxFile, PccxHeader, TraceConfig, MINOR_VERSION,
};
use pccx_core::trace::{NpuEvent, NpuTrace};
use std::collections::BTreeMap;
use std::env;
use std::fs::{read_to_string, File};

struct Args {
    log: String,
    output: String,
    core_id: u32,
    testbench: String,
}

fn parse_args() -> Args {
    let raw: Vec<String> = env::args().skip(1).collect();
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    let mut i = 0;
    while i < raw.len() {
        let key = raw[i].clone();
        let val = raw.get(i + 1).cloned().unwrap_or_default();
        map.insert(key, val);
        i += 2;
    }
    Args {
        log: map.get("--log").cloned().unwrap_or_else(|| "xsim.log".into()),
        output: map.get("--output").cloned().unwrap_or_else(|| "sim_result.pccx".into()),
        core_id: map
            .get("--core-id")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
        testbench: map
            .get("--testbench")
            .cloned()
            .unwrap_or_else(|| "unspecified".into()),
    }
}

/// Parsed testbench outcome.
#[derive(Debug)]
struct Outcome {
    cycles: u64,
    errors: u64,
    passed: bool,
}

fn parse_log(text: &str) -> anyhow::Result<Outcome> {
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("PASS:") {
            // "PASS: 1024 cycles, ..."
            let cycles = rest
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<u64>().ok())
                .ok_or_else(|| anyhow::anyhow!("could not parse cycles from PASS line"))?;
            return Ok(Outcome { cycles, errors: 0, passed: true });
        }
        if let Some(rest) = trimmed.strip_prefix("FAIL:") {
            // "FAIL: <E> mismatches over <N> cycles."
            let parts: Vec<&str> = rest.split_whitespace().collect();
            let errors = parts
                .first()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            let cycles = parts
                .iter()
                .enumerate()
                .find_map(|(idx, tok)| {
                    if *tok == "over" {
                        parts.get(idx + 1).and_then(|s| s.parse::<u64>().ok())
                    } else {
                        None
                    }
                })
                .unwrap_or(0);
            return Ok(Outcome { cycles, errors, passed: false });
        }
    }
    anyhow::bail!("no PASS/FAIL line found in xsim log")
}

fn build_trace(outcome: &Outcome, core_id: u32) -> NpuTrace {
    let mut events = Vec::with_capacity((outcome.cycles + outcome.errors) as usize);
    for c in 0..outcome.cycles {
        events.push(NpuEvent {
            core_id,
            start_cycle: c,
            duration: 1,
            event_type: "MAC_COMPUTE".into(),
        });
    }
    // Each mismatch in the testbench surfaces as a pipeline stall visualisation.
    for e in 0..outcome.errors {
        events.push(NpuEvent {
            core_id,
            start_cycle: e,
            duration: 1,
            event_type: "SYSTOLIC_STALL".into(),
        });
    }
    NpuTrace {
        total_cycles: outcome.cycles.max(1),
        events,
    }
}

fn main() -> anyhow::Result<()> {
    let args = parse_args();
    let text = read_to_string(&args.log)
        .map_err(|e| anyhow::anyhow!("reading {}: {}", args.log, e))?;

    let outcome = parse_log(&text)?;

    println!("xsim log     : {}", args.log);
    println!("  testbench  : {}", args.testbench);
    println!("  outcome    : {}", if outcome.passed { "PASS" } else { "FAIL" });
    println!("  cycles     : {}", outcome.cycles);
    if !outcome.passed {
        println!("  mismatches : {}", outcome.errors);
    }

    let trace = build_trace(&outcome, args.core_id);
    let payload = trace.to_payload();

    let hw = HardwareModel::pccx_reference();
    let header = PccxHeader {
        pccx_lab_version: format!(
            "xsim-bridge v0.1 ({}: {})",
            args.testbench,
            if outcome.passed { "PASS" } else { "FAIL" }
        ),
        arch: ArchConfig {
            mac_dims: (hw.mac.rows, hw.mac.cols),
            isa_version: "1.1".into(),
            peak_tops: (hw.peak_tops() * 100.0).round() / 100.0,
        },
        trace: TraceConfig {
            cycles: trace.total_cycles,
            cores: 1,
            clock_mhz: hw.clock_mhz,
        },
        payload: PayloadConfig {
            encoding: "bincode".into(),
            byte_length: payload.len() as u64,
            checksum_fnv64: Some(fnv1a_64(&payload)),
        },
        format_minor: MINOR_VERSION,
    };

    let file = PccxFile { header, payload };
    let mut out = File::create(&args.output)?;
    file.write(&mut out)?;

    println!("wrote {}  ({} events)", args.output, trace.events.len());
    Ok(())
}
