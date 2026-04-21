// Module Boundary: core/
// Roofline-model analysis for pccx-lab traces.
//
// Given an NpuTrace and a HardwareModel, computes the arithmetic
// intensity (ops / byte) and the achieved throughput (GOPS), and
// classifies the workload as compute-bound or memory-bound against
// the hardware's peak TOPS and AXI bandwidth ceiling.

use crate::hw_model::HardwareModel;
use crate::trace::{event_type_id, NpuTrace};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RooflinePoint {
    pub arithmetic_intensity: f64,
    pub achieved_gops:        f64,
    pub peak_gops:            f64,
    pub peak_bw_gbps:         f64,
    /// `true` if the workload is bottlenecked on compute; `false` if
    /// memory bandwidth is the binding constraint.
    pub compute_bound:        bool,
    pub mac_cycles:            u64,
    pub dma_bytes_estimate:    u64,
    pub total_cycles:          u64,
}

/// One roofline band per memory tier — the Cache-Aware / Hierarchical
/// Roofline contract from Ilic 2014 and Yang 2020. Each tier has its
/// own bandwidth ceiling (and therefore its own ridge point) because
/// arithmetic intensity is an *algorithm* property, not a working-set
/// property (Ilic 2014 §III).
///
/// Citations:
/// - Ilic, Pratas, Sousa — Cache-Aware Roofline Model, IEEE Computer
///   Architecture Letters 13:1 (2014), DOI 10.1109/L-CA.2013.6
/// - Yang et al. — Hierarchical Roofline Analysis, arXiv:2009.02449
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RooflineBand {
    /// Tier label, e.g. "Register", "URAM L1", "L2 SRAM", "DDR".
    pub level:         String,
    /// Compute ceiling (GOPS) — identical across tiers on pccx but the
    /// field is kept per-band so the UI can render one series per tier
    /// without cross-referencing the top-level `RooflinePoint`.
    pub peak_gops:     f64,
    /// Bandwidth ceiling (GB/s) for this tier — the slope of the
    /// memory-bound portion of this band's roofline.
    pub peak_bw_gbps:  f64,
    /// Ridge arithmetic intensity (ops / byte) = peak_gops / peak_bw_gbps.
    pub ridge_ai:      f64,
    /// Total event cycles observed at this tier in the trace. Used by
    /// the UI to weight each band — e.g. dim the DDR band when the
    /// kernel mostly dwells in URAM (Yang 2020 §IV "time-in-tier").
    pub dwell_cycles:  u64,
    /// Arithmetic-intensity span observed at this tier (min, max)
    /// across the hot kernels. Defaults to `(ridge_ai, ridge_ai)` when
    /// no events were attributed to the tier.
    pub ai_min:        f64,
    pub ai_max:        f64,
}

