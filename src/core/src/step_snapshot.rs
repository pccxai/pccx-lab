// Module Boundary: core/
// Single-cycle register / MAC-array state snapshot — the backbone of
// T-1's "drive every pipeline stage at single-clock resolution" story.
//
// Given a cached `NpuTrace` and a target cycle, this module reduces the
// flat event stream to a `RegisterSnapshot`: which cores are active,
// which event class they are running, how many cycles remain in the
// current span, and a coarse MAC / DMA / stall / barrier count across
// the whole NPU at that exact cycle.
//
// Contract (matches `live_window.rs` empty-on-no-trace convention):
// - Cycles outside `[0, trace.total_cycles]` return a deterministic
//   empty snapshot instead of an error — the UI just renders "idle".
// - When two events on the same core overlap, the later `start_cycle`
//   wins (latest-dispatch) so a retimed re-run of `simulator.rs` stays
//   stable under `step_to_cycle(c)` for every `c`.
// - Zero-duration events are treated as instantaneous pulses that fire
//   only on their exact `start_cycle`; they never project into the
//   next cycle (matches VCD convention — IEEE 1364-2005 §Annex 18).

use serde::{Deserialize, Serialize};

use crate::trace::{NpuTrace, event_type_id};

/// Per-core active-event descriptor at the queried cycle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CoreState {
    pub core_id:          u32,
    /// Canonical event-type id (`event_type_id::*`). `0` = UNKNOWN / idle.
    pub event_type_id:    u32,
    /// Cycle at which the currently-active event began; 0 when idle.
    pub event_start:      u64,
    /// Cycles remaining in the active event (`end - queried_cycle`).
    /// `0` when idle or when the event ended exactly on this cycle.
    pub cycles_remaining: u64,
}

/// Deterministic state-of-the-NPU snapshot at a single clock edge.
/// Emitted by `step_to_cycle` and consumed by the UI's panel cursor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RegisterSnapshot {
    /// The cycle the UI requested. Mirrors the input for round-tripping.
    pub cycle:          u64,
    /// Total cycles in the trace; `0` when no trace is loaded.
    pub total_cycles:   u64,
    /// Per-core active event. Cores with no event return an idle row
    /// (`event_type_id == 0`); ordering is ascending `core_id`.
    pub cores:          Vec<CoreState>,
    /// Count of cores currently executing `MAC_COMPUTE`.
    pub mac_active:     u32,
    /// Count of cores currently executing `DMA_READ` or `DMA_WRITE`.
    pub dma_active:     u32,
    /// Count of cores in `SYSTOLIC_STALL`.
    pub stall_active:   u32,
    /// Count of cores on a `BARRIER_SYNC`.
    pub barrier_active: u32,
    /// Total number of events completed strictly before `cycle`.
    pub events_retired: u32,
}

impl RegisterSnapshot {
    /// Deterministic empty snapshot — emitted when no trace is loaded
    /// or the queried cycle falls outside `[0, total_cycles]`. Matches
    /// the Yuan OSDI 2014 loud-fallback convention `live_window.rs` uses.
    pub fn empty(cycle: u64) -> Self {
        Self {
            cycle,
            total_cycles:   0,
            cores:          Vec::new(),
            mac_active:     0,
            dma_active:     0,
            stall_active:   0,
            barrier_active: 0,
            events_retired: 0,
        }
    }
}

