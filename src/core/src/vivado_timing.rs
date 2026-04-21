// Module Boundary: core/
// Xilinx Vivado `report_timing_summary -quiet -no_header` text-output
// parser.  Binds the UG906 "Design Analysis and Closure" section
// headers ("Design Timing Summary", "Clock Summary", "Intra Clock
// Table", "Timing Details") into a structured `TimingReport` that
// the pccx-lab UI's SynthStatusCard consumes in place of the
// regex-rigged stub in `synth_report.rs`.  Round-4 ticket T-2: lifts
// Dim-6 (ASIC signoff readiness) from F to D.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// UG906 "Design Timing Summary" + per-clock breakdown (Intra Clock Table).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TimingReport {
    pub wns_ns:             f32,
    pub tns_ns:             f32,
    pub failing_endpoints:  u32,
    pub clock_domains:      Vec<ClockDomain>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClockDomain {
    pub name:       String,
    pub wns_ns:     f32,
    pub tns_ns:     f32,
    pub period_ns:  f32,
}

/// Single worst-endpoint path from the "Timing Details" section;
/// populated only when a `Slack (VIOLATED)` record exists.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FailingPath {
    pub from:         String,
    pub to:           String,
    pub slack_ns:     f32,
    pub logic_delay:  f32,
}

#[derive(Error, Debug)]
pub enum ParseError {
    #[error("timing report is empty — no parseable text supplied")]
    Empty,
    #[error("Design Timing Summary row not found — malformed report")]
    MissingSummaryRow,
}

/// Section header like `| Clock Summary` — pipe-space then capital letter.
/// Pure-dash underlines (`| -------`) are NOT headers and must not end a block.
fn is_section_header(t: &str) -> bool {
    t.strip_prefix("| ")
        .and_then(|r| r.chars().next())
        .map(|c| c.is_ascii_uppercase())
        .unwrap_or(false)
}

/// Pure `-`-plus-whitespace divider row under a header.
fn is_divider(t: &str) -> bool {
    !t.is_empty() && t.chars().all(|c| c == '-' || c.is_whitespace())
}

/// Parses `report_timing_summary -quiet -no_header` text.  Empty input
/// yields `ParseError::Empty`; a met report returns a `TimingReport`
/// with `wns_ns >= 0` and `failing_endpoints == 0`.
pub fn parse_timing_report(txt: &str) -> Result<TimingReport, ParseError> {
    if txt.trim().is_empty() {
        return Err(ParseError::Empty);
    }
    let (wns, tns, fep) = parse_design_summary(txt).ok_or(ParseError::MissingSummaryRow)?;
    let periods = parse_section(txt, "| Clock Summary", period_row);
    let intras  = parse_section(txt, "| Intra Clock Table", intra_row);
    let clock_domains = intras
        .into_iter()
        .map(|(name, wns, tns)| {
            let period = periods.iter().find(|(n, _)| *n == name).map(|(_, p)| *p).unwrap_or(0.0);
            ClockDomain { name, wns_ns: wns, tns_ns: tns, period_ns: period }
        })
        .collect();
    Ok(TimingReport { wns_ns: wns, tns_ns: tns, failing_endpoints: fep, clock_domains })
}

/// Extracts `(wns, tns, failing)` from the "Design Timing Summary" block.
fn parse_design_summary(txt: &str) -> Option<(f32, f32, u32)> {
    let lines: Vec<&str> = txt.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if !line.trim_start().starts_with("| Design Timing Summary") {
            continue;
        }
        for row in lines.iter().skip(i + 1) {
            let r = row.trim();
            if r.is_empty() || r.starts_with("WNS") || r.starts_with('|') || is_divider(r) {
                continue;
            }
            let cols: Vec<&str> = r.split_whitespace().collect();
            if cols.len() >= 4 {
                return Some((
                    cols[0].parse().ok()?,
                    cols[1].parse().ok()?,
                    cols[2].parse().ok()?,
                ));
            }
            return None;
        }
    }
    None
}

/// Walks `txt` starting at `marker`, feeds each data row to `row_fn`,
/// stops at the next section header.  Divider / header / empty lines
/// are filtered out before `row_fn` runs.
fn parse_section<T, F: Fn(&[&str]) -> Option<T>>(
    txt: &str, marker: &str, row_fn: F,
) -> Vec<T> {
    let mut out = Vec::new();
    let mut in_block = false;
    for line in txt.lines() {
        let t = line.trim();
        if t.starts_with(marker) {
            in_block = true;
            continue;
        }
        if in_block && is_section_header(t) && !t.starts_with(marker) {
            break;
        }
        if !in_block || t.is_empty() || is_divider(t) || t.starts_with("| ") {
            continue;
        }
        // Skip the column-header row (starts with "Clock" or "From").
        if t.starts_with("Clock ") || t.starts_with("From ") {
            continue;
        }
        let cols: Vec<&str> = t.split_whitespace().collect();
        if let Some(v) = row_fn(&cols) {
            out.push(v);
        }
    }
    out
}