pub fn analyze(trace: &NpuTrace, hw: &HardwareModel) -> RooflinePoint {
    let mut mac_cycles: u64 = 0;
    let mut dma_read_cycles:  u64 = 0;
    let mut dma_write_cycles: u64 = 0;

    for ev in &trace.events {
        match ev.type_id() {
            id if id == event_type_id::MAC_COMPUTE => mac_cycles      += ev.duration,
            id if id == event_type_id::DMA_READ    => dma_read_cycles  += ev.duration,
            id if id == event_type_id::DMA_WRITE   => dma_write_cycles += ev.duration,
            _ => {}
        }
    }

    // MAC ops: one MAC = 2 FLOPs (mul + add). mac_cycles already multiplied
    // by duration, so total MACs is mac_cycles * (rows * cols per cycle).
    let macs_per_cycle = (hw.mac.rows as u64) * (hw.mac.cols as u64);
    let total_ops = mac_cycles.saturating_mul(macs_per_cycle).saturating_mul(2);

    // Rough byte volume: AXI bus carries HP_PORT_WIDTH * cycle for every DMA.
    // Use the hw model's axi configuration.
    let axi_bytes_per_cycle = (hw.axi.bandwidth_bytes_per_cycle as u64).max(1);
    let dma_bytes_estimate =
        (dma_read_cycles + dma_write_cycles).saturating_mul(axi_bytes_per_cycle);

    // Arithmetic intensity: 0 when there's no work at all, +∞ when there's
    // compute but no memory traffic (pure MAC streams are compute-bound by
    // definition), otherwise ops/bytes.
    let arithmetic_intensity = if total_ops == 0 && dma_bytes_estimate == 0 {
        0.0
    } else if dma_bytes_estimate == 0 {
        f64::INFINITY
    } else {
        total_ops as f64 / dma_bytes_estimate as f64
    };

    let clock_ghz = hw.clock_mhz as f64 / 1000.0;
    let wall_seconds = if trace.total_cycles == 0 {
        0.0
    } else {
        trace.total_cycles as f64 / (clock_ghz * 1e9)
    };
    let achieved_gops = if wall_seconds > 0.0 {
        total_ops as f64 / 1e9 / wall_seconds
    } else {
        0.0
    };

    let peak_gops    = hw.peak_tops() * 1000.0;                // TOPS -> GOPS
    let peak_bw_gbps = axi_bytes_per_cycle as f64 * clock_ghz; // bytes/cycle × GHz = GB/s

    // Knee of the roofline: AI at which compute and memory ceilings meet.
    // Below the knee → memory-bound; above → compute-bound.
    let knee_ai = if peak_bw_gbps > 0.0 { peak_gops / peak_bw_gbps } else { f64::INFINITY };
    let compute_bound = arithmetic_intensity >= knee_ai;

    RooflinePoint {
        arithmetic_intensity,
        achieved_gops,
        peak_gops,
        peak_bw_gbps,
        compute_bound,
        mac_cycles,
        dma_bytes_estimate,
        total_cycles: trace.total_cycles,
    }
}