/// Reduces a trace to its per-cycle register state. `cycle == 0`
/// returns a snapshot of the initial configuration; `cycle >=
/// trace.total_cycles` clamps to the final cycle so the UI's "go to
/// cycle N" input never errors on overshoot.
///
/// The loop is O(N) in event count; `live_window.rs` shows this is
/// fine for pccx traces up to ~100k events. When the UI needs
/// per-signal stepping (WaveformViewer `stepEdge`) it uses the JS-side
/// binary search instead, so this helper stays linear.
pub fn step_to_cycle(trace: Option<&NpuTrace>, cycle: u64) -> RegisterSnapshot {
    let Some(trace) = trace else { return RegisterSnapshot::empty(cycle); };
    if trace.events.is_empty() {
        return RegisterSnapshot {
            total_cycles: trace.total_cycles,
            ..RegisterSnapshot::empty(cycle)
        };
    }

    // Clamp to `[0, total_cycles]` — the UI input sanitises negatives
    // but may overshoot the right edge.
    let q = cycle.min(trace.total_cycles);

    // One running entry per core_id — keep the latest start_cycle that
    // still contains `q`. A `Vec<(core_id, CoreState)>` keeps the
    // allocator happy for the typical case of ≤ 32 cores.
    let mut per_core: Vec<CoreState> = Vec::new();
    let mut retired: u32 = 0;
    let mut mac = 0u32;
    let mut dma = 0u32;
    let mut stall = 0u32;
    let mut barrier = 0u32;

    for ev in &trace.events {
        let start = ev.start_cycle;
        let end   = start.saturating_add(ev.duration);
        // Event fully before q → retired.
        if end <= q && ev.duration > 0 {
            retired = retired.saturating_add(1);
            continue;
        }
        // Zero-duration pulse: fires only when start == q.
        if ev.duration == 0 {
            if start != q { continue; }
        } else if start > q || end <= q {
            continue;
        }

        // Replace the existing CoreState if this event started later
        // (latest-dispatch wins on overlap).
        let tid = ev.type_id();
        let entry = CoreState {
            core_id:          ev.core_id,
            event_type_id:    tid,
            event_start:      start,
            cycles_remaining: end.saturating_sub(q),
        };

        if let Some(slot) = per_core.iter_mut().find(|s| s.core_id == ev.core_id) {
            if start >= slot.event_start {
                *slot = entry;
            }
        } else {
            per_core.push(entry);
        }
    }

    // Stable order so UI diffs across consecutive cycles stay cheap.
    per_core.sort_by_key(|s| s.core_id);

    for s in &per_core {
        match s.event_type_id {
            event_type_id::MAC_COMPUTE    => mac     = mac.saturating_add(1),
            event_type_id::DMA_READ |
            event_type_id::DMA_WRITE      => dma     = dma.saturating_add(1),
            event_type_id::SYSTOLIC_STALL => stall   = stall.saturating_add(1),
            event_type_id::BARRIER_SYNC   => barrier = barrier.saturating_add(1),
            _ => {}
        }
    }

    RegisterSnapshot {
        cycle:          q,
        total_cycles:   trace.total_cycles,
        cores:          per_core,
        mac_active:     mac,
        dma_active:     dma,
        stall_active:   stall,
        barrier_active: barrier,
        events_retired: retired,
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::{NpuEvent, NpuTrace};

    fn trace_fixture() -> NpuTrace {
        // Deliberately mixes event classes + core ids so the
        // `step_to_cycle(42)` test hits every counter branch.
        NpuTrace {
            total_cycles: 200,
            events: vec![
                NpuEvent::new(0,  0, 100, "MAC_COMPUTE"),      // active at 42
                NpuEvent::new(1, 20,  50, "DMA_READ"),         // active at 42
                NpuEvent::new(2, 40,  10, "SYSTOLIC_STALL"),   // active at 42 (end=50)
                NpuEvent::new(3, 60,  30, "BARRIER_SYNC"),     // not yet started
                NpuEvent::new(0, 100, 50, "DMA_WRITE"),        // scheduled later on core 0
            ],
        }
    }

    #[test]
    fn empty_trace_returns_empty_snapshot() {
        let snap = step_to_cycle(None, 10);
        assert_eq!(snap, RegisterSnapshot::empty(10));
    }

    #[test]
    fn step_to_cycle_42_is_deterministic() {
        let trace = trace_fixture();
        let a = step_to_cycle(Some(&trace), 42);
        let b = step_to_cycle(Some(&trace), 42);
        assert_eq!(a, b, "snapshot must be deterministic");

        // At cycle 42: cores 0 (MAC), 1 (DMA_READ), 2 (STALL) are active.
        // Core 3 hasn't started; the later core-0 DMA_WRITE is in the future.
        assert_eq!(a.cycle, 42);
        assert_eq!(a.total_cycles, 200);
        assert_eq!(a.cores.len(), 3);
        assert_eq!(a.mac_active,     1);
        assert_eq!(a.dma_active,     1);
        assert_eq!(a.stall_active,   1);
        assert_eq!(a.barrier_active, 0);
        // Core 0 MAC_COMPUTE started at 0, runs 100 cycles → 58 remain.
        let core0 = a.cores.iter().find(|c| c.core_id == 0).unwrap();
        assert_eq!(core0.event_type_id, event_type_id::MAC_COMPUTE);
        assert_eq!(core0.event_start, 0);
        assert_eq!(core0.cycles_remaining, 58);
    }

    #[test]
    fn latest_dispatch_wins_on_same_core_overlap() {
        // Two events on core 7: (0, 200, "MAC") then (100, 50, "DMA_READ").
        // At cycle 120 both overlap — later start_cycle must take precedence.
        let trace = NpuTrace {
            total_cycles: 300,
            events: vec![
                NpuEvent::new(7,   0, 200, "MAC_COMPUTE"),
                NpuEvent::new(7, 100,  50, "DMA_READ"),
            ],
        };
        let snap = step_to_cycle(Some(&trace), 120);
        assert_eq!(snap.cores.len(), 1);
        assert_eq!(snap.cores[0].event_type_id, event_type_id::DMA_READ);
    }

    #[test]
    fn events_retired_counts_fully_past_events() {
        let trace = trace_fixture();
        // At cycle 125: MAC (0–100), DMA_READ (20–70), STALL (40–50),
        // BARRIER (60–90) have all retired — that's 4 events. The
        // core-0 DMA_WRITE (100–150) is still running.
        let snap = step_to_cycle(Some(&trace), 125);
        assert_eq!(snap.events_retired, 4);
        assert_eq!(snap.cores.len(), 1);
        assert_eq!(snap.cores[0].core_id, 0);
        assert_eq!(snap.cores[0].event_type_id, event_type_id::DMA_WRITE);
        // cycle_remaining = 150 - 125 = 25.
        assert_eq!(snap.cores[0].cycles_remaining, 25);
    }

    #[test]
    fn cycle_overshoot_is_clamped() {
        let trace = trace_fixture();
        let snap = step_to_cycle(Some(&trace), 10_000);
        // Clamped to total_cycles=200 → every event has retired.
        assert_eq!(snap.cycle, 200);
        assert_eq!(snap.events_retired, 5);
        assert!(snap.cores.is_empty());
    }

    #[test]
    fn zero_cycle_is_initial_state() {
        let trace = trace_fixture();
        let snap = step_to_cycle(Some(&trace), 0);
        // Only the core-0 MAC event starts at cycle 0 — others begin later.
        assert_eq!(snap.cycle, 0);
        assert_eq!(snap.cores.len(), 1);
        assert_eq!(snap.cores[0].core_id, 0);
        assert_eq!(snap.cores[0].event_type_id, event_type_id::MAC_COMPUTE);
        assert_eq!(snap.cores[0].event_start, 0);
        assert_eq!(snap.cores[0].cycles_remaining, 100);
        assert_eq!(snap.events_retired, 0);
    }
}