/// Clock Summary row: `name {wave_rise wave_fall} period freq`
fn period_row(cols: &[&str]) -> Option<(String, f32)> {
    if cols.len() < 4 { return None; }
    let period_idx = cols.iter().position(|c| c.ends_with('}')).map(|k| k + 1)?;
    let period = cols.get(period_idx)?.parse().ok()?;
    Some((cols[0].to_string(), period))
}

/// Intra Clock Table row: `name wns tns fail_endpoints total ...`
fn intra_row(cols: &[&str]) -> Option<(String, f32, f32)> {
    if cols.len() < 3 { return None; }
    Some((
        cols[0].to_string(),
        cols[1].parse().unwrap_or(0.0),
        cols[2].parse().unwrap_or(0.0),
    ))
}

/// Extracts the first `Slack (VIOLATED)` record.  Returns `None` on met designs.
pub fn parse_worst_endpoint(txt: &str) -> Option<FailingPath> {
    let lines: Vec<&str> = txt.lines().collect();
    let start = lines.iter().position(|l| l.trim_start().starts_with("Slack (VIOLATED)"))?;
    let mut fp = FailingPath::default();
    if let Some(s) = lines[start].split(':').nth(1) {
        fp.slack_ns = s.split("ns").next().and_then(|n| n.trim().parse().ok()).unwrap_or(0.0);
    }
    for l in lines.iter().skip(start + 1).take(20) {
        let t = l.trim();
        if let Some(rest) = t.strip_prefix("Source:") {
            fp.from = rest.trim().to_string();
        } else if let Some(rest) = t.strip_prefix("Destination:") {
            fp.to = rest.trim().to_string();
        } else if let Some(rest) = t.strip_prefix("Data Path Delay:") {
            fp.logic_delay = rest.trim().split("ns").next()
                .and_then(|n| n.trim().parse().ok()).unwrap_or(0.0);
        }
    }
    Some(fp)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KV260_FIXTURE: &str = include_str!("../../../hw/sim/reports/kv260_timing_post_impl.rpt");

    #[test]
    fn parse_empty_is_met() {
        assert!(matches!(parse_timing_report(""), Err(ParseError::Empty)));
        let met = "\n\
            | Design Timing Summary\n\
            | ---------------------\n\
            \n\
            WNS(ns)  TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints\n\
            -------  -------  ---------------------  -------------------\n\
              0.412    0.000                      0                34218\n";
        let r = parse_timing_report(met).expect("met report parses");
        assert_eq!(r.failing_endpoints, 0);
        assert!(r.wns_ns > 0.0);
    }

    #[test]
    fn parse_kv260_report() {
        let r = parse_timing_report(KV260_FIXTURE).expect("KV260 fixture parses");
        assert!(r.wns_ns < 0.0, "v002 KV260 WNS is negative");
        assert!(r.tns_ns < 0.0);
        assert!(r.failing_endpoints > 0);
        assert_eq!(r.clock_domains.len(), 2, "core_clk + axi_clk");
        let core = r.clock_domains.iter().find(|c| c.name == "core_clk").unwrap();
        assert!((core.period_ns - 4.0).abs() < 0.01);
        assert!(core.wns_ns < 0.0);
        let axi = r.clock_domains.iter().find(|c| c.name == "axi_clk").unwrap();
        assert!((axi.period_ns - 10.0).abs() < 0.01);
    }

    #[test]
    fn parse_worst_endpoint() {
        let fp = super::parse_worst_endpoint(KV260_FIXTURE).expect("fixture has VIOLATED record");
        assert!(fp.slack_ns < 0.0);
        assert!(fp.from.contains("u_gemm_systolic"));
        assert!(fp.to.contains("u_normalizer"));
        assert!(fp.logic_delay > 0.0);
    }

    #[test]
    fn parse_multi_clock() {
        let r = parse_timing_report(KV260_FIXTURE).unwrap();
        let core = r.clock_domains.iter().find(|c| c.name == "core_clk").unwrap();
        let axi  = r.clock_domains.iter().find(|c| c.name == "axi_clk").unwrap();
        // 250 MHz core_clk must be tighter than 100 MHz axi_clk.
        assert!(core.period_ns < axi.period_ns);
    }
}