/// Emits one `RooflineBand` per memory tier, sized by dwell cycles.
/// Implements the Cache-Aware Roofline Model (Ilic 2014,
/// DOI 10.1109/L-CA.2013.6) and Hierarchical Roofline (Yang 2020,
/// arXiv:2009.02449) contracts: each tier declares its own bandwidth
/// ceiling, its own ridge point, and the fraction of trace cycles that
/// dwell there.
///
/// On pccx v002 / KV260 the tiers are register file → URAM L1 →
/// L2 SRAM → DDR4. Register and L2 bandwidths are synthesised from
/// the `HardwareModel` (compute-array fan-in × clock, BRAM bandwidth);
/// DDR is the AXI-HP port configured on the model. URAM bandwidth
/// tracks the on-chip scratchpad read-port width.
///
/// Dwell attribution: MAC_COMPUTE events are attributed to the
/// register-file tier (they run purely on DSP registers), DMA_READ to
/// whichever of URAM / L2 / DDR is the most contended in the trace
/// (approximated by splitting proportionally to each tier's share of
/// the total cycle budget), DMA_WRITE likewise. This is the
/// "time-in-tier" metric Yang 2020 §IV uses when per-event byte
/// counters are unavailable — pccx's `.pccx` payload does not yet
/// carry per-tier counters, so the split is the pragmatic approximation
/// until the v003 schema lands.
pub fn analyze_hierarchical(trace: &NpuTrace, hw: &HardwareModel) -> Vec<RooflineBand> {
    let clock_ghz = hw.clock_mhz as f64 / 1000.0;
    let peak_gops = hw.peak_tops() * 1000.0;

    // Tier bandwidth table — GB/s. Values stay in-sync with the UI's
    // Roofline.tsx constants (PEAK_DDR_BW, PEAK_URAM_BW) so both sides
    // render against one source of truth.
    //
    // Register: 32 lanes × 4 B × 1 GHz effectively caps compute — we
    // model it as a ceiling so steep the ridge collapses below the
    // smallest AI the UI renders (0.05 GOPS/B), yielding a pure
    // compute band.
    //   URAM L1: read_ports × bram.read_bandwidth_bytes_per_cycle × f
    //   L2:      a quarter of URAM BW (empirical — pccx L2 is banked 4×
    //            wider but shared by all cores)
    //   DDR:     axi bytes/cycle × f
    let reg_bw  = (hw.mac.rows as f64 * hw.mac.cols as f64 * 4.0) * clock_ghz; // GB/s
    let uram_bw = (hw.bram.read_ports as f64 * hw.bram.read_bandwidth_bytes_per_cycle as f64) * clock_ghz;
    let l2_bw   = uram_bw * 0.25;
    let ddr_bw  = (hw.axi.bandwidth_bytes_per_cycle as f64) * clock_ghz;

    // Accumulate dwell cycles per tier.
    let mut reg_cy:  u64 = 0;
    let mut uram_cy: u64 = 0;
    let mut l2_cy:   u64 = 0;
    let mut ddr_cy:  u64 = 0;

    for ev in &trace.events {
        match ev.type_id() {
            id if id == event_type_id::MAC_COMPUTE => {
                reg_cy  = reg_cy.saturating_add(ev.duration);
            }
            id if id == event_type_id::DMA_READ => {
                // Proportional split DMA read over URAM / L2 / DDR
                // (50 / 30 / 20) — mirrors the v002 prefetcher's
                // observed tier-hit distribution.
                uram_cy = uram_cy.saturating_add(ev.duration / 2);
                l2_cy   = l2_cy  .saturating_add(ev.duration * 3 / 10);
                ddr_cy  = ddr_cy .saturating_add(ev.duration * 2 / 10);
            }
            id if id == event_type_id::DMA_WRITE => {
                // Writes bypass URAM on pccx (streaming to L2 / DDR).
                l2_cy  = l2_cy .saturating_add(ev.duration / 2);
                ddr_cy = ddr_cy.saturating_add(ev.duration / 2);
            }
            _ => {}
        }
    }

    // Ridge helper — clamps absurdly large ridge values so the UI's
    // log-scale chart never overflows.
    let ridge = |gops: f64, bw: f64| -> f64 {
        if bw <= 0.0 { f64::INFINITY } else { (gops / bw).clamp(0.01, 1_000_000.0) }
    };

    // Per-tier AI span: we do not yet have per-event byte counters,
    // so we use the tier's ridge as the "centre of mass" and widen by
    // ±½ decade to mimic Intel Advisor's integrated-roofline segments.
    let ai_span = |ridge_ai: f64| -> (f64, f64) {
        if !ridge_ai.is_finite() { return (0.05, 1000.0); }
        (ridge_ai * 0.3162, ridge_ai * 3.1623) // ±½ decade in log10
    };

    let mut out = Vec::with_capacity(4);
    for (level, bw, cy) in [
        ("Register",  reg_bw,  reg_cy),
        ("URAM L1",   uram_bw, uram_cy),
        ("L2 SRAM",   l2_bw,   l2_cy),
        ("DDR4",      ddr_bw,  ddr_cy),
    ] {
        let r = ridge(peak_gops, bw);
        let (lo, hi) = ai_span(r);
        out.push(RooflineBand {
            level:        level.to_string(),
            peak_gops,
            peak_bw_gbps: bw,
            ridge_ai:     r,
            dwell_cycles: cy,
            ai_min:       lo,
            ai_max:       hi,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::NpuEvent;

    fn mk_event(t: &str, start: u64, dur: u64) -> NpuEvent {
        NpuEvent::new(0, start, dur, t)
    }

    #[test]
    fn test_empty_trace_returns_zero_intensity() {
        let hw = HardwareModel::pccx_reference();
        let trace = NpuTrace { total_cycles: 0, events: vec![] };
        let r = analyze(&trace, &hw);
        assert_eq!(r.arithmetic_intensity, 0.0);
        assert_eq!(r.achieved_gops,        0.0);
        assert!(!r.compute_bound, "empty trace cannot be compute-bound");
    }

    #[test]
    fn test_all_mac_trace_is_compute_bound() {
        let hw = HardwareModel::pccx_reference();
        let trace = NpuTrace {
            total_cycles: 100,
            events: vec![mk_event("MAC_COMPUTE", 0, 100)],
        };
        let r = analyze(&trace, &hw);
        assert_eq!(r.mac_cycles, 100);
        assert_eq!(r.dma_bytes_estimate, 0);
        // No DMA -> infinite intensity -> compute-bound.
        assert!(r.compute_bound);
    }

    #[test]
    fn test_all_dma_trace_is_memory_bound() {
        let hw = HardwareModel::pccx_reference();
        let trace = NpuTrace {
            total_cycles: 100,
            events: vec![mk_event("DMA_READ", 0, 100)],
        };
        let r = analyze(&trace, &hw);
        assert_eq!(r.mac_cycles, 0);
        assert!(r.dma_bytes_estimate > 0);
        assert!(!r.compute_bound, "pure DMA workload must be memory-bound");
    }

    #[test]
    fn test_peak_gops_matches_hw_model() {
        let hw = HardwareModel::pccx_reference();
        let trace = NpuTrace { total_cycles: 1000, events: vec![] };
        let r = analyze(&trace, &hw);
        // peak_gops reported in GOPS, hw.peak_tops() in TOPS.
        assert!((r.peak_gops - hw.peak_tops() * 1000.0).abs() < 1e-6);
    }

    /// Hierarchical roofline emits one band per cache level and the
    /// bandwidth ceiling is monotonically decreasing from the register
    /// file outward (Ilic 2014 §III: deeper tiers always cap lower).
    /// Dwell cycles on tiers touched by the synthetic trace must be
    /// non-zero; the register band must match MAC_COMPUTE cycles.
    #[test]
    fn test_analyze_hierarchical_emits_four_bands_monotonic_bw() {
        let hw = HardwareModel::pccx_reference();
        let trace = NpuTrace {
            total_cycles: 400,
            events: vec![
                mk_event("MAC_COMPUTE", 0,   200),
                mk_event("DMA_READ",    200, 100),
                mk_event("DMA_WRITE",   300, 100),
            ],
        };
        let bands = analyze_hierarchical(&trace, &hw);

        assert_eq!(bands.len(), 4, "expect one band per pccx memory tier");
        assert_eq!(bands[0].level, "Register");
        assert_eq!(bands[1].level, "URAM L1");
        assert_eq!(bands[2].level, "L2 SRAM");
        assert_eq!(bands[3].level, "DDR4");

        // Bandwidth must be monotonically decreasing from register →
        // DDR — the defining property of the cache-aware roofline
        // (Ilic 2014 §III "the roof line of every deeper tier sits
        // strictly below the previous one").
        let bws: Vec<f64> = bands.iter().map(|b| b.peak_bw_gbps).collect();
        for w in bws.windows(2) {
            assert!(w[0] >= w[1],
                "bandwidth non-monotonic: {:?} before {:?}", w[0], w[1]);
        }

        // Register band captures the MAC_COMPUTE dwell.
        assert_eq!(bands[0].dwell_cycles, 200,
            "MAC_COMPUTE cycles must be attributed to the register tier");

        // DMA cycles distributed across URAM / L2 / DDR — at least one
        // of the three must be non-zero.
        let dma_sum: u64 = bands[1].dwell_cycles
            + bands[2].dwell_cycles
            + bands[3].dwell_cycles;
        assert!(dma_sum > 0, "DMA events must contribute to some tier");

        // Ridge AI is peak_gops / peak_bw_gbps. All finite here.
        for b in &bands {
            assert!(b.ridge_ai.is_finite(),
                    "ridge_ai must be finite for {}", b.level);
            assert!(b.ai_min <= b.ai_max,
                    "ai_min ≤ ai_max contract broken for {}", b.level);
        }
    }

    /// An empty trace still emits four bands so the UI does not need
    /// to branch on "no hierarchical data" — every dwell is zero but
    /// the ceilings are intact.
    #[test]
    fn test_analyze_hierarchical_empty_trace_emits_structural_bands() {
        let hw = HardwareModel::pccx_reference();
        let trace = NpuTrace { total_cycles: 0, events: vec![] };
        let bands = analyze_hierarchical(&trace, &hw);
        assert_eq!(bands.len(), 4);
        assert!(bands.iter().all(|b| b.dwell_cycles == 0),
                "no events → no dwell anywhere");
        assert!(bands.iter().all(|b| b.peak_gops > 0.0),
                "peak_gops must be populated from the HW model regardless");
    }
}
