// Module Boundary: core/
// Bottleneck interval detector — walks the NpuTrace events, buckets them
// into fixed-width windows, and reports windows where any single
// event class (DMA-read stalls, systolic stalls, barrier stalls) owns
// more than a configurable fraction of the window.
//
// The goal is to surface "this is where the array starves" hotspots
// for the UI's Timeline / Flamegraph overlays without requiring full
// VCD parsing.

use crate::trace::{event_type_id, NpuTrace};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BottleneckKind {
    DmaRead,
    DmaWrite,
    SystolicStall,
    BarrierSync,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BottleneckInterval {
    pub kind:       BottleneckKind,
    pub start_cycle: u64,
    pub end_cycle:   u64,
    /// Share of the window dominated by this event kind, in [0.0, 1.0].
    pub share:       f64,
    pub event_count: u64,
}

pub struct DetectorConfig {
    /// Size of each analysis window in cycles.
    pub window_cycles: u64,
    /// Minimum share (in [0.0, 1.0]) of a window an event kind must
    /// occupy before the window is reported as a bottleneck.
    pub threshold:     f64,
}

impl Default for DetectorConfig {
    fn default() -> Self {
        Self { window_cycles: 256, threshold: 0.5 }
    }
}

/// Walks `trace.events` with a sliding window and emits one
/// `BottleneckInterval` per window where a single stall/DMA class
/// exceeds `config.threshold`.
pub fn detect(trace: &NpuTrace, config: &DetectorConfig) -> Vec<BottleneckInterval> {
    if trace.total_cycles == 0 || config.window_cycles == 0 {
        return Vec::new();
    }

    let n_windows = ((trace.total_cycles + config.window_cycles - 1) / config.window_cycles) as usize;
    // Per-window occupancy per class. `[window][kind] => cycles`.
    let mut occ: Vec<[u64; 4]> = vec![[0; 4]; n_windows];

    for ev in &trace.events {
        let kind_idx = match ev.type_id() {
            id if id == event_type_id::DMA_READ       => Some(0),
            id if id == event_type_id::DMA_WRITE      => Some(1),
            id if id == event_type_id::SYSTOLIC_STALL => Some(2),
            id if id == event_type_id::BARRIER_SYNC   => Some(3),
            _ => None,
        };
        if let Some(ki) = kind_idx {
            // Distribute the event's duration across every window it crosses.
            let start = ev.start_cycle;
            let end   = ev.start_cycle.saturating_add(ev.duration);
            let start_win = (start / config.window_cycles) as usize;
            let end_win   = (end.saturating_sub(1) / config.window_cycles) as usize;
            for w in start_win..=end_win.min(n_windows.saturating_sub(1)) {
                let win_start = (w as u64) * config.window_cycles;
                let win_end   = win_start + config.window_cycles;
                let lo = start.max(win_start);
                let hi = end.min(win_end);
                if hi > lo {
                    occ[w][ki] += hi - lo;
                }
            }
        }
    }

    let mut out = Vec::new();
    for (w_idx, per_kind) in occ.iter().enumerate() {
        let win_start = (w_idx as u64) * config.window_cycles;
        let win_end   = (win_start + config.window_cycles).min(trace.total_cycles);
        if win_end <= win_start {
            continue;
        }
        let span = (win_end - win_start) as f64;
        for (ki, cycles) in per_kind.iter().enumerate() {
            let share = *cycles as f64 / span;
            if share >= config.threshold {
                out.push(BottleneckInterval {
                    kind: [
                        BottleneckKind::DmaRead,
                        BottleneckKind::DmaWrite,
                        BottleneckKind::SystolicStall,
                        BottleneckKind::BarrierSync,
                    ][ki],
                    start_cycle: win_start,
                    end_cycle:   win_end,
                    share,
                    event_count: trace.events.iter().filter(|e| {
                        e.type_id() == match ki {
                            0 => event_type_id::DMA_READ,
                            1 => event_type_id::DMA_WRITE,
                            2 => event_type_id::SYSTOLIC_STALL,
                            _ => event_type_id::BARRIER_SYNC,
                        } && e.start_cycle < win_end && e.start_cycle + e.duration > win_start
                    }).count() as u64,
                });
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::NpuEvent;

    fn mk_ev(t: &str, start: u64, dur: u64) -> NpuEvent {
        NpuEvent {
            core_id: 0,
            start_cycle: start,
            duration: dur,
            event_type: t.to_string(),
        }
    }

    #[test]
    fn test_empty_trace_returns_nothing() {
        let trace = NpuTrace { total_cycles: 0, events: vec![] };
        let out = detect(&trace, &DetectorConfig::default());
        assert!(out.is_empty());
    }

    #[test]
    fn test_dma_read_bottleneck_surfaces() {
        // Window 0 (0..256) is dominated by DMA_READ (200 out of 256 cycles).
        let trace = NpuTrace {
            total_cycles: 512,
            events: vec![
                mk_ev("DMA_READ",    0, 200),
                mk_ev("MAC_COMPUTE", 256, 200),
            ],
        };
        let cfg = DetectorConfig { window_cycles: 256, threshold: 0.5 };
        let out = detect(&trace, &cfg);
        assert_eq!(out.len(), 1, "expected one bottleneck window, got {out:?}");
        let b = &out[0];
        assert_eq!(b.kind, BottleneckKind::DmaRead);
        assert_eq!(b.start_cycle, 0);
        assert_eq!(b.end_cycle,   256);
        assert!(b.share >= 0.75, "{}", b.share);
    }

    #[test]
    fn test_below_threshold_is_ignored() {
        let trace = NpuTrace {
            total_cycles: 256,
            events: vec![mk_ev("DMA_READ", 0, 100)], // 39% of window
        };
        let cfg = DetectorConfig { window_cycles: 256, threshold: 0.5 };
        let out = detect(&trace, &cfg);
        assert!(out.is_empty());
    }

    #[test]
    fn test_cross_window_event_split_across_windows() {
        // A long systolic stall spanning two windows should be detected
        // in each window it dominates.
        let trace = NpuTrace {
            total_cycles: 512,
            events: vec![mk_ev("SYSTOLIC_STALL", 100, 300)], // 100..400
        };
        let cfg = DetectorConfig { window_cycles: 256, threshold: 0.5 };
        let out = detect(&trace, &cfg);
        // Window 0 has 156/256 = 61% stall, window 1 has 144/256 = 56% stall.
        assert_eq!(out.len(), 2, "expected stall to surface in both windows: {out:?}");
        for b in &out {
            assert_eq!(b.kind, BottleneckKind::SystolicStall);
        }
    }
}
